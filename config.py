import os
from dataclasses import dataclass


@dataclass
class Config:
    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    # ASR - faster-whisper
    whisper_model: str = "large-v3"
    device: str = "cuda"
    compute_type: str = "float16"

    # Translation (Helsinki en→zh runs on CPU to save VRAM)
    en_zh_model: str = "Helsinki-NLP/opus-mt-en-zh"
    translation_device: str = "cpu"

    # VAD
    vad_threshold: float = 0.5
    min_silence_ms: int = 500
    max_speech_ms: int = 30000   # force-flush after 30s of continuous speech

    # Audio
    sample_rate: int = 16000

    # Interim results: run Whisper on buffered audio every N seconds during speech
    interim_interval_s: float = 2.5

    # Sentence-gap: wait this many seconds of silence after a VAD utterance before
    # flushing to Whisper. Longer = more complete sentences, higher latency.
    # 0.0 = immediate (original behaviour). Adjustable at runtime via /api/settings.
    sentence_gap_s: float = 1.5

    # Local session storage
    sessions_dir: str = "./sessions"

    def __post_init__(self):
        os.makedirs(self.sessions_dir, exist_ok=True)


config = Config()
