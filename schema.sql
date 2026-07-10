-- schema.sql — Scriptura's D1 schema.
--
-- Reconstructed from the SQL statements actually issued by worker.js.
-- If you already have a live `scriptura_progress` table deployed, DIFF
-- this against it before running — see the "Schema drift warning" note
-- in README.md. This file describes what the code EXPECTS to find; the
-- production database may have extra columns or slightly different
-- types (D1 is permissive about types via SQLite affinity rules).
--
-- Run this via the Cloudflare dashboard: Workers & Pages → D1 → your
-- `scriptura` database → the "Console" tab → paste and Execute. No
-- Wrangler CLI required.

CREATE TABLE IF NOT EXISTS scriptura_progress (
    -- Telegram user_id / chat_id (they're the same for private chats,
    -- which is all Scriptura supports). Used as the primary key so
    -- getUser() lookups by user_id are O(1).
    user_id         INTEGER PRIMARY KEY,

    -- ISO-8601 date string (YYYY-MM-DD) — the day the user's current
    -- reading plan started. Reset by /settings → Reset Progress and
    -- re-anchored to "today" at that point. Never NULL.
    start_date      TEXT    NOT NULL,

    -- Length of the current reading plan in days. Any value from 1 to
    -- 3650 (10 years) is legal; the built-in presets are 30/60/90/120/
    -- 180/365 and users can type any integer via the custom-days flow.
    plan_days       INTEGER NOT NULL DEFAULT 365,

    -- One of: 'direct', 'alternating', 'random', 'random_alternating'.
    -- Controls how buildBookOrder() sequences the 66 books.
    reading_mode    TEXT    NOT NULL DEFAULT 'direct',

    -- JSON array of day numbers (1-indexed) the user has marked
    -- complete. Stored as a JSON *string* because D1/SQLite has no
    -- native array type. safeParseArr() in worker.js handles the
    -- read side; every write JSON.stringify's before binding.
    completed_days  TEXT    NOT NULL DEFAULT '[]',

    -- JSON array of book indexes (0-based into the BIBLE constant in
    -- worker.js — 66 entries, Genesis=0 ... Revelation=65). Persisted
    -- once at plan creation / mode change so a "random" plan stays
    -- stable across sessions instead of reshuffling on every call.
    book_order      TEXT    NOT NULL DEFAULT '[]',

    -- Current daily reading streak (consecutive completed days ending
    -- at today or yesterday). Recomputed by calcStreak() on every
    -- mark-complete and written back here for fast reads.
    streak          INTEGER NOT NULL DEFAULT 0,

    -- ISO-8601 date the user most recently marked a day complete.
    -- Used to guard against double-completing the same day and to
    -- render "All done for today!" on the Today screen. NULL until
    -- the first completion.
    last_read_date  TEXT,

    -- Single-slot input-mode flag. Currently the only value the code
    -- writes is 'custom_days' (set when a user taps ✏️ Custom Days,
    -- cleared on next input). NULL when the bot isn't waiting on any
    -- free-text input.
    waiting_for     TEXT,

    -- Row creation timestamp. Managed by SQLite via CURRENT_TIMESTAMP;
    -- getUser() reads it but nothing in the app writes it.
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
