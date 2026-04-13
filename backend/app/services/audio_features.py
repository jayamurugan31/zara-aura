from __future__ import annotations

import base64
import io
from dataclasses import dataclass

import anyio
import librosa
import numpy as np


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass(slots=True)
class AudioFeatureResult:
    volume: float
    pitch: float
    speech_rate: float
    duration_seconds: float


class AudioFeatureService:
    """Extract minimal orb-driving features from short audio chunks."""

    async def extract_from_bytes(self, audio_bytes: bytes) -> AudioFeatureResult:
        return await anyio.to_thread.run_sync(self._extract_sync, audio_bytes)

    async def extract_from_base64(self, encoded_audio: str) -> dict[str, float]:
        decoded = base64.b64decode(encoded_audio)
        features = await self.extract_from_bytes(decoded)
        return {
            "volume": features.volume,
            "pitch": features.pitch,
        }

    def _extract_sync(self, audio_bytes: bytes) -> AudioFeatureResult:
        if not audio_bytes:
            return AudioFeatureResult(volume=0.0, pitch=0.0, speech_rate=0.0, duration_seconds=0.0)

        audio, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
        audio = np.asarray(audio, dtype=np.float32)

        if audio.size == 0:
            return AudioFeatureResult(volume=0.0, pitch=0.0, speech_rate=0.0, duration_seconds=0.0)

        duration_seconds = float(audio.shape[0] / sr)

        rms = float(np.mean(librosa.feature.rms(y=audio)))
        zcr = float(np.mean(librosa.feature.zero_crossing_rate(y=audio)))
        tempo, _ = librosa.beat.beat_track(y=audio, sr=sr)

        # Scale RMS to a normalized UI volume in [0, 1].
        volume = _clamp(rms * 4.0, 0.0, 1.0)

        # Rough pitch proxy from zero crossing rate, intentionally lightweight.
        pitch = _clamp(80.0 + (zcr * 1400.0), 60.0, 420.0)

        speech_rate = float(tempo if np.isfinite(tempo) else 0.0)

        return AudioFeatureResult(
            volume=round(volume, 3),
            pitch=round(pitch, 1),
            speech_rate=round(speech_rate, 1),
            duration_seconds=round(duration_seconds, 3),
        )
