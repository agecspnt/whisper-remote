"""
Real-time Voice Activity Detection using Silero VAD.

Usage:
    vad = RealtimeVAD(on_utterance=my_callback)
    vad.feed(audio_chunk_16khz_float32)   # call repeatedly with 512-sample chunks
    vad.flush()                            # call when stream ends
"""
import logging
from collections import deque
from typing import Callable

import numpy as np
import torch
from silero_vad import load_silero_vad, VADIterator

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHUNK_SIZE = 512          # required by silero-vad at 16 kHz
PRE_ROLL_CHUNKS = 10      # ~320 ms of audio kept before speech onset


class RealtimeVAD:
    def __init__(
        self,
        on_utterance: Callable[[np.ndarray], None],
        threshold: float = 0.5,
        min_silence_ms: int = 500,
        max_speech_ms: int = 30_000,
    ):
        logger.info("Loading Silero VAD...")
        model = load_silero_vad()
        self.vad_iter = VADIterator(
            model,
            threshold=threshold,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=min_silence_ms,
            speech_pad_ms=100,
        )
        self.on_utterance = on_utterance
        self.max_speech_samples = int(max_speech_ms * SAMPLE_RATE / 1000)

        # Rolling pre-roll buffer (used before speech starts)
        self._pre_roll: deque[np.ndarray] = deque(maxlen=PRE_ROLL_CHUNKS)
        # Buffer that accumulates during active speech
        self._speech: list[np.ndarray] = []
        self._speaking = False
        logger.info("VAD ready.")

    # ------------------------------------------------------------------

    def feed(self, audio: np.ndarray) -> None:
        """
        Feed arbitrary-length float32 16 kHz mono audio.
        Internally processed in CHUNK_SIZE windows.
        """
        audio = audio.astype(np.float32)
        for offset in range(0, len(audio) - CHUNK_SIZE + 1, CHUNK_SIZE):
            self._process(audio[offset: offset + CHUNK_SIZE])

    def _process(self, chunk: np.ndarray) -> None:
        tensor = torch.from_numpy(chunk)
        event = self.vad_iter(tensor, return_seconds=False)

        if event is not None:
            if "start" in event:
                self._speaking = True
                # Prepend pre-roll so Whisper gets context
                self._speech = list(self._pre_roll) + [chunk]
            elif "end" in event:
                if self._speaking:
                    self._speech.append(chunk)
                    self._speaking = False
                    self._emit()
                    self._speech = []
                self._pre_roll.clear()
        elif self._speaking:
            self._speech.append(chunk)
            # Hard cap: force flush if speech is too long
            total = sum(len(c) for c in self._speech)
            if total >= self.max_speech_samples:
                self._emit()
                self._speech = []
                self._speaking = False
        else:
            self._pre_roll.append(chunk)

    def _emit(self) -> None:
        if not self._speech:
            return
        audio = np.concatenate(self._speech)
        try:
            self.on_utterance(audio)
        except Exception:
            logger.exception("Error in on_utterance callback")

    def flush(self) -> None:
        """Flush any buffered speech (call when audio stream ends)."""
        if self._speaking and self._speech:
            self._emit()
        self._speech = []
        self._speaking = False
        self.vad_iter.reset_states()
        self._pre_roll.clear()

    @property
    def is_speaking(self) -> bool:
        return self._speaking

    def current_buffer(self) -> np.ndarray | None:
        """Return current speech buffer (for interim processing) without flushing."""
        if not self._speech:
            return None
        return np.concatenate(self._speech)
