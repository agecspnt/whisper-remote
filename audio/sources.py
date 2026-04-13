"""
Audio source adapters.

All sources push float32 16 kHz mono numpy arrays into an asyncio.Queue
so the pipeline can process them uniformly.

Sources:
  MicSource          – local microphone via sounddevice
  SystemAudioSource  – system audio monitor (PulseAudio / PipeWire loopback)
  FileSource         – static audio file processing (offline)
"""
import asyncio
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable

import numpy as np
import sounddevice as sd
import soundfile as sf

logger = logging.getLogger(__name__)

TARGET_SR = 16000
BLOCKSIZE = 1024  # ~64 ms per callback at native rate

# Formats libsndfile cannot open — route through ffmpeg
_FFMPEG_FORMATS = {".m4a", ".aac", ".mp3", ".mp4", ".mov", ".webm", ".ogg", ".opus", ".wma", ".flac"}


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _to_mono_16k(audio: np.ndarray, orig_sr: int) -> np.ndarray:
    """Convert any shape / sample rate to float32 mono 16 kHz."""
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    if orig_sr != TARGET_SR:
        import torch, torchaudio
        t = torch.from_numpy(audio).unsqueeze(0)
        audio = torchaudio.functional.resample(t, orig_sr, TARGET_SR).squeeze(0).numpy()
    return audio


def _native_sr(device: int | None) -> int:
    """Return the default sample rate of a sounddevice input device."""
    info = sd.query_devices(device if device is not None else sd.default.device[0])
    return int(info["default_samplerate"])


def _list_monitor_device() -> int | None:
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0 and "monitor" in dev["name"].lower():
            return i
    return None


def _ffmpeg_to_wav(src: str) -> str:
    """Convert any audio/video file to a temp WAV via ffmpeg. Returns temp path."""
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-ar", str(TARGET_SR), "-ac", "1", tmp.name],
        capture_output=True,
        check=True,
    )
    return tmp.name


# ------------------------------------------------------------------
# Mic source
# ------------------------------------------------------------------

class MicSource:
    """Capture from the default (or specified) microphone.

    Opens the stream at the device's native sample rate and resamples
    to 16 kHz in the callback, avoiding PortAudio InvalidSampleRate errors.
    """

    def __init__(self, on_chunk: Callable[[np.ndarray], None], device: int | None = None):
        self.on_chunk = on_chunk
        self.device = device
        self._stream: sd.InputStream | None = None
        self._native_sr: int = TARGET_SR

    def start(self) -> None:
        if self._stream:
            return
        self._native_sr = _native_sr(self.device)
        logger.info(f"Starting mic (device={self.device}, native_sr={self._native_sr})")
        self._stream = sd.InputStream(
            samplerate=self._native_sr,
            channels=1,
            dtype="float32",
            blocksize=BLOCKSIZE,
            device=self.device,
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            logger.info("Mic capture stopped.")

    def _callback(self, indata: np.ndarray, frames: int, time_info, status) -> None:
        if status:
            logger.warning(f"Mic status: {status}")
        chunk = indata[:, 0].copy()
        if self._native_sr != TARGET_SR:
            chunk = _to_mono_16k(chunk, self._native_sr)
        self.on_chunk(chunk)


# ------------------------------------------------------------------
# System audio source
# ------------------------------------------------------------------

class SystemAudioSource:
    """Capture system audio via PulseAudio / PipeWire monitor device."""

    def __init__(self, on_chunk: Callable[[np.ndarray], None]):
        self.on_chunk = on_chunk
        self._stream: sd.InputStream | None = None
        self._native_sr: int = TARGET_SR

    def start(self) -> tuple[bool, str]:
        if self._stream:
            return True, "already running"

        device = _list_monitor_device()
        if device is None:
            msg = ("No PulseAudio/PipeWire monitor device found. "
                   "On PulseAudio: pactl load-module module-loopback. "
                   "On PipeWire: it should be listed automatically.")
            logger.warning(msg)
            return False, msg

        self._native_sr = _native_sr(device)
        dev_name = sd.query_devices(device)["name"]
        logger.info(f"Starting system audio: [{device}] {dev_name} @ {self._native_sr} Hz")
        self._stream = sd.InputStream(
            samplerate=self._native_sr,
            channels=1,
            dtype="float32",
            blocksize=BLOCKSIZE,
            device=device,
            callback=self._callback,
        )
        self._stream.start()
        return True, dev_name

    def stop(self) -> None:
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            logger.info("System audio capture stopped.")

    def _callback(self, indata: np.ndarray, frames: int, time_info, status) -> None:
        if status:
            logger.warning(f"System audio status: {status}")
        chunk = indata[:, 0].copy()
        if self._native_sr != TARGET_SR:
            chunk = _to_mono_16k(chunk, self._native_sr)
        self.on_chunk(chunk)


# ------------------------------------------------------------------
# File source
# ------------------------------------------------------------------

class FileSource:
    """Process an uploaded audio/video file."""

    def __init__(
        self,
        on_chunk: Callable[[np.ndarray], None],
        on_done: Callable[[], None],
        on_progress: Callable[[int, str], None] | None = None,
        on_error: Callable[[str], None] | None = None,
    ):
        self.on_chunk = on_chunk
        self.on_done = on_done
        self.on_progress = on_progress  # (pct: int, phase: str)
        self.on_error = on_error        # (message: str)

    def process(self, file_path: str | Path, chunk_duration_s: float = 0.5) -> None:
        threading.Thread(target=self._run, args=(str(file_path), chunk_duration_s), daemon=True).start()

    def _run(self, file_path: str, chunk_duration_s: float) -> None:
        logger.info(f"Processing file: {file_path}")
        tmp_wav = None
        try:
            suffix = Path(file_path).suffix.lower()
            work_path = file_path

            if suffix in _FFMPEG_FORMATS:
                self._progress(2, "converting")
                logger.info(f"Converting {suffix} via ffmpeg...")
                tmp_wav = _ffmpeg_to_wav(file_path)
                work_path = tmp_wav

            self._progress(5, "reading")
            audio, sr = sf.read(work_path, dtype="float32", always_2d=True)
            audio = _to_mono_16k(audio, sr)

            total = len(audio)
            chunk_size = int(chunk_duration_s * TARGET_SR)
            for offset in range(0, total, chunk_size):
                self.on_chunk(audio[offset: offset + chunk_size])
                pct = 5 + int(95 * min(offset + chunk_size, total) / total)
                self._progress(pct, "processing")

            logger.info(f"File processing complete: {file_path}")
        except subprocess.CalledProcessError as e:
            msg = f"ffmpeg 转换失败: {e.stderr.decode(errors='replace')[:200]}"
            logger.error(msg)
            if self.on_error:
                self.on_error(msg)
        except Exception as e:
            msg = str(e)
            logger.exception(f"Error processing file {file_path}")
            if self.on_error:
                self.on_error(msg)
        finally:
            if tmp_wav:
                os.unlink(tmp_wav)
            self.on_done()

    def _progress(self, pct: int, phase: str) -> None:
        if self.on_progress:
            try:
                self.on_progress(pct, phase)
            except Exception:
                pass


# ------------------------------------------------------------------
# Device listing (for API)
# ------------------------------------------------------------------

def list_input_devices() -> list[dict]:
    devices = []
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            devices.append({
                "index": i,
                "name": dev["name"],
                "channels": dev["max_input_channels"],
                "sample_rate": int(dev["default_samplerate"]),
                "is_monitor": "monitor" in dev["name"].lower(),
            })
    return devices
