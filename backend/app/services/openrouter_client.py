from __future__ import annotations

from typing import Any

import httpx

from app.config import Settings


class OpenRouterClient:
    def __init__(self, http_client: httpx.AsyncClient, settings: Settings) -> None:
        self.http_client = http_client
        self.settings = settings

    async def chat(
        self,
        text: str,
        history: list[dict[str, str]] | None = None,
        timeout_s: float | None = None,
    ) -> str:
        if not self.settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not configured")

        system_prompt = (
            "You are ZARA AI, a concise voice-first assistant. "
            "Return direct and practical answers with minimal filler."
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": text})

        payload = {
            "model": self.settings.openrouter_model,
            "messages": messages,
            "temperature": 0.4,
            "max_tokens": 320,
        }

        headers = {
            "Authorization": f"Bearer {self.settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "X-Title": self.settings.app_name,
        }

        response = await self.http_client.post(
            "/chat/completions",
            headers=headers,
            json=payload,
            timeout=timeout_s or self.settings.openrouter_timeout_s,
        )
        response.raise_for_status()

        data = response.json()
        choices = data.get("choices") or []
        if not choices:
            raise RuntimeError("OpenRouter returned no choices")

        message = choices[0].get("message") or {}
        content = message.get("content")
        text_out = self._extract_text(content)
        if not text_out:
            raise RuntimeError("OpenRouter returned an empty response")
        return text_out

    def _extract_text(self, content: Any) -> str:
        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    text = block.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            return "\n".join(parts).strip()

        return ""
