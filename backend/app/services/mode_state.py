from __future__ import annotations

import asyncio

from app.schemas import ModeLiteral


class ModeState:
    def __init__(self, default_mode: ModeLiteral = "smart") -> None:
        self._mode: ModeLiteral = default_mode
        self._lock = asyncio.Lock()

    async def get_mode(self) -> ModeLiteral:
        async with self._lock:
            return self._mode

    async def set_mode(self, mode: ModeLiteral) -> ModeLiteral:
        async with self._lock:
            self._mode = mode
            return self._mode
