from __future__ import annotations

import asyncio
import io

import anyio
import librosa
import numpy as np

from app.config import Settings


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
        audio_array, sr = await anyio.to_thread.run_sync(self._decode_sync, audio_bytes)

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
