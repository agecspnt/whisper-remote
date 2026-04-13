"""
Helsinki-NLP en→zh translator (runs on CPU to preserve VRAM for Whisper).
Only called when the detected language is English.
"""
import logging
import torch
from transformers import MarianMTModel, MarianTokenizer

logger = logging.getLogger(__name__)


class Translator:
    def __init__(self, model_name: str = "Helsinki-NLP/opus-mt-en-zh", device: str = "cpu"):
        logger.info(f"Loading translation model {model_name} on {device}...")
        self.tokenizer = MarianTokenizer.from_pretrained(model_name)
        self.model = MarianMTModel.from_pretrained(model_name).to(device)
        self.model.eval()
        self.device = device
        logger.info("Translator ready.")

    def translate(self, text: str) -> str:
        """Translate English text to Simplified Chinese."""
        if not text.strip():
            return ""
        inputs = self.tokenizer(
            text,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=512,
        ).to(self.device)
        with torch.no_grad():
            output_ids = self.model.generate(**inputs, num_beams=4)
        return self.tokenizer.decode(output_ids[0], skip_special_tokens=True)
