"""
ASR engine wrapping faster-whisper.

Flow per audio segment:
  1. transcribe(audio)  → original text + detected language
  2. if Chinese: translate(audio) via Whisper translate task → English text
  3. if English: return original; pipeline will call translator for zh
"""
import logging
import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

CHINESE_LANGS = {"zh", "yue"}  # Mandarin + Cantonese
ALLOWED_LANGS = {"zh", "yue", "en"}  # only languages we expect in the audio stream


class ASREngine:
    def __init__(self, model_size: str = "large-v3", device: str = "cuda", compute_type: str = "float16"):
        logger.info(f"Loading Whisper {model_size} on {device} ({compute_type})...")
        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)
        logger.info("Whisper ready.")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _run(self, audio: np.ndarray, task: str, language: str | None) -> tuple[str, str, float]:
        """Run faster-whisper and return (text, detected_language, lang_prob)."""
        segments, info = self.model.transcribe(
            audio,
            task=task,
            language=language,
            beam_size=5,
            vad_filter=False,   # VAD is handled upstream
            word_timestamps=False,
        )
        text = " ".join(s.text for s in segments).strip()
        return text, info.language, info.language_probability

    @staticmethod
    def _snap_to_allowed(info) -> str:
        """
        When Whisper auto-detects a language outside ALLOWED_LANGS, pick the
        better of zh vs en using the full language probability distribution.
        """
        if info.all_language_probs:
            probs = dict(info.all_language_probs)
            zh_score = probs.get("zh", 0.0) + probs.get("yue", 0.0)
            en_score = probs.get("en", 0.0)
            snapped = "zh" if zh_score >= en_score else "en"
        else:
            snapped = "zh"  # conservative default
        logger.info(
            f"Language '{info.language}' (p={info.language_probability:.2f}) is outside "
            f"allowed set — snapping to '{snapped}'"
        )
        return snapped

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(self, audio: np.ndarray) -> dict | None:
        """
        Full pipeline for one audio segment.

        Returns:
            {
                "original_text":    str,
                "translated_text":  str,   # may be empty — pipeline fills this in
                "original_language": str,  # "zh" | "yue" | "en"
                "lang_prob":        float,
            }
            or None if no speech detected.
        """
        # First pass: auto-detect + transcribe
        segments, info = self.model.transcribe(
            audio,
            task="transcribe",
            language=None,
            beam_size=5,
            vad_filter=False,
            word_timestamps=False,
        )
        original_text = " ".join(s.text for s in segments).strip()
        language = info.language
        lang_prob = info.language_probability

        # If Whisper picked a language we don't expect, snap to zh or en and
        # re-transcribe so the output text is in the correct script/language.
        if language not in ALLOWED_LANGS:
            language = self._snap_to_allowed(info)
            original_text, _, _ = self._run(audio, task="transcribe", language=language)

        if not original_text.strip():
            return None

        translated_text = ""

        if language in CHINESE_LANGS:
            # Use Whisper's own translate task (zh → en)
            translated_text, _, _ = self._run(audio, task="translate", language=language)

        return {
            "original_text": original_text,
            "translated_text": translated_text,   # en→zh filled by Translator later
            "original_language": language,
            "lang_prob": lang_prob,
        }
