"""
AudioPipeline: VAD → sentence-gap buffer → ASR → Translation → broadcast.

Sentence-gap buffering
----------------------
Silero VAD fires on_utterance after min_silence_ms (default 500 ms) of
silence, which may split a sentence mid-way.  The pipeline holds each
utterance in _sentence_buf and resets a debounce timer.  Only when
sentence_gap_s seconds have passed with NO new utterance does the whole
accumulated audio get sent to Whisper as one call.

Set sentence_gap_s = 0 to revert to the original immediate-dispatch
behaviour.  The value is mutable at runtime so the web UI can change it
without restarting the server.

One pipeline instance per active session.  Whisper runs in a shared
single-thread executor so the GPU is never double-booked.
"""
import asyncio
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import numpy as np

from core.asr import ASREngine, CHINESE_LANGS
from core.translator import Translator
from core.vad import RealtimeVAD
from core.session import SessionManager

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")


class AudioPipeline:
    def __init__(
        self,
        session_id: str,
        asr: ASREngine,
        translator: Translator,
        session_manager: SessionManager,
        on_subtitle: Callable[[dict], None],
        loop: asyncio.AbstractEventLoop,
        interim_interval_s: float = 2.5,
        sentence_gap_s: float = 1.5,
    ):
        self.session_id = session_id
        self.asr = asr
        self.translator = translator
        self.sessions = session_manager
        self.on_subtitle = on_subtitle
        self.loop = loop
        self.interim_interval_s = interim_interval_s
        self.sentence_gap_s = sentence_gap_s   # mutable — updated by /api/settings

        self._running = True
        self._current_interim_id: str | None = None

        # Sentence-gap buffer (all access happens in the asyncio event loop)
        self._sentence_buf: list[np.ndarray] = []
        self._sentence_timer: asyncio.TimerHandle | None = None

        self.vad = RealtimeVAD(
            on_utterance=self._on_utterance,
            threshold=0.5,
            min_silence_ms=500,
            max_speech_ms=30_000,
        )

        asyncio.run_coroutine_threadsafe(self._interim_loop(), loop)

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def feed(self, audio: np.ndarray) -> None:
        if not self._running:
            return
        self.vad.feed(audio)

    def stop(self) -> None:
        self._running = False
        self.flush()

    def flush(self) -> None:
        """Flush VAD + pending sentence buffer (call when audio stream ends)."""
        self.vad.flush()  # may trigger _on_utterance → _buffer_utterance
        # Yield briefly so _buffer_utterance can land, then flush immediately.
        asyncio.run_coroutine_threadsafe(self._delayed_flush(), self.loop)

    # ------------------------------------------------------------------
    # VAD callback (background thread)
    # ------------------------------------------------------------------

    def _on_utterance(self, audio: np.ndarray) -> None:
        asyncio.run_coroutine_threadsafe(self._buffer_utterance(audio), self.loop)

    # ------------------------------------------------------------------
    # Sentence-gap buffer  (asyncio event loop — no extra locking needed)
    # ------------------------------------------------------------------

    async def _buffer_utterance(self, audio: np.ndarray) -> None:
        self._sentence_buf.append(audio)

        if self.sentence_gap_s <= 0:
            # Immediate mode: send right away (original behaviour)
            if self._sentence_timer:
                self._sentence_timer.cancel()
                self._sentence_timer = None
            await self._flush_sentence()
        else:
            # Debounce: reset the timer on every new utterance
            if self._sentence_timer:
                self._sentence_timer.cancel()
            self._sentence_timer = self.loop.call_later(
                self.sentence_gap_s,
                lambda: self.loop.create_task(self._flush_sentence()),
            )

    async def _flush_sentence(self) -> None:
        self._sentence_timer = None
        if not self._sentence_buf:
            return
        combined = np.concatenate(self._sentence_buf)
        self._sentence_buf = []
        interim_id = self._current_interim_id
        self._current_interim_id = None
        await self._process_audio(combined, interim_id=interim_id, is_interim=False)

    async def _delayed_flush(self) -> None:
        """Cancel the pending timer and flush immediately (stream ended)."""
        await asyncio.sleep(0.05)
        if self._sentence_timer:
            self._sentence_timer.cancel()
            self._sentence_timer = None
        await self._flush_sentence()

    # ------------------------------------------------------------------
    # Interim results
    # ------------------------------------------------------------------

    async def _interim_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.interim_interval_s)
            if not self._running:
                break

            # Include already-buffered utterances + any in-progress VAD speech
            parts: list[np.ndarray] = list(self._sentence_buf)
            if self.vad.is_speaking:
                cur = self.vad.current_buffer()
                if cur is not None:
                    parts.append(cur)

            if not parts:
                continue
            if sum(len(p) for p in parts) < 8000:   # < 0.5 s
                continue

            if self._current_interim_id is None:
                self._current_interim_id = str(uuid.uuid4())[:8]
            await self._process_audio(
                np.concatenate(parts).copy(),
                interim_id=self._current_interim_id,
                is_interim=True,
            )

    # ------------------------------------------------------------------
    # ASR + translation
    # ------------------------------------------------------------------

    async def _process_audio(
        self, audio: np.ndarray, interim_id: str | None, is_interim: bool
    ) -> None:
        if not self._running:
            return

        audio_duration = len(audio) / 16000
        result = await self.loop.run_in_executor(_executor, self.asr.process, audio)
        if result is None:
            return

        lang = result["original_language"]
        original = result["original_text"]
        translated = result["translated_text"]

        if lang not in CHINESE_LANGS and not translated:
            translated = await self.loop.run_in_executor(
                None, self.translator.translate, original
            )

        if lang in CHINESE_LANGS:
            display = {"zh": original, "en": translated}
        else:
            display = {"en": original, "zh": translated}

        subtitle = self.sessions.make_subtitle(
            session_id=self.session_id,
            original_text=original,
            translated_text=translated,
            original_language=lang,
            duration=audio_duration,
            is_interim=is_interim,
            subtitle_id=interim_id,
        )
        self.sessions.add_subtitle(self.session_id, subtitle)
        if not is_interim:
            self.sessions.autosave(self.session_id)

        payload = subtitle.to_dict()
        payload["display"] = display
        self.on_subtitle(payload)
