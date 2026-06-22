-- =============================================================================
-- Migration 015: posted_signals
-- Durable dedup ledger for outbound signal posts (Telegram, X, etc.).
-- Replaces the ephemeral .x_state.json file which is destroyed on every
-- GitHub Actions runner restart, causing duplicate posts on every cron tick.
--
-- Idempotency guarantee: UNIQUE (signal_id, channel) means upsert on that
-- constraint will never create two rows for the same signal on the same channel,
-- regardless of how many times the job re-runs.
--
-- Safe to re-run (all statements are idempotent).
-- =============================================================================

create table if not exists posted_signals (
  id               uuid        primary key default gen_random_uuid(),

  -- The signal that was posted. Cascade-delete keeps this table tidy if a
  -- signal is ever removed from value_signals (e.g. test data cleanup).
  signal_id        uuid        not null references value_signals(id) on delete cascade,

  -- Which distribution channel sent this message.
  -- Enum-like: 'telegram' | 'twitter' | 'discord'
  channel          text        not null,

  -- UTC timestamp of the successful post (not the signal detection time).
  posted_at        timestamptz not null default now(),

  -- SHA-256 hex digest of the rendered message body.
  -- If the signal's odds drift materially between runs, the hash changes and
  -- the post record is updated (and the Telegram message can be edited via
  -- external_msg_id). Prevents posting stale prices.
  message_hash     text        not null,

  -- The platform-native message identifier returned after a successful post.
  -- Telegram: message_id (integer as text). X: tweet id_str.
  -- Used for edits, deletions, and audit trail.
  external_msg_id  text,

  -- GitHub Actions $GITHUB_RUN_ID (or 'local' for manual runs).
  -- Allows pinpointing exactly which CI run sent each message.
  run_id           text,

  -- The single idempotency key. One row per signal per channel, ever.
  constraint posted_signals_signal_channel_unique unique (signal_id, channel)
);

-- Fast lookup when checking "has this signal already been posted to channel X?"
-- This is called once per signal per run before every potential post.
create index if not exists idx_posted_signals_signal_channel
  on posted_signals (signal_id, channel);

-- Fast range scan for recent posts (e.g. "what did we send in the last 24h?")
create index if not exists idx_posted_signals_posted_at
  on posted_signals (posted_at desc);

comment on table posted_signals is
  'Durable post dedup ledger. Replaces ephemeral .x_state.json. One row per signal per channel.';
comment on column posted_signals.message_hash is
  'SHA-256 of the rendered message. Hash drift triggers an edit of the existing post.';
comment on column posted_signals.external_msg_id is
  'Platform message ID (Telegram message_id, X tweet id_str) for edits and audit.';
comment on column posted_signals.run_id is
  'GitHub Actions GITHUB_RUN_ID. Allows audit of which CI run sent each message.';
