from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class LumaEvent:
    id: str
    title: str
    url: str
    slug: str
    start_at: datetime
    end_at: datetime | None
    timezone: str
    city: str
    venue: str
    organizer: str
    is_free: bool
    is_sold_out: bool
    require_approval: bool
    registration_availability: str
    waitlist_active: bool
    guest_count: int | None
    relevance_score: float = 0.0
    matched_keywords: list[str] = field(default_factory=list)
    query: str = ""

    @property
    def luma_url(self) -> str:
        return f"https://lu.ma/{self.slug}"

    @property
    def is_registerable(self) -> bool:
        if not self.is_free:
            return False
        if self.is_sold_out:
            return False
        if self.registration_availability == "closed":
            return False
        return True


def parse_event(entry: dict[str, Any], query: str = "") -> LumaEvent | None:
    event = entry.get("event") or {}
    ticket = entry.get("ticket_info") or {}
    geo = event.get("geo_address_info") or {}
    calendar = entry.get("calendar") or {}

    slug = event.get("url") or ""
    if not slug:
        return None

    start_raw = event.get("start_at") or entry.get("start_at")
    if not start_raw:
        return None

    start_at = datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
    end_raw = event.get("end_at")
    end_at = (
        datetime.fromisoformat(end_raw.replace("Z", "+00:00")) if end_raw else None
    )

    venue_parts = [
        geo.get("full_address"),
        geo.get("short_address"),
        geo.get("city_state"),
        geo.get("city"),
    ]
    venue = next((p for p in venue_parts if p), "San Francisco")

    return LumaEvent(
        id=event.get("api_id") or entry.get("api_id") or slug,
        title=event.get("name") or "Untitled",
        url=f"https://lu.ma/{slug}",
        slug=slug,
        start_at=start_at,
        end_at=end_at,
        timezone=event.get("timezone") or "America/Los_Angeles",
        city=geo.get("city") or "San Francisco",
        venue=venue,
        organizer=calendar.get("name") or "",
        is_free=bool(ticket.get("is_free", False)),
        is_sold_out=bool(ticket.get("is_sold_out", False)),
        require_approval=bool(ticket.get("require_approval", False)),
        registration_availability=entry.get("registration_availability") or "unknown",
        waitlist_active=bool(entry.get("waitlist_active", False)),
        guest_count=entry.get("guest_count"),
        query=query,
    )
