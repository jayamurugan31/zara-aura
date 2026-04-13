from __future__ import annotations

import asyncio
import logging
import tempfile
import uuid
from pathlib import Path
from typing import Final

import anyio

from app.config import Settings


logger = logging.getLogger(__name__)


class TTSService:
    """Optional lazy-loaded Coqui TTS service for offline speech synthesis."""

    EDGE_VOICE_BY_LANGUAGE: Final[dict[str, str]] = {
        "en": "en-IN-NeerjaNeural",
        "hi": "hi-IN-SwaraNeural",
        "ta": "ta-IN-PallaviNeural",
        "te": "te-IN-ShrutiNeural",
        "ml": "ml-IN-SobhanaNeural",
    }

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._tts_model = None
        self._model_lock = asyncio.Lock()

    async def synthesize_bytes(self, text: str, language_code: str | None = None) -> tuple[bytes, str] | None:
        if not text.strip():
            return None

        normalized_language = self._normalize_language_code(language_code)

        edge_audio = await self._synthesize_with_edge_tts(text, normalized_language)
        if edge_audio:
            return edge_audio, "audio/mpeg"

        gtts_audio = await self._synthesize_with_gtts(text, normalized_language)
        if gtts_audio:
            return gtts_audio, "audio/mpeg"

        local_path = await self.synthesize_to_temp(text)
        if not local_path:
            return None

        def _read_and_cleanup(path_value: str) -> bytes:
            path = Path(path_value)
            data = path.read_bytes()
            path.unlink(missing_ok=True)
            return data

        audio_data = await anyio.to_thread.run_sync(_read_and_cleanup, local_path)
        return audio_data, "audio/wav"

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

    async def _synthesize_with_edge_tts(self, text: str, language_code: str) -> bytes | None:
        voice = self.EDGE_VOICE_BY_LANGUAGE.get(language_code, self.EDGE_VOICE_BY_LANGUAGE["en"])

        try:
            import edge_tts
        except Exception:
            return None

        try:
            communicator = edge_tts.Communicate(text=text, voice=voice)
            chunks: list[bytes] = []
            async for chunk in communicator.stream():
                if chunk.get("type") != "audio":
                    continue

                audio_chunk = chunk.get("data")
                if isinstance(audio_chunk, (bytes, bytearray)):
                    chunks.append(bytes(audio_chunk))

            if not chunks:
                return None

            return b"".join(chunks)
        except Exception as exc:
            logger.warning("Edge TTS failed for language=%s voice=%s: %s", language_code, voice, exc)
            return None

    async def _synthesize_with_gtts(self, text: str, language_code: str) -> bytes | None:
        gtts_language = {
            "en": "en",
            "hi": "hi",
            "ta": "ta",
            "te": "te",
            "ml": "ml",
        }.get(language_code, "en")

        def _generate() -> bytes:
            from io import BytesIO

            from gtts import gTTS

            stream = BytesIO()
            gTTS(text=text, lang=gtts_language, slow=False).write_to_fp(stream)
            return stream.getvalue()

        try:
            audio_data = await anyio.to_thread.run_sync(_generate)
            return audio_data if audio_data else None
        except Exception as exc:
            logger.warning("gTTS failed for language=%s: %s", language_code, exc)
            return None

    def _normalize_language_code(self, language_code: str | None) -> str:
        if not language_code:
            return "en"

        lowered = language_code.strip().lower()
        aliases = {
            "en": "en",
            "en-us": "en",
            "en-gb": "en",
            "english": "en",
            "hi": "hi",
            "hi-in": "hi",
            "hindi": "hi",
            "ta": "ta",
            "ta-in": "ta",
            "tamil": "ta",
            "te": "te",
            "te-in": "te",
            "telugu": "te",
            "ml": "ml",
            "ml-in": "ml",
            "malayalam": "ml",
        }

        if lowered in aliases:
            return aliases[lowered]

        return aliases.get(lowered.split("-")[0], "en")
