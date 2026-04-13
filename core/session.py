"""
Session management and subtitle file export (SRT / TXT / JSON).
"""
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class Subtitle:
    id: str
    session_id: str
    start_time: float       # seconds since session start
    end_time: float
    original_language: str
    original_text: str
    translated_text: str
    is_interim: bool = False
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "start_time": round(self.start_time, 3),
            "end_time": round(self.end_time, 3),
            "original_language": self.original_language,
            "original_text": self.original_text,
            "translated_text": self.translated_text,
            "is_interim": self.is_interim,
            "created_at": self.created_at,
        }


@dataclass
class Session:
    id: str
    name: str
    created_at: float = field(default_factory=time.time)
    subtitles: list[Subtitle] = field(default_factory=list)
    active: bool = True

    @property
    def duration(self) -> float:
        return time.time() - self.created_at


class SessionManager:
    def __init__(self, sessions_dir: str = "./sessions"):
        self.sessions_dir = Path(sessions_dir)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, Session] = {}

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def create(self, name: str = "") -> Session:
        sid = str(uuid.uuid4())[:8]
        name = name or f"Session {len(self._sessions) + 1}"
        session = Session(id=sid, name=name)
        self._sessions[sid] = session
        logger.info(f"Created session {sid} ({name})")
        return session

    def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def list_all(self) -> list[dict]:
        return [
            {
                "id": s.id,
                "name": s.name,
                "active": s.active,
                "created_at": s.created_at,
                "subtitle_count": len([x for x in s.subtitles if not x.is_interim]),
                "duration": round(s.duration, 1),
            }
            for s in self._sessions.values()
        ]

    def stop(self, session_id: str) -> bool:
        session = self.get(session_id)
        if not session:
            return False
        session.active = False
        self._save_all(session)
        logger.info(f"Stopped session {session_id}")
        return True

    # ------------------------------------------------------------------
    # Subtitle management
    # ------------------------------------------------------------------

    def add_subtitle(self, session_id: str, subtitle: Subtitle) -> bool:
        session = self.get(session_id)
        if not session:
            return False

        # Replace interim with the same id if it exists
        for i, s in enumerate(session.subtitles):
            if s.id == subtitle.id:
                session.subtitles[i] = subtitle
                return True

        session.subtitles.append(subtitle)
        return True

    def make_subtitle(
        self,
        session_id: str,
        original_text: str,
        translated_text: str,
        original_language: str,
        duration: float,
        is_interim: bool = False,
        subtitle_id: str | None = None,
    ) -> Subtitle:
        session = self.get(session_id)
        start = session.duration - duration if session else 0.0
        return Subtitle(
            id=subtitle_id or str(uuid.uuid4())[:8],
            session_id=session_id,
            start_time=max(0.0, start),
            end_time=session.duration if session else duration,
            original_language=original_language,
            original_text=original_text,
            translated_text=translated_text,
            is_interim=is_interim,
        )

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------

    def _final_subtitles(self, session: Session) -> list[Subtitle]:
        return [s for s in session.subtitles if not s.is_interim]

    def export_srt(self, session_id: str) -> str:
        session = self.get(session_id)
        if not session:
            return ""
        lines = []
        for i, s in enumerate(self._final_subtitles(session), 1):
            lines.append(str(i))
            lines.append(f"{_fmt_srt(s.start_time)} --> {_fmt_srt(s.end_time)}")
            lines.append(s.original_text)
            if s.translated_text:
                lines.append(s.translated_text)
            lines.append("")
        return "\n".join(lines)

    def export_txt(self, session_id: str) -> str:
        session = self.get(session_id)
        if not session:
            return ""
        lines = []
        for s in self._final_subtitles(session):
            ts = f"[{_fmt_ts(s.start_time)} → {_fmt_ts(s.end_time)}]"
            lines.append(f"{ts}  [{s.original_language}]")
            lines.append(f"  {s.original_text}")
            if s.translated_text:
                lines.append(f"  {s.translated_text}")
            lines.append("")
        return "\n".join(lines)

    def export_json(self, session_id: str) -> str:
        session = self.get(session_id)
        if not session:
            return "{}"
        data = {
            "session_id": session.id,
            "name": session.name,
            "created_at": session.created_at,
            "subtitles": [s.to_dict() for s in self._final_subtitles(session)],
        }
        return json.dumps(data, ensure_ascii=False, indent=2)

    # ------------------------------------------------------------------
    # Auto-save
    # ------------------------------------------------------------------

    def _save_all(self, session: Session) -> None:
        base = self.sessions_dir / session.id
        base.mkdir(exist_ok=True)
        (base / f"{session.id}.srt").write_text(self.export_srt(session.id), encoding="utf-8")
        (base / f"{session.id}.txt").write_text(self.export_txt(session.id), encoding="utf-8")
        (base / f"{session.id}.json").write_text(self.export_json(session.id), encoding="utf-8")
        logger.debug(f"Saved session {session.id} to {base}")

    def autosave(self, session_id: str) -> None:
        session = self.get(session_id)
        if session:
            self._save_all(session)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _fmt_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _fmt_ts(seconds: float) -> str:
    m = int(seconds // 60)
    s = seconds % 60
    return f"{m:02d}:{s:05.2f}"
