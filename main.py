"""
whisper-remote — real-time bilingual subtitle server

Usage:
    python main.py [--model large-v3] [--port 8000]

REST API:
    GET  /api/health
    GET  /api/devices
    POST /api/sessions                     {"name": "..."}
    GET  /api/sessions
    GET  /api/sessions/{id}
    DELETE /api/sessions/{id}
    POST /api/sessions/{id}/upload         multipart file
    GET  /api/sessions/{id}/export/{fmt}   fmt = srt | txt | json
    POST /api/sources/mic/start            {"session_id": "...", "device": null}
    POST /api/sources/mic/stop
    POST /api/sources/system/start         {"session_id": "..."}
    POST /api/sources/system/stop

WebSocket:
    WS /ws/audio/{session_id}   — stream PCM Float32 mono 16 kHz from browser
    WS /ws/subtitles            — subscribe to subtitle events (all sessions)
"""
import argparse
import asyncio
import io
import logging
import os
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import (
    FastAPI,
    HTTPException,
    UploadFile,
    File,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import config
from core.asr import ASREngine
from core.translator import Translator
from core.session import SessionManager
from core.pipeline import AudioPipeline
from audio.sources import MicSource, SystemAudioSource, FileSource, list_input_devices

# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Global singletons (loaded once on startup)
# ------------------------------------------------------------------
_asr: ASREngine
_translator: Translator
_sessions: SessionManager

# Active pipelines: session_id → AudioPipeline
_pipelines: dict[str, AudioPipeline] = {}

# Active audio sources keyed by type
_mic_source: Optional[MicSource] = None
_system_source: Optional[SystemAudioSource] = None

# WebSocket subscribers for subtitle broadcasts
_subtitle_subscribers: set[WebSocket] = set()


# ------------------------------------------------------------------
# Lifespan: load models on startup
# ------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _asr, _translator, _sessions
    loop = asyncio.get_event_loop()

    logger.info("Loading models (this may take a minute)…")
    _asr = await loop.run_in_executor(
        None,
        lambda: ASREngine(config.whisper_model, config.device, config.compute_type),
    )
    _translator = await loop.run_in_executor(
        None,
        lambda: Translator(config.en_zh_model, config.translation_device),
    )
    _sessions = SessionManager(config.sessions_dir)
    logger.info("Models ready. Server is up.")
    yield
    # Shutdown: stop all active sources
    for p in _pipelines.values():
        p.stop()
    if _mic_source:
        _mic_source.stop()
    if _system_source:
        _system_source.stop()


app = FastAPI(title="whisper-remote", lifespan=lifespan)

# Static files
_frontend_dir = Path(__file__).parent / "frontend"
app.mount("/static", StaticFiles(directory=str(_frontend_dir / "static")), name="static")


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _get_or_create_pipeline(session_id: str) -> AudioPipeline:
    if session_id not in _pipelines:
        loop = asyncio.get_event_loop()
        _pipelines[session_id] = AudioPipeline(
            session_id=session_id,
            asr=_asr,
            translator=_translator,
            session_manager=_sessions,
            on_subtitle=lambda sub: _broadcast_subtitle_sync(sub, loop),
            loop=loop,
            interim_interval_s=config.interim_interval_s,
            sentence_gap_s=config.sentence_gap_s,
        )
    return _pipelines[session_id]


def _broadcast_subtitle_sync(subtitle: dict, loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(_broadcast_subtitle(subtitle), loop)


async def _broadcast_subtitle(subtitle: dict) -> None:
    await _broadcast({"type": "subtitle", "data": subtitle})


async def _broadcast(msg: dict) -> None:
    dead = set()
    for ws in _subtitle_subscribers:
        try:
            await ws.send_json(msg)
        except Exception:
            dead.add(ws)
    _subtitle_subscribers -= dead


def _broadcast_sync(msg: dict, loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(_broadcast(msg), loop)


# ------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    return FileResponse(str(_frontend_dir / "index.html"))


@app.get("/subtitle", response_class=HTMLResponse)
async def subtitle_page():
    return FileResponse(str(_frontend_dir / "subtitle.html"))


# ------------------------------------------------------------------
# REST API
# ------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "model": config.whisper_model, "time": time.time()}


# --- Runtime settings ---

class SettingsRequest(BaseModel):
    sentence_gap_s: Optional[float] = None


@app.get("/api/settings")
async def get_settings():
    return {"sentence_gap_s": config.sentence_gap_s}


@app.post("/api/settings")
async def update_settings(req: SettingsRequest):
    if req.sentence_gap_s is not None:
        val = max(0.0, min(10.0, req.sentence_gap_s))
        config.sentence_gap_s = val
        for p in _pipelines.values():
            p.sentence_gap_s = val
        logger.info(f"sentence_gap_s updated to {val:.1f}s")
    return {"sentence_gap_s": config.sentence_gap_s}


@app.get("/api/devices")
async def devices():
    return list_input_devices()


# --- Sessions ---

class CreateSessionRequest(BaseModel):
    name: str = ""


@app.post("/api/sessions", status_code=201)
async def create_session(req: CreateSessionRequest):
    session = _sessions.create(req.name)
    return {"id": session.id, "name": session.name}


@app.get("/api/sessions")
async def list_sessions():
    return _sessions.list_all()


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "id": session.id,
        "name": session.name,
        "active": session.active,
        "created_at": session.created_at,
        "duration": round(session.duration, 1),
        "subtitles": [s.to_dict() for s in session.subtitles if not s.is_interim],
    }


@app.delete("/api/sessions/{session_id}")
async def stop_session(session_id: str):
    if session_id in _pipelines:
        _pipelines.pop(session_id).stop()
    ok = _sessions.stop(session_id)
    if not ok:
        raise HTTPException(404, "Session not found")
    return {"ok": True}


@app.post("/api/sessions/{session_id}/upload")
async def upload_file(session_id: str, file: UploadFile = File(...)):
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    suffix = Path(file.filename or "audio.wav").suffix
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        shutil.copyfileobj(file.file, tmp)
        tmp.flush()
        tmp.close()

        pipeline = _get_or_create_pipeline(session_id)
        loop = asyncio.get_event_loop()
        fname = file.filename or "audio"

        def _progress(pct: int, phase: str):
            _broadcast_sync({
                "type": "upload_progress",
                "data": {"session_id": session_id, "pct": pct, "phase": phase, "filename": fname},
            }, loop)

        def _error(msg: str):
            _broadcast_sync({
                "type": "upload_error",
                "data": {"session_id": session_id, "message": msg, "filename": fname},
            }, loop)

        def _done():
            pipeline.flush()
            _broadcast_sync({
                "type": "upload_done",
                "data": {"session_id": session_id, "filename": fname},
            }, loop)
            logger.info(f"File upload processing done for session {session_id}")

        fs = FileSource(
            on_chunk=pipeline.feed,
            on_done=_done,
            on_progress=_progress,
            on_error=_error,
        )
        fs.process(tmp.name)
        return {"ok": True, "filename": file.filename}
    except Exception as e:
        os.unlink(tmp.name)
        raise HTTPException(500, str(e))


@app.get("/api/sessions/{session_id}/export/{fmt}")
async def export_session(session_id: str, fmt: str):
    session = _sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    fmt = fmt.lower()
    if fmt == "srt":
        content = _sessions.export_srt(session_id)
        media = "text/plain"
        filename = f"{session_id}.srt"
    elif fmt == "txt":
        content = _sessions.export_txt(session_id)
        media = "text/plain"
        filename = f"{session_id}.txt"
    elif fmt == "json":
        content = _sessions.export_json(session_id)
        media = "application/json"
        filename = f"{session_id}.json"
    else:
        raise HTTPException(400, "fmt must be srt, txt, or json")
    return Response(
        content=content.encode("utf-8"),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Audio sources ---

class MicStartRequest(BaseModel):
    session_id: str
    device: Optional[int] = None


@app.post("/api/sources/mic/start")
async def mic_start(req: MicStartRequest):
    global _mic_source
    session = _sessions.get(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if _mic_source:
        _mic_source.stop()
    pipeline = _get_or_create_pipeline(req.session_id)
    _mic_source = MicSource(on_chunk=pipeline.feed, device=req.device)
    _mic_source.start()
    return {"ok": True}


@app.post("/api/sources/mic/stop")
async def mic_stop():
    global _mic_source
    if _mic_source:
        _mic_source.stop()
        _mic_source = None
    return {"ok": True}


class SystemStartRequest(BaseModel):
    session_id: str


@app.post("/api/sources/system/start")
async def system_start(req: SystemStartRequest):
    global _system_source
    session = _sessions.get(req.session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if _system_source:
        _system_source.stop()
    pipeline = _get_or_create_pipeline(req.session_id)
    _system_source = SystemAudioSource(on_chunk=pipeline.feed)
    ok, msg = _system_source.start()
    if not ok:
        _system_source = None
        raise HTTPException(500, msg)
    return {"ok": True, "device": msg}


@app.post("/api/sources/system/stop")
async def system_stop():
    global _system_source
    if _system_source:
        _system_source.stop()
        _system_source = None
    return {"ok": True}


# ------------------------------------------------------------------
# WebSocket: browser mic audio → pipeline
# ------------------------------------------------------------------

@app.websocket("/ws/audio/{session_id}")
async def ws_audio(websocket: WebSocket, session_id: str):
    """
    Browser sends raw PCM Float32LE mono 16 kHz as binary frames.
    Each frame can be any number of samples.
    """
    session = _sessions.get(session_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found")
        return

    await websocket.accept()
    pipeline = _get_or_create_pipeline(session_id)
    logger.info(f"Browser audio WS connected for session {session_id}")

    try:
        while True:
            data = await websocket.receive_bytes()
            # data is Float32LE PCM
            audio = np.frombuffer(data, dtype=np.float32)
            if len(audio) > 0:
                pipeline.feed(audio)
    except WebSocketDisconnect:
        logger.info(f"Browser audio WS disconnected: {session_id}")
        pipeline.flush()


# ------------------------------------------------------------------
# WebSocket: subtitle broadcast
# ------------------------------------------------------------------

@app.websocket("/ws/subtitles")
async def ws_subtitles(websocket: WebSocket):
    """Subscribe to all subtitle events."""
    await websocket.accept()
    _subtitle_subscribers.add(websocket)
    logger.info(f"Subtitle subscriber connected ({len(_subtitle_subscribers)} total)")
    try:
        while True:
            # Keep connection alive; we only send from server side
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _subtitle_subscribers.discard(websocket)
        logger.info(f"Subtitle subscriber disconnected ({len(_subtitle_subscribers)} remaining)")


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=config.whisper_model)
    parser.add_argument("--host", default=config.host)
    parser.add_argument("--port", type=int, default=config.port)
    args = parser.parse_args()

    config.whisper_model = args.model
    config.host = args.host
    config.port = args.port

    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=False,
        log_level="info",
    )
