import re

from src.discovery.models import LumaEvent


def score_event(
    event: LumaEvent,
    tech_keywords: list[str],
    exclude_keywords: list[str],
) -> tuple[float, list[str]]:
    text = " ".join(
        [
            event.title,
            event.organizer,
            event.venue,
            event.city,
            event.query,
        ]
    ).lower()

    matched: list[str] = []
    score = 0.0

    for kw in exclude_keywords:
        if kw.lower() in text:
            return 0.0, []

    for kw in tech_keywords:
        pattern = r"\b" + re.escape(kw.lower()) + r"\b"
        if re.search(pattern, text):
            matched.append(kw)
            score += 12.0

    title_lower = event.title.lower()
    for kw in tech_keywords:
        pattern = r"\b" + re.escape(kw.lower()) + r"\b"
        if re.search(pattern, title_lower):
            score += 8.0

    if event.query:
        score += 5.0

    if "san francisco" in text or event.city.lower() == "san francisco":
        score += 5.0

    return min(score, 100.0), matched


def classify_events(
    events: list[LumaEvent],
    tech_keywords: list[str],
    exclude_keywords: list[str],
    min_score: float = 25.0,
) -> list[LumaEvent]:
    scored: list[LumaEvent] = []

    for event in events:
        score, matched = score_event(event, tech_keywords, exclude_keywords)
        event.relevance_score = score
        event.matched_keywords = matched
        if score >= min_score:
            scored.append(event)

    scored.sort(key=lambda e: (-e.relevance_score, e.start_at))
    return scored


def filter_registerable(
    events: list[LumaEvent],
    *,
    free_only: bool = True,
    skip_sold_out: bool = True,
    skip_waitlist: bool = False,
    skip_approval_required: bool = True,
) -> list[LumaEvent]:
    result: list[LumaEvent] = []

    for event in events:
        if free_only and not event.is_free:
            continue
        if skip_sold_out and event.is_sold_out:
            continue
        if skip_waitlist and event.waitlist_active:
            continue
        if skip_approval_required and event.require_approval:
            continue
        if event.registration_availability not in ("open", "waitlist"):
            continue
        result.append(event)

    return result
