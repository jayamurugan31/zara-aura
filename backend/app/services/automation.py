from __future__ import annotations

import asyncio
import datetime as dt
import re
import urllib.parse
import webbrowser
from typing import TYPE_CHECKING, Any

from app.config import Settings

if TYPE_CHECKING:
    from app.services.mcp_service import MCPService


class AutomationEngine:
    """Safe rule-based automation. No arbitrary command execution."""

    YOUTUBE_RE = re.compile(
        r"\b(open|launch|start|visit|go to)\s+(youtube|yt)\b|\b(youtube|yt)\s+(open|launch)\b|\b(abrir|abre)\s+youtube\b|\b(ouvrir|ouvre)\s+youtube\b",
        re.IGNORECASE,
    )
    YOUTUBE_PLAY_RE = re.compile(
        r"\b(play|put on|search|find|look up)\s+(?P<query>.+?)\s+(on|in)\s+(youtube|yt)\b",
        re.IGNORECASE,
    )
    SPOTIFY_RE = re.compile(
        r"\b(open|launch|start|visit)\s+spotify\b|\b(abrir|abre)\s+spotify\b|\b(ouvrir|ouvre)\s+spotify\b",
        re.IGNORECASE,
    )
    SPOTIFY_PLAY_RE = re.compile(
        r"\b(play|put on|search|find)\s+(?P<query>.+?)\s+(on|in)\s+spotify\b",
        re.IGNORECASE,
    )
    SPOTIFY_MUSIC_RE = re.compile(r"\b(play|start)\s+(some\s+)?(music|songs?)\s+(on|in)\s+spotify\b", re.IGNORECASE)
    MAPS_RE = re.compile(r"\b(open|launch|start)\s+(google\s+)?maps\b", re.IGNORECASE)
    NAVIGATE_RE = re.compile(r"\b(navigate|directions?|route)\s+(to\s+)?(?P<destination>.+)$", re.IGNORECASE)
    GMAIL_RE = re.compile(r"\b(open|launch)\s+gmail\b", re.IGNORECASE)
    GOOGLE_RE = re.compile(r"\b(open|launch)\s+google\b", re.IGNORECASE)
    GITHUB_RE = re.compile(r"\b(open|launch)\s+github\b", re.IGNORECASE)
    GENERIC_SITE_RE = re.compile(
        r"\b(open|launch|visit)\s+(?P<domain>(?:[a-z0-9-]+\.)+[a-z]{2,})(?P<path>/[^\s]*)?\b",
        re.IGNORECASE,
    )
    SEARCH_RE = re.compile(r"\b(search|find|look up)\s+(for\s+)?(?P<query>.+)", re.IGNORECASE)
    TIME_RE = re.compile(r"\b(what(?:'s| is)?\s+the\s+time|current\s+time)\b", re.IGNORECASE)
    DATE_RE = re.compile(r"\b(what(?:'s| is)?\s+the\s+date|today'?s\s+date)\b", re.IGNORECASE)

    def __init__(self, settings: Settings, mcp_service: MCPService | None = None) -> None:
        self.settings = settings
        self.mcp_service = mcp_service

    async def detect_and_execute(self, text: str, language_code: str | None = None) -> dict[str, Any] | None:
        normalized = text.strip()
        if not normalized:
            return None

        spotify_play_match = self.SPOTIFY_PLAY_RE.search(normalized)
        if spotify_play_match:
            query = spotify_play_match.group("query").strip()
            if query:
                url = f"https://open.spotify.com/search/{urllib.parse.quote(query)}"
                result = await self._open_url(url, action_type="spotify_play", intent="Play track on Spotify")
                result["query"] = query
                return self._with_language(result, language_code)

        if self.SPOTIFY_MUSIC_RE.search(normalized):
            result = await self._open_url(
                "https://open.spotify.com/genre/0JQ5DAqbMKFQ00XGBls6ym",
                action_type="spotify_music",
                intent="Play music on Spotify",
            )
            return self._with_language(result, language_code)

        if self.SPOTIFY_RE.search(normalized):
            result = await self._open_url(
                "https://open.spotify.com",
                action_type="open_spotify",
                intent="Open Spotify",
            )
            return self._with_language(result, language_code)

        youtube_play_match = self.YOUTUBE_PLAY_RE.search(normalized)
        if youtube_play_match:
            query = youtube_play_match.group("query").strip()
            if query:
                url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}"
                result = await self._open_url(url, action_type="youtube_play", intent="Play video on YouTube")
                result["query"] = query
                return self._with_language(result, language_code)

        if self.YOUTUBE_RE.search(normalized):
            result = await self._open_url("https://www.youtube.com", action_type="open_youtube", intent="Open YouTube")
            return self._with_language(result, language_code)

        navigate_match = self.NAVIGATE_RE.search(normalized)
        if navigate_match:
            destination = navigate_match.group("destination").strip()
            if destination:
                url = f"https://www.google.com/maps/search/{urllib.parse.quote_plus(destination)}"
                result = await self._open_url(url, action_type="open_maps", intent="Open map directions")
                result["destination"] = destination
                return self._with_language(result, language_code)

        if self.MAPS_RE.search(normalized):
            result = await self._open_url(
                "https://www.google.com/maps",
                action_type="open_maps",
                intent="Open Google Maps",
            )
            return self._with_language(result, language_code)

        if self.GMAIL_RE.search(normalized):
            result = await self._open_url("https://mail.google.com", action_type="open_gmail", intent="Open Gmail")
            return self._with_language(result, language_code)

        if self.GITHUB_RE.search(normalized):
            result = await self._open_url("https://github.com", action_type="open_github", intent="Open GitHub")
            return self._with_language(result, language_code)

        if self.GOOGLE_RE.search(normalized):
            result = await self._open_url("https://www.google.com", action_type="open_google", intent="Open Google")
            return self._with_language(result, language_code)

        generic_site_match = self.GENERIC_SITE_RE.search(normalized)
        if generic_site_match:
            domain = generic_site_match.group("domain").strip().lower()
            path = (generic_site_match.group("path") or "").strip()
            url = f"https://{domain}{path}"
            result = await self._open_url(url, action_type="open_website", intent="Open website")
            result["domain"] = domain
            return self._with_language(result, language_code)

        search_match = self.SEARCH_RE.search(normalized)
        if search_match:
            query = search_match.group("query").strip()
            if query:
                url = f"https://duckduckgo.com/?q={urllib.parse.quote_plus(query)}"
                result = await self._open_url(url, action_type="web_search", intent="Run web search")
                result["query"] = query
                return self._with_language(result, language_code)

        if self.TIME_RE.search(normalized):
            current_time = dt.datetime.now().strftime("%H:%M")
            return self._with_language(
                {
                "type": "system_time",
                "status": "resolved",
                "value": current_time,
                },
                language_code,
            )

        if self.DATE_RE.search(normalized):
            current_date = dt.datetime.now().strftime("%Y-%m-%d")
            return self._with_language(
                {
                "type": "system_date",
                "status": "resolved",
                "value": current_date,
                },
                language_code,
            )

        return None

    def _with_language(self, payload: dict[str, Any], language_code: str | None) -> dict[str, Any]:
        if language_code:
            payload["language"] = language_code
        return payload

    async def _open_url(self, url: str, action_type: str, intent: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": action_type,
            "status": "planned",
            "target": url,
            "intent": intent,
            "mcp_server": "zara-browser-mcp",
            "mcp_tool": self.settings.mcp_open_url_tool,
            "mcp_url": url,
        }

        if not self.settings.automation_execute:
            return payload

        if self.mcp_service and self.mcp_service.enabled:
            mcp_result = await self.mcp_service.call_tool(
                tool_name=self.settings.mcp_open_url_tool,
                arguments={
                    "url": url,
                    "new_tab": True,
                    "intent": intent,
                },
            )

            payload["status"] = "executed" if bool(mcp_result.get("ok")) else "failed"
            payload["mcp_transport"] = self.mcp_service.transport

            if mcp_result.get("result") is not None:
                payload["mcp_result"] = mcp_result.get("result")
            if mcp_result.get("error"):
                payload["error"] = mcp_result.get("error")

            if payload["status"] == "failed":
                try:
                    await asyncio.to_thread(webbrowser.open_new_tab, url)
                    payload["status"] = "executed_fallback"
                    payload["executor"] = "local_browser"
                except Exception as exc:
                    payload["fallback_error"] = str(exc)

            return payload

        try:
            await asyncio.to_thread(webbrowser.open_new_tab, url)
            payload["status"] = "executed"
            payload["executor"] = "local_browser"
        except Exception as exc:
            payload["status"] = "failed"
            payload["error"] = str(exc)

        return payload
