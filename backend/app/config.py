from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_csv(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(slots=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "ZARA AI Backend")
    app_version: str = os.getenv("APP_VERSION", "0.1.0")

    default_mode: str = os.getenv("DEFAULT_MODE", "smart")

    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_model: str = os.getenv("OPENROUTER_MODEL", "google/gemini-2.0-flash-001")
    openrouter_timeout_s: float = _env_float("OPENROUTER_TIMEOUT_S", 10.0)
    openrouter_temperature: float = _env_float("OPENROUTER_TEMPERATURE", 0.65)
    openrouter_max_tokens: int = _env_int("OPENROUTER_MAX_TOKENS", 720)

    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "phi3:mini")
    ollama_fallback_model: str = os.getenv("OLLAMA_FALLBACK_MODEL", "gemma2:2b")
    ollama_timeout_s: float = _env_float("OLLAMA_TIMEOUT_S", 8.0)
    ollama_num_ctx: int = _env_int("OLLAMA_NUM_CTX", 2048)
    ollama_num_predict: int = _env_int("OLLAMA_NUM_PREDICT", 260)

    whisper_model_size: str = os.getenv("WHISPER_MODEL_SIZE", "tiny")
    whisper_device: str = os.getenv("WHISPER_DEVICE", "cpu")
    whisper_compute_type: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
    max_audio_seconds: int = _env_int("MAX_AUDIO_SECONDS", 8)

    cache_ttl_seconds: int = _env_int("CACHE_TTL_SECONDS", 90)
    cache_max_entries: int = _env_int("CACHE_MAX_ENTRIES", 256)

    memory_limit: int = _env_int("MEMORY_LIMIT", 5)

    automation_execute: bool = _env_bool("AUTOMATION_EXECUTE", False)

    tts_enabled: bool = _env_bool("TTS_ENABLED", False)
    tts_model_name: str = os.getenv("TTS_MODEL_NAME", "tts_models/en/ljspeech/tacotron2-DDC_ph")

    cors_origins: list[str] = field(
        default_factory=lambda: _env_csv(
            "CORS_ORIGINS",
            "http://localhost:8080,http://127.0.0.1:8080,http://localhost:8081,http://127.0.0.1:8081,http://localhost:5173,http://127.0.0.1:5173",
        ),
    )


settings = Settings()
