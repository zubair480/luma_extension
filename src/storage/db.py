import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from src.config import ensure_data_dir


class EventStore:
    def __init__(self, db_path: Path | None = None):
        ensure_data_dir()
        self.db_path = db_path or ensure_data_dir() / "luma.db"
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    url TEXT NOT NULL,
                    start_at TEXT,
                    is_free INTEGER,
                    relevance_score REAL,
                    status TEXT DEFAULT 'discovered',
                    registered_at TEXT,
                    error_message TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )

    def has_event(self, event_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM events WHERE id = ?", (event_id,)
            ).fetchone()
            return row is not None

    def is_registered(self, event_id: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT status FROM events WHERE id = ? AND status = 'registered'",
                (event_id,),
            ).fetchone()
            return row is not None

    def upsert_discovered(
        self,
        event_id: str,
        title: str,
        slug: str,
        url: str,
        start_at: datetime,
        is_free: bool,
        relevance_score: float,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO events (id, title, slug, url, start_at, is_free,
                                    relevance_score, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    relevance_score = excluded.relevance_score
                """,
                (
                    event_id,
                    title,
                    slug,
                    url,
                    start_at.isoformat(),
                    int(is_free),
                    relevance_score,
                    now,
                ),
            )

    def mark_registered(self, event_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE events SET status = 'registered', registered_at = ?,
                                  error_message = NULL
                WHERE id = ?
                """,
                (now, event_id),
            )

    def mark_failed(self, event_id: str, error: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE events SET status = 'failed', error_message = ?
                WHERE id = ?
                """,
                (error, event_id),
            )

    def mark_skipped(self, event_id: str, reason: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO events (id, title, slug, url, start_at, is_free,
                                    relevance_score, status, error_message, created_at)
                VALUES (?, ?, ?, ?, ?, 1, 0, 'skipped', ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = 'skipped', error_message = excluded.error_message
                """,
                (
                    event_id,
                    event_id,
                    event_id,
                    "",
                    datetime.now(timezone.utc).isoformat(),
                    reason,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    def list_registered(self) -> list[sqlite3.Row]:
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM events WHERE status = 'registered' ORDER BY registered_at DESC"
            ).fetchall()
