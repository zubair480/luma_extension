#!/usr/bin/env python3
"""Luma Agent — discover and auto-register for free AI/Tech events in SF."""

import asyncio
import sys
from pathlib import Path

import click
from rich.console import Console

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.orchestrator.pipeline import LumaAgent

console = Console()


@click.group()
def cli():
    """Luma Agent — auto-fill registration for free SF AI/Tech events."""
    pass


@cli.command()
def discover():
    """Find AI/Tech events in San Francisco (no registration)."""
    agent = LumaAgent()
    events = agent.discover()
    agent.print_events(events)


@cli.command()
@click.argument("url")
@click.option("--dry-run", is_flag=True, help="Open page but do not submit registration")
def register(url: str, dry_run: bool):
    """Register for a single Luma event URL."""
    from src.discovery.models import LumaEvent
    from datetime import datetime, timezone

    agent = LumaAgent()
    slug = url.rstrip("/").split("/")[-1]
    event = LumaEvent(
        id=slug,
        title=slug,
        url=url,
        slug=slug,
        start_at=datetime.now(timezone.utc),
        end_at=None,
        timezone="America/Los_Angeles",
        city="San Francisco",
        venue="",
        organizer="",
        is_free=True,
        is_sold_out=False,
        require_approval=False,
        registration_availability="open",
        waitlist_active=False,
        guest_count=None,
    )

    async def _run():
        return await agent.register_events([event], dry_run=dry_run)

    summary = asyncio.run(_run())
    console.print(summary)


@cli.command()
@click.option("--dry-run", is_flag=True, help="Discover and preview without registering")
def run(dry_run: bool):
    """Full pipeline: discover → filter free AI/Tech events → auto-register."""
    agent = LumaAgent()
    summary = asyncio.run(agent.run(dry_run=dry_run))
    console.print(
        f"\n[bold]Done:[/bold] {summary.registered} registered, "
        f"{summary.skipped} skipped, {summary.failed} failed"
    )


@cli.command("chrome-start")
def chrome_start():
    """Start Chrome with remote debugging (uses your normal profile & login)."""
    from src.browser.session import restart_chrome_with_debugging

    try:
        chrome = restart_chrome_with_debugging()
        console.print(f"[green]Chrome started with remote debugging[/green] ({chrome})")
        console.print("Your existing logins are preserved. You can now run: python main.py run")
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/red]")


@cli.command()
def login():
    """Open a Luma tab in your existing Chrome to verify login."""
    from src.browser.session import BrowserSession

    async def _login():
        session = BrowserSession()
        try:
            await session.start()
            page = await session.new_page()
            await page.goto("https://lu.ma/signin", wait_until="domcontentloaded")
            console.print(
                "[bold]New Chrome tab opened. Sign in to Luma if needed, "
                "then press Ctrl+C.[/bold]"
            )
            while True:
                await asyncio.sleep(5)
                if await session.is_logged_in(page):
                    console.print("[green]Login confirmed![/green]")
                    break
        finally:
            await session.close()

    asyncio.run(_login())


@cli.command()
def status():
    """Show previously registered events."""
    from src.storage.db import EventStore
    from rich.table import Table

    store = EventStore()
    rows = store.list_registered()

    if not rows:
        console.print("No registered events yet.")
        return

    table = Table(title="Registered Events")
    table.add_column("Title")
    table.add_column("Date")
    table.add_column("URL")

    for row in rows:
        table.add_row(row["title"], row["registered_at"] or "", row["url"])

    console.print(table)


if __name__ == "__main__":
    cli()
