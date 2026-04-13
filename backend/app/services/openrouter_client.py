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
        response_language: str | None = None,
        timeout_s: float | None = None,
    ) -> str:
        if not self.settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not configured")

        allowed_languages = "English, Hindi, Tamil, Telugu, Malayalam"

        if response_language:
            language_instruction = (
                f"Detected user language: {response_language}. "
                f"Reply only in {response_language}. "
                f"Do not switch to any language outside: {allowed_languages}."
            )
        else:
            language_instruction = (
                "Detect the latest user language and reply in the same language only if it is one of "
                f"{allowed_languages}. For any other language, reply in English."
            )

        system_prompt = (
            "You are ZARA AI, a warm and conversational voice-first assistant. "
            "Answer naturally in clear complete sentences, usually 2-5 sentences unless the user asks for brief output. "
            "Use recent conversation context to keep continuity and reason through follow-up questions. "
            f"{language_instruction} "
            "Never say you cannot understand or speak English, Hindi, Tamil, Telugu, or Malayalam. "
            "Avoid one-word replies except for strict yes/no requests."
        )

        messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": text})

        payload = {
            "model": self.settings.openrouter_model,
            "messages": messages,
            "temperature": self.settings.openrouter_temperature,
            "max_tokens": self.settings.openrouter_max_tokens,
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
