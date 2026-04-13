from __future__ import annotations

import asyncio
import json
import shlex
import uuid
from typing import Any

import httpx

from app.config import Settings


class MCPService:
    """Minimal MCP tool caller supporting HTTP, WebSocket, and stdio transports."""

    def __init__(self, settings: Settings) -> None:
        self.enabled = settings.mcp_enabled
        self.transport = (settings.mcp_transport or "http").strip().lower()
        self.http_url = settings.mcp_http_url
        self.ws_url = settings.mcp_ws_url
        self.stdio_command = settings.mcp_stdio_command
        self.auth_mode = (settings.mcp_auth_mode or "none").strip().lower()
        self.auth_header = settings.mcp_auth_header or "Authorization"
        self.auth_token = settings.mcp_auth_token
        self.timeout_s = settings.mcp_timeout_s

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            return {"ok": False, "error": "mcp_disabled"}

        if not tool_name.strip():
            return {"ok": False, "error": "tool_name_missing"}

        try:
            if self.transport == "http":
                result = await self._call_http(tool_name, arguments)
            elif self.transport in {"ws", "websocket"}:
                result = await self._call_websocket(tool_name, arguments)
            elif self.transport == "stdio":
                result = await self._call_stdio(tool_name, arguments)
            else:
                return {"ok": False, "error": f"unsupported_transport:{self.transport}"}

            return {"ok": True, "result": result}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _build_payload(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": method,
            "params": params,
        }

    def _build_notification(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}

        if self.auth_mode == "bearer" and self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        elif self.auth_mode == "header" and self.auth_token:
            headers[self.auth_header] = self.auth_token

        return headers

    def _extract_result(self, data: Any) -> Any:
        if isinstance(data, dict):
            error = data.get("error")
            if error:
                raise RuntimeError(str(error))

            if "result" in data:
                return data["result"]

        return data

    async def _call_http(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        if not self.http_url:
            raise RuntimeError("MCP_HTTP_URL is not configured")

        payload = self._build_payload(
            method="tools/call",
            params={"name": tool_name, "arguments": arguments},
        )

        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            response = await client.post(self.http_url, json=payload, headers=self._headers())
            response.raise_for_status()
            try:
                data = response.json()
            except ValueError:
                return response.text

        return self._extract_result(data)

    async def _call_websocket(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        if not self.ws_url:
            raise RuntimeError("MCP_WS_URL is not configured")

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("websockets dependency is required for MCP WebSocket transport") from exc

        payload = self._build_payload(method="tools/call", params={"name": tool_name, "arguments": arguments})

        async with websockets.connect(self.ws_url, extra_headers=self._headers()) as websocket:
            await self._initialize_websocket(websocket)

            await websocket.send(json.dumps(payload))
            raw = await asyncio.wait_for(websocket.recv(), timeout=self.timeout_s)
            data = json.loads(raw)

        return self._extract_result(data)

    async def _initialize_websocket(self, websocket: Any) -> None:
        initialize_payload = self._build_payload(
            method="initialize",
            params={
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "zara-aura", "version": "0.1.0"},
                "capabilities": {},
            },
        )

        await websocket.send(json.dumps(initialize_payload))
        init_raw = await asyncio.wait_for(websocket.recv(), timeout=self.timeout_s)
        init_data = json.loads(init_raw)
        self._extract_result(init_data)

        await websocket.send(json.dumps(self._build_notification("notifications/initialized")))

    async def _call_stdio(self, tool_name: str, arguments: dict[str, Any]) -> Any:
        command = self.stdio_command.strip()
        if not command:
            raise RuntimeError("MCP_STDIO_COMMAND is not configured")

        parts = shlex.split(command, posix=False)
        if not parts:
            raise RuntimeError("MCP_STDIO_COMMAND is empty")

        payload = self._build_payload(
            method="tools/call",
            params={"name": tool_name, "arguments": arguments},
        )

        process = await asyncio.create_subprocess_exec(
            *parts,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            if process.stdin is None or process.stdout is None:
                raise RuntimeError("Failed to open stdio pipes for MCP command")

            initialize_payload = self._build_payload(
                method="initialize",
                params={
                    "protocolVersion": "2024-11-05",
                    "clientInfo": {"name": "zara-aura", "version": "0.1.0"},
                    "capabilities": {},
                },
            )

            await self._stdio_send(process, initialize_payload)
            init_data = await self._stdio_recv(process)
            self._extract_result(init_data)

            await self._stdio_send(process, self._build_notification("notifications/initialized"))

            await self._stdio_send(process, payload)
            data = await self._stdio_recv(process)
            return self._extract_result(data)
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()

    async def _stdio_send(self, process: asyncio.subprocess.Process, payload: dict[str, Any]) -> None:
        if process.stdin is None:
            raise RuntimeError("MCP stdio stdin is unavailable")
        process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await process.stdin.drain()

    async def _stdio_recv(self, process: asyncio.subprocess.Process) -> dict[str, Any]:
        if process.stdout is None:
            raise RuntimeError("MCP stdio stdout is unavailable")

        line = await asyncio.wait_for(process.stdout.readline(), timeout=self.timeout_s)
        if not line:
            stderr_text = ""
            if process.stderr is not None:
                stderr_text = (await process.stderr.read()).decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"No MCP response over stdio. stderr={stderr_text}")

        return json.loads(line.decode("utf-8", errors="replace").strip())
