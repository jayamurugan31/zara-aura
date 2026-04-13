from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ModeLiteral = Literal["online", "smart", "offline"]
EmotionLiteral = Literal["happy", "angry", "calm", "neutral"]


class AudioFeatures(BaseModel):
    model_config = ConfigDict(extra="ignore")

    volume: float = Field(ge=0.0, le=1.0)
    pitch: float = Field(ge=0.0)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=4000)
    mode: ModeLiteral | None = None
    preferred_language: str | None = Field(default=None, min_length=2, max_length=16)
    volume: float | None = Field(default=None, ge=0.0, le=1.0)
    synthesize: bool = False


class ModeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mode: ModeLiteral


class ChatResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str
    language: str = Field(min_length=2, max_length=16)
    emotion: EmotionLiteral
    audio_features: AudioFeatures
    action: dict[str, Any] | None = None


class VoiceResponse(ChatResponse):
    transcript: str


class TTSRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=6000)
    language: str | None = Field(default=None, min_length=2, max_length=16)


class ModeResponse(BaseModel):
    mode: ModeLiteral
