import asyncio
import time
from typing import Any

import httpx

from src.discovery.models import LumaEvent, parse_event

BASE_URL = "https://api2.luma.com"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Origin": "https://luma.com",
    "Referer": "https://luma.com/sf",
    "Accept": "application/json",
}

SF_PLACE_ID = "discplace-BDj7GNbGlsF7Cka"
REQUEST_DELAY = 1.2


class LumaDiscoveryClient:
    def __init__(self, place_id: str = SF_PLACE_ID):
        self.place_id = place_id
        self._last_request = 0.0

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        if elapsed < REQUEST_DELAY:
            time.sleep(REQUEST_DELAY - elapsed)
        self._last_request = time.monotonic()

    def fetch_page(
        self,
        query: str = "",
        cursor: str | None = None,
        limit: int = 40,
    ) -> dict[str, Any]:
        self._throttle()
        params: dict[str, str | int] = {
            "discover_place_api_id": self.place_id,
            "pagination_limit": limit,
        }
        if query:
            params["query"] = query
        if cursor:
            params["pagination_cursor"] = cursor

        with httpx.Client(timeout=30.0, headers=HEADERS) as client:
            resp = client.get(f"{BASE_URL}/discover/get-paginated-events", params=params)
            resp.raise_for_status()
            return resp.json()

    def search(
        self,
        query: str = "",
        max_pages: int = 3,
    ) -> list[LumaEvent]:
        events: list[LumaEvent] = []
        cursor: str | None = None

        for _ in range(max_pages):
            data = self.fetch_page(query=query, cursor=cursor)
            for entry in data.get("entries") or []:
                parsed = parse_event(entry, query=query)
                if parsed:
                    events.append(parsed)

            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
            if not cursor:
                break

        return events

    def search_multiple_queries(
        self,
        queries: list[str],
        max_pages: int = 3,
    ) -> list[LumaEvent]:
        seen: set[str] = set()
        merged: list[LumaEvent] = []

        for query in queries:
            for event in self.search(query=query, max_pages=max_pages):
                if event.id in seen:
                    continue
                seen.add(event.id)
                merged.append(event)

        return merged


async def search_events_async(
    queries: list[str],
    place_id: str = SF_PLACE_ID,
    max_pages: int = 3,
) -> list[LumaEvent]:
    client = LumaDiscoveryClient(place_id=place_id)
    return await asyncio.to_thread(client.search_multiple_queries, queries, max_pages)
