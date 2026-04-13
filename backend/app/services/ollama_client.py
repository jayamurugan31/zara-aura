from __future__ import annotations

import httpx

from app.config import Settings


class OllamaClient:
    def __init__(self, http_client: httpx.AsyncClient, settings: Settings) -> None:
        self.http_client = http_client
        self.settings = settings

    async def generate(
        self,
        prompt: str,
        model: str | None = None,
        timeout_s: float | None = None,
    ) -> str:
        payload = {
            "model": model or self.settings.ollama_model,
            "prompt": prompt,
            "system": (
                "You are ZARA AI, a helpful conversational assistant. "
                "Respond in natural complete sentences and avoid one-word answers unless explicitly requested."
            ),
            "stream": False,
            "options": {
                "temperature": 0.6,
                "num_ctx": self.settings.ollama_num_ctx,
                "num_predict": self.settings.ollama_num_predict,
                "top_k": 20,
            },
        }

        response = await self.http_client.post(
            "/api/generate",
            json=payload,
            timeout=timeout_s or self.settings.ollama_timeout_s,
        )
        response.raise_for_status()

        data = response.json()
        text = (data.get("response") or "").strip()
        if not text:
            raise RuntimeError("Ollama returned an empty response")
        return text
