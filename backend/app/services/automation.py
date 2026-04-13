from __future__ import annotations

import asyncio
import datetime as dt
import re
import urllib.parse
import webbrowser

from app.config import Settings


class AutomationEngine:
    """Safe rule-based automation. No arbitrary command execution."""

    YOUTUBE_RE = re.compile(r"\b(open|launch)\s+youtube\b", re.IGNORECASE)
    SEARCH_RE = re.compile(r"\b(search|find|look up)\s+(for\s+)?(?P<query>.+)", re.IGNORECASE)
    TIME_RE = re.compile(r"\b(what(?:'s| is)?\s+the\s+time|current\s+time)\b", re.IGNORECASE)
    DATE_RE = re.compile(r"\b(what(?:'s| is)?\s+the\s+date|today'?s\s+date)\b", re.IGNORECASE)

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def detect_and_execute(self, text: str) -> dict[str, str] | None:
        normalized = text.strip()
        if not normalized:
            return None

        if self.YOUTUBE_RE.search(normalized):
            return await self._open_url("https://www.youtube.com", action_type="open_youtube")

        search_match = self.SEARCH_RE.search(normalized)
        if search_match:
            query = search_match.group("query").strip()
            if query:
                url = f"https://duckduckgo.com/?q={urllib.parse.quote_plus(query)}"
                result = await self._open_url(url, action_type="web_search")
                result["query"] = query
                return result

        if self.TIME_RE.search(normalized):
            current_time = dt.datetime.now().strftime("%H:%M")
            return {
                "type": "system_time",
                "status": "resolved",
                "value": current_time,
            }

        if self.DATE_RE.search(normalized):
            current_date = dt.datetime.now().strftime("%Y-%m-%d")
            return {
                "type": "system_date",
                "status": "resolved",
                "value": current_date,
            }

        return None

    async def _open_url(self, url: str, action_type: str) -> dict[str, str]:
        if self.settings.automation_execute:
            await asyncio.to_thread(webbrowser.open_new_tab, url)
            status = "executed"
        else:
            status = "planned"

        return {
            "type": action_type,
            "status": status,
            "target": url,
        }
