from __future__ import annotations

import asyncio
import re
from typing import Literal

import httpx
from cachetools import TTLCache

from app.config import Settings
from app.schemas import ModeLiteral
from app.services.ollama_client import OllamaClient
from app.services.openrouter_client import OpenRouterClient

RouteSource = Literal["openrouter", "ollama"]


class AIRouterService:
    """Cost and speed aware request router for online/offline/smart modes."""

    def __init__(
        self,
        settings: Settings,
        openrouter_client: OpenRouterClient,
        ollama_client: OllamaClient,
    ) -> None:
        self.settings = settings
        self.openrouter_client = openrouter_client
        self.ollama_client = ollama_client
        self.cache: TTLCache[str, str] = TTLCache(
            maxsize=settings.cache_max_entries,
            ttl=settings.cache_ttl_seconds,
        )
        self._cache_lock = asyncio.Lock()

    async def route_request(
        self,
        text: str,
        mode: ModeLiteral,
        history: list[dict[str, str]] | None = None,
    ) -> tuple[str, RouteSource]:
        normalized = " ".join(text.strip().split())
        if not normalized:
            return "Please share a valid prompt.", "openrouter"

        cache_key = f"{mode}:{normalized.lower()}"
        cached = await self._cache_get(cache_key)
        if cached is not None:
            return cached, "openrouter"

        if mode == "offline":
            answer, source = await self._offline_only(normalized)
        elif mode == "online":
            answer, source = await self._online_with_fallback(normalized, history)
        else:
            answer, source = await self._smart_route(normalized, history)

        await self._cache_set(cache_key, answer)
        return answer, source

    async def _cache_get(self, key: str) -> str | None:
        async with self._cache_lock:
            return self.cache.get(key)

    async def _cache_set(self, key: str, value: str) -> None:
        async with self._cache_lock:
            self.cache[key] = value

    async def _offline_only(self, text: str) -> tuple[str, RouteSource]:
        try:
            response = await self.ollama_client.generate(
                text,
                model=self.settings.ollama_model,
                timeout_s=self.settings.ollama_timeout_s,
            )
            return response, "ollama"
        except Exception:
            try:
                fallback_response = await self.ollama_client.generate(
                    text,
                    model=self.settings.ollama_fallback_model,
                    timeout_s=self.settings.ollama_timeout_s,
                )
                return fallback_response, "ollama"
            except Exception:
                return (
                    "Offline model is unavailable right now. Please try online mode.",
                    "ollama",
                )

    async def _online_with_fallback(
        self,
        text: str,
        history: list[dict[str, str]] | None,
    ) -> tuple[str, RouteSource]:
        try:
            response = await asyncio.wait_for(
                self.openrouter_client.chat(text, history=history),
                timeout=self.settings.openrouter_timeout_s,
            )
            return response, "openrouter"
        except (asyncio.TimeoutError, httpx.HTTPError, RuntimeError):
            offline_response, _ = await self._offline_only(text)
            return offline_response, "ollama"

    async def _smart_route(
        self,
        text: str,
        history: list[dict[str, str]] | None,
    ) -> tuple[str, RouteSource]:
        if self._is_simple_query(text):
            try:
                online = await asyncio.wait_for(
                    self.openrouter_client.chat(text, history=history),
                    timeout=self.settings.openrouter_timeout_s,
                )
                return online, "openrouter"
            except Exception:
                try:
                    quick_offline = await asyncio.wait_for(
                        self.ollama_client.generate(
                            text,
                            model=self.settings.ollama_model,
                            timeout_s=min(4.0, self.settings.ollama_timeout_s),
                        ),
                        timeout=4.2,
                    )
                    return quick_offline, "ollama"
                except Exception:
                    return await self._online_with_fallback(text, history)

        try:
            online = await asyncio.wait_for(
                self.openrouter_client.chat(text, history=history),
                timeout=self.settings.openrouter_timeout_s,
            )
            return online, "openrouter"
        except (asyncio.TimeoutError, httpx.HTTPError, RuntimeError):
            fallback_offline, _ = await self._offline_only(text)
            return fallback_offline, "ollama"

    def _is_simple_query(self, text: str) -> bool:
        stripped = text.strip()
        words = stripped.split()
        if len(words) <= 10 and len(stripped) < 75:
            return True

        complexity_markers = re.compile(
            r"\b(compare|analyze|explain|architecture|optimize|design|code|debug|tradeoff|strategy)\b",
            flags=re.IGNORECASE,
        )
        if complexity_markers.search(stripped):
            return False

        sentence_count = stripped.count(".") + stripped.count("?") + stripped.count("!")
        return sentence_count <= 1 and len(words) <= 14
