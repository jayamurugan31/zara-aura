from __future__ import annotations

import asyncio
from typing import TypedDict


class Message(TypedDict):
    role: str
    content: str


class MemoryStore:
    """In-memory short history store (last N messages)."""

    def __init__(self, limit: int = 5) -> None:
        self.limit = limit
        self._messages: list[Message] = []
        self._lock = asyncio.Lock()

    async def add_message(self, role: str, content: str) -> None:
        async with self._lock:
            self._messages.append({"role": role, "content": content})
            if len(self._messages) > self.limit:
                self._messages = self._messages[-self.limit :]

    async def get_messages(self) -> list[Message]:
        async with self._lock:
            return list(self._messages)

    async def add_turn(self, user_text: str, assistant_text: str) -> None:
        await self.add_message("user", user_text)
        await self.add_message("assistant", assistant_text)
