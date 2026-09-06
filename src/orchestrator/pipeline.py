import asyncio
from dataclasses import dataclass

from rich.console import Console
from rich.table import Table

from src.browser.register import LumaRegistrar, RegistrationResult
from src.browser.session import BrowserSession
from src.config import load_yaml
from src.discovery.classifier import classify_events, filter_registerable
from src.discovery.luma_api import LumaDiscoveryClient
from src.discovery.models import LumaEvent
from src.storage.db import EventStore

console = Console()


@dataclass
class RunSummary:
    discovered: int
    relevant: int
    registerable: int
    registered: int
    skipped: int
    failed: int


class LumaAgent:
    def __init__(self):
        self.filters = load_yaml("filters.yaml")
        self.profile = load_yaml("profile.yaml")
        self.store = EventStore()
        self.discovery = LumaDiscoveryClient(
            place_id=self.filters.get("city_place_id", "discplace-BDj7GNbGlsF7Cka")
        )

    def discover(self) -> list[LumaEvent]:
        queries = self.filters.get("search_queries", ["AI", "tech"])
        max_pages = self.filters.get("max_pages_per_query", 3)

        console.print("[bold]Discovering events in San Francisco...[/bold]")
        events = self.discovery.search_multiple_queries(queries, max_pages=max_pages)
        console.print(f"  Found {len(events)} raw events")

        relevant = classify_events(
            events,
            tech_keywords=self.filters.get("tech_keywords", []),
            exclude_keywords=self.filters.get("exclude_keywords", []),
            min_score=self.filters.get("min_relevance_score", 25),
        )
        console.print(f"  {len(relevant)} match AI/Tech criteria")

        registerable = filter_registerable(
            relevant,
            free_only=self.filters.get("free_only", True),
            skip_sold_out=self.filters.get("skip_sold_out", True),
            skip_waitlist=self.filters.get("skip_waitlist", False),
            skip_approval_required=self.filters.get("skip_approval_required", True),
        )
        console.print(f"  {len(registerable)} are free and registerable")

        for event in relevant:
            self.store.upsert_discovered(
                event.id,
                event.title,
                event.slug,
                event.luma_url,
                event.start_at,
                event.is_free,
                event.relevance_score,
            )

        return registerable

    def print_events(self, events: list[LumaEvent]) -> None:
        table = Table(title="SF AI/Tech Events (Free)")
        table.add_column("Score", style="cyan")
        table.add_column("Date")
        table.add_column("Title")
        table.add_column("Status")
        table.add_column("URL")

        for event in events:
            status = event.registration_availability
            if event.waitlist_active:
                status = "waitlist"
            table.add_row(
                f"{event.relevance_score:.0f}",
                event.start_at.strftime("%b %d %H:%M"),
                event.title[:50],
                status,
                event.luma_url,
            )

        console.print(table)

    async def register_events(
        self,
        events: list[LumaEvent],
        *,
        dry_run: bool = False,
    ) -> RunSummary:
        session = BrowserSession()
        registrar = LumaRegistrar(self.profile)
        delay = self.filters.get("registration_delay_seconds", 45)
        max_regs = self.filters.get("max_registrations_per_run", 10)

        registered = skipped = failed = 0

        try:
            await session.start()
            page = await session.new_page()

            console.print("[bold]Connected to Chrome — opened a new Luma tab[/bold]")
            console.print("[bold]Checking Luma login...[/bold]")
            if not await session.is_logged_in(page):
                console.print(
                    "[yellow]Not logged in. Sign in to Luma in the Chrome tab that opened, "
                    "then run the command again.[/yellow]"
                )
                await asyncio.sleep(60)
                if not await session.is_logged_in(page):
                    return RunSummary(len(events), len(events), len(events), 0, 0, 0)

            console.print("[green]Logged in to Luma[/green]")

            count = 0
            for event in events:
                if count >= max_regs:
                    console.print(f"[yellow]Reached max registrations per run ({max_regs})[/yellow]")
                    break

                if self.store.is_registered(event.id):
                    console.print(f"  [dim]Skip (already registered): {event.title}[/dim]")
                    skipped += 1
                    continue

                console.print(f"\n[bold]Registering:[/bold] {event.title}")
                console.print(f"  {event.luma_url}")

                result: RegistrationResult = await registrar.register(
                    page, event.luma_url, dry_run=dry_run
                )

                if result.success:
                    if not dry_run:
                        self.store.mark_registered(event.id)
                    console.print(f"  [green]✓ {result.message}[/green]")
                    registered += 1
                    count += 1
                else:
                    if result.status.startswith("skipped"):
                        self.store.mark_skipped(event.id, result.message)
                        console.print(f"  [yellow]– {result.message}[/yellow]")
                        skipped += 1
                    else:
                        self.store.mark_failed(event.id, result.message)
                        console.print(f"  [red]✗ {result.message}[/red]")
                        failed += 1

                if not dry_run and count < max_regs:
                    console.print(f"  Waiting {delay}s before next registration...")
                    await asyncio.sleep(delay)

        finally:
            await session.close()

        return RunSummary(
            discovered=len(events),
            relevant=len(events),
            registerable=len(events),
            registered=registered,
            skipped=skipped,
            failed=failed,
        )

    async def run(self, *, dry_run: bool = False) -> RunSummary:
        events = self.discover()
        self.print_events(events)

        if not events:
            console.print("[yellow]No registerable events found.[/yellow]")
            return RunSummary(0, 0, 0, 0, 0, 0)

        if dry_run:
            console.print("\n[bold yellow]Dry run — no registrations will be submitted[/bold yellow]")

        return await self.register_events(events, dry_run=dry_run)
