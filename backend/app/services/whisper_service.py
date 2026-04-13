from __future__ import annotations

import asyncio
import io
import logging
import os
import tempfile

import anyio
import librosa
import numpy as np

from app.config import Settings


logger = logging.getLogger(__name__)


class WhisperService:
    """Lazy loaded Faster-Whisper transcription service."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._model = None
        self._model_lock = asyncio.Lock()
        self._transcribe_semaphore = asyncio.Semaphore(1)

    async def transcribe_audio(self, audio_bytes: bytes) -> str:
        if not audio_bytes:
            return ""

        model = await self._get_model()

        try:
            audio_array, sr = await anyio.to_thread.run_sync(self._decode_sync, audio_bytes)
        except Exception as decode_error:
            logger.warning("Primary audio decode failed; trying tempfile fallback: %s", decode_error)
        else:
            if audio_array.size == 0:
                return ""

            duration_seconds = float(audio_array.shape[0] / sr)
            if duration_seconds > self.settings.max_audio_seconds:
                raise ValueError(
                    f"Audio chunk too long ({duration_seconds:.2f}s). "
                    f"Send chunks up to {self.settings.max_audio_seconds}s."
                )

            async with self._transcribe_semaphore:
                return await anyio.to_thread.run_sync(self._transcribe_sync, model, audio_array)

        try:
            async with self._transcribe_semaphore:
                text, duration_seconds = await anyio.to_thread.run_sync(
                    self._transcribe_from_tempfile_sync,
                    model,
                    audio_bytes,
                )
        except Exception as fallback_error:
            logger.warning("Fallback transcription decode failed: %s", fallback_error)
            raise ValueError(
                "Unsupported or unreadable audio format. "
                "Send short chunks as audio/webm, audio/wav, audio/mp4, or audio/ogg."
            ) from fallback_error

        if duration_seconds > self.settings.max_audio_seconds:
            raise ValueError(
                f"Audio chunk too long ({duration_seconds:.2f}s). "
                f"Send chunks up to {self.settings.max_audio_seconds}s."
            )

        return text

    async def batch_transcribe(self, chunks: list[bytes]) -> list[str]:
        tasks = [self.transcribe_audio(chunk) for chunk in chunks]
        return await asyncio.gather(*tasks)

    async def _get_model(self):
        if self._model is not None:
            return self._model

        async with self._model_lock:
            if self._model is not None:
                return self._model

            def _load_model():
                from faster_whisper import WhisperModel

                return WhisperModel(
                    self.settings.whisper_model_size,
                    device=self.settings.whisper_device,
                    compute_type=self.settings.whisper_compute_type,
                )

            self._model = await anyio.to_thread.run_sync(_load_model)
            return self._model

    def _decode_sync(self, audio_bytes: bytes) -> tuple[np.ndarray, int]:
        audio, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
        audio = np.asarray(audio, dtype=np.float32)
        return audio, sr

    def _transcribe_sync(self, model, audio_array: np.ndarray) -> str:
        segments, _ = model.transcribe(
            audio_array,
            beam_size=1,
            best_of=1,
            temperature=0.0,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text)
        return text.strip()

    def _transcribe_from_tempfile_sync(self, model, audio_bytes: bytes) -> tuple[str, float]:
        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=_guess_audio_suffix(audio_bytes)) as temp_file:
                temp_file.write(audio_bytes)
                temp_path = temp_file.name

            segments, info = model.transcribe(
                temp_path,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
            duration = float(getattr(info, "duration", 0.0) or 0.0)
            return text, duration
        finally:
            if temp_path:
                try:
                    os.remove(temp_path)
                except OSError:
                    pass


def _guess_audio_suffix(audio_bytes: bytes) -> str:
    if audio_bytes.startswith(b"RIFF") and len(audio_bytes) >= 12 and audio_bytes[8:12] == b"WAVE":
        return ".wav"
    if audio_bytes.startswith(b"OggS"):
        return ".ogg"
    if audio_bytes.startswith(b"fLaC"):
        return ".flac"
    if audio_bytes.startswith(b"ID3"):
        return ".mp3"
    if audio_bytes[:2] == b"\xff\xfb":
        return ".mp3"
    if audio_bytes.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm"
    return ".bin"
