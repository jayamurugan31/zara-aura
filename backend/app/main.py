from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response

from app.config import settings
from app.schemas import AudioFeatures, ChatRequest, ChatResponse, ModeLiteral, ModeRequest, ModeResponse, TTSRequest, VoiceResponse
from app.services.ai_router import AIRouterService
from app.services.audio_features import AudioFeatureResult, AudioFeatureService
from app.services.automation import AutomationEngine
from app.services.emotion_service import EmotionService
from app.services.language_service import LanguageDetectionResult, LanguageService
from app.services.memory import MemoryStore
from app.services.mcp_service import MCPService
from app.services.mode_state import ModeState
from app.services.ollama_client import OllamaClient
from app.services.openrouter_client import OpenRouterClient
from app.services.tts_service import TTSService
from app.services.whisper_service import WhisperService


logger = logging.getLogger(__name__)


_SUPPORTED_RESPONSE_LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "hi": "Hindi",
    "ta": "Tamil",
    "te": "Telugu",
    "ml": "Malayalam",
}


def _normalize_preferred_language(language: str | None) -> str | None:
    if not language:
        return None

    lowered = language.strip().lower()
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

    normalized = aliases.get(lowered, lowered)
    return normalized if normalized in _SUPPORTED_RESPONSE_LANGUAGE_NAMES else None


def _resolve_response_language(
    detected: LanguageDetectionResult,
    preferred_code: str | None,
) -> LanguageDetectionResult:
    if not preferred_code:
        return detected

    if detected.code == preferred_code:
        return detected

    # In mixed commands like "Telugu + English query", detector can skew to English.
    # Prefer user-selected language when confidence is low or detected language falls back to English.
    if detected.code == "en" or detected.confidence < 0.78:
        return LanguageDetectionResult(
            code=preferred_code,
            name=_SUPPORTED_RESPONSE_LANGUAGE_NAMES[preferred_code],
            confidence=max(0.8, detected.confidence),
        )

    return detected


@dataclass(slots=True)
class ServiceContainer:
    memory_store: MemoryStore
    mode_state: ModeState
    language_service: LanguageService
    mcp_service: MCPService
    audio_feature_service: AudioFeatureService
    emotion_service: EmotionService
    automation_engine: AutomationEngine
    whisper_service: WhisperService
    tts_service: TTSService
    ai_router: AIRouterService


@asynccontextmanager
async def lifespan(app: FastAPI):
    default_mode: ModeLiteral = (
        settings.default_mode if settings.default_mode in {"online", "smart", "offline"} else "smart"
    )

    openrouter_http = httpx.AsyncClient(
        base_url=settings.openrouter_base_url,
        timeout=settings.openrouter_timeout_s,
        limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
    )
    ollama_http = httpx.AsyncClient(
        base_url=settings.ollama_base_url,
        timeout=settings.ollama_timeout_s,
        limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
    )

    openrouter_client = OpenRouterClient(openrouter_http, settings)
    ollama_client = OllamaClient(ollama_http, settings)
    mcp_service = MCPService(settings)

    services = ServiceContainer(
        memory_store=MemoryStore(limit=settings.memory_limit),
        mode_state=ModeState(default_mode=default_mode),
        language_service=LanguageService(),
        mcp_service=mcp_service,
        audio_feature_service=AudioFeatureService(),
        emotion_service=EmotionService(),
        automation_engine=AutomationEngine(settings, mcp_service=mcp_service),
        whisper_service=WhisperService(settings),
        tts_service=TTSService(settings),
        ai_router=AIRouterService(
            settings=settings,
            openrouter_client=openrouter_client,
            ollama_client=ollama_client,
        ),
    )

    app.state.services = services

    try:
        yield
    finally:
        await openrouter_http.aclose()
        await ollama_http.aclose()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

# Compress JSON responses to reduce bandwidth and improve mobile latency.
app.add_middleware(GZipMiddleware, minimum_size=300)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_services(request: Request) -> ServiceContainer:
    return request.app.state.services


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/mode", response_model=ModeResponse)
async def set_mode(payload: ModeRequest, request: Request) -> ModeResponse:
    services = get_services(request)
    updated_mode = await services.mode_state.set_mode(payload.mode)
    return ModeResponse(mode=updated_mode)


@app.post("/tts")
async def tts(payload: TTSRequest, request: Request) -> Response:
    services = get_services(request)
    synthesis = await services.tts_service.synthesize_bytes(payload.text, payload.language)
    if synthesis is None:
        raise HTTPException(status_code=503, detail="TTS is unavailable")

    audio_bytes, media_type = synthesis
    return Response(content=audio_bytes, media_type=media_type)


@app.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, background_tasks: BackgroundTasks, request: Request) -> ChatResponse:
    services = get_services(request)
    detected_language = services.language_service.detect(payload.text)
    preferred_language_code = _normalize_preferred_language(payload.preferred_language)
    response_language = _resolve_response_language(detected_language, preferred_language_code)

    effective_mode: ModeLiteral = payload.mode or await services.mode_state.get_mode()
    history = await services.memory_store.get_messages()

    response_text, _route = await services.ai_router.route_request(
        text=payload.text,
        mode=effective_mode,
        history=history,
        response_language=response_language.name,
    )

    action = await services.automation_engine.detect_and_execute(payload.text, language_code=response_language.code)

    volume = float(payload.volume or 0.0)
    pitch = round(110.0 + (volume * 220.0), 1)
    emotion = services.emotion_service.detect(payload.text, volume)

    await services.memory_store.add_turn(payload.text, response_text)

    if payload.synthesize:
        background_tasks.add_task(services.tts_service.synthesize_to_temp, response_text)

    return ChatResponse(
        text=response_text,
        language=response_language.code,
        emotion=emotion,
        audio_features=AudioFeatures(volume=round(volume, 3), pitch=pitch),
        action=action,
    )


@app.post("/voice", response_model=VoiceResponse)
async def voice(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    mode: ModeLiteral | None = Form(default=None),
    preferred_language: str | None = Form(default=None),
    synthesize: bool = Form(default=False),
) -> VoiceResponse:
    services = get_services(request)

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        audio_features = await services.audio_feature_service.extract_from_bytes(audio_bytes)
    except Exception as exc:
        logger.warning("Audio feature extraction failed, using neutral defaults: %s", exc)
        audio_features = AudioFeatureResult(volume=0.0, pitch=160.0, speech_rate=0.0, duration_seconds=0.0)

    if audio_features.duration_seconds > settings.max_audio_seconds:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too long. Send chunks up to {settings.max_audio_seconds} seconds.",
        )

    try:
        transcript = await services.whisper_service.transcribe_audio(audio_bytes)
    except ValueError as exc:
        detail = str(exc)
        status_code = 413 if "too long" in detail.lower() else 422
        raise HTTPException(status_code=status_code, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc

    if not transcript:
        raise HTTPException(status_code=422, detail="Could not detect speech in the provided audio")

    detected_language = services.language_service.detect(transcript)
    preferred_language_code = _normalize_preferred_language(preferred_language)
    response_language = _resolve_response_language(detected_language, preferred_language_code)

    effective_mode: ModeLiteral = mode or await services.mode_state.get_mode()
    history = await services.memory_store.get_messages()

    response_text, _route = await services.ai_router.route_request(
        text=transcript,
        mode=effective_mode,
        history=history,
        response_language=response_language.name,
    )

    action = await services.automation_engine.detect_and_execute(transcript, language_code=response_language.code)
    emotion = services.emotion_service.detect(transcript, audio_features.volume)

    await services.memory_store.add_turn(transcript, response_text)

    if synthesize:
        background_tasks.add_task(services.tts_service.synthesize_to_temp, response_text)

    return VoiceResponse(
        transcript=transcript,
        text=response_text,
        language=response_language.code,
        emotion=emotion,
        audio_features=AudioFeatures(
            volume=audio_features.volume,
            pitch=audio_features.pitch,
        ),
        action=action,
    )


@app.websocket("/ws/orb")
async def ws_orb(websocket: WebSocket) -> None:
    await websocket.accept()
    services: ServiceContainer = websocket.app.state.services

    try:
        while True:
            raw_message = await websocket.receive_text()

            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send_json({"error": "invalid_json"})
                continue

            audio_base64 = payload.get("audio_base64")
            if not isinstance(audio_base64, str) or not audio_base64:
                await websocket.send_json({"error": "audio_base64 is required"})
                continue

            try:
                features = await services.audio_feature_service.extract_from_base64(audio_base64)
            except Exception:
                await websocket.send_json({"error": "audio_processing_failed"})
                continue

            await websocket.send_json(features)
    except WebSocketDisconnect:
        return
