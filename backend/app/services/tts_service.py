from __future__ import annotations

import asyncio
import tempfile
import uuid
from pathlib import Path

import anyio

from app.config import Settings


class TTSService:
    """Optional lazy-loaded Coqui TTS service for offline speech synthesis."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._tts_model = None
        self._model_lock = asyncio.Lock()

    async def synthesize_to_temp(self, text: str) -> str | None:
        if not self.settings.tts_enabled:
            return None

        if not text.strip():
            return None

        tts_model = await self._get_model()
        if tts_model is None:
            return None

        output_dir = Path(tempfile.gettempdir()) / "zara_tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{uuid.uuid4().hex}.wav"

        def _synthesize() -> None:
            tts_model.tts_to_file(text=text, file_path=str(output_path))

        await anyio.to_thread.run_sync(_synthesize)
        return str(output_path)

    async def _get_model(self):
        if self._tts_model is not None:
            return self._tts_model

        async with self._model_lock:
            if self._tts_model is not None:
                return self._tts_model

            def _load_model():
                from TTS.api import TTS

                return TTS(
                    model_name=self.settings.tts_model_name,
                    progress_bar=False,
                    gpu=False,
                )

            self._tts_model = await anyio.to_thread.run_sync(_load_model)
            return self._tts_model
