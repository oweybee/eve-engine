-- =============================================================================
-- Migration 126: the broadcast claim is on the SELECTION, not on the row id.
--
-- APPLIED AND VERIFIED IN PRODUCTION, 10 Sep 2026, under the name
-- `125_claim_the_selection_not_the_row` (version 20260910165207) — PR #116
-- had already taken 125 in the repo a few hours earlier and the collision was
-- only visible after applying. The statements are identical; the file number
-- follows the repo and the database keeps the name it recorded, the same
-- arrangement migration 059's header describes. READ THE TABLE, NOT THE
-- MIGRATION. Backfill keyed 1,114 of
-- 1,649 posted_signals rows — the other 535 (32%) are repeat posts of a
-- selection already sent, which is the incident measured from the other side.
--
-- Three independent mechanisms produced the same symptom, and each fix so far
-- closed exactly one:
--
--  1. `markPosted` upserted with ON CONFLICT DO UPDATE, so UNIQUE (signal_id,
--     channel) could never refuse anything, and the pre-send dedupe was a READ
--     truncated at PostgREST's 1000-row ceiling. An UPDATE also rewrites the
--     tuple to the end of the heap — the truncated tail — so re-sending a row
--     is what guaranteed it would be re-sent again.
--  2. `value_signals_selection_price_unique` includes `detected_odds`, so a
--     re-detection at a moved price writes a BRAND NEW row with a new id. A
--     ledger keyed on signal_id cannot recognise it as the same bet. (#116)
--  3. THREE workflows run postToX.js concurrently — engine.yml,
--     run-engine.yml, and runInplayLoop.js inside run-inplay.yml, the last on
--     a loop of up to 175 minutes that re-posts on every pass.
--
-- (3) is why a read-based selection dedupe is not enough on its own, and why
-- this is a database constraint rather than more application code: three
-- processes reading before they write all read "not posted" and all post. A
-- claim two concurrent runs can both win is not a claim.
--
-- THE KEY IS COMPUTED HERE AND NOWHERE ELSE. `market_line` is unconstrained
-- `numeric`, so 2.5 and 2.50 are both storable and `::text` renders them
-- differently; a key built in JavaScript and a key built in SQL would agree
-- until the day they did not. `trim_scale` normalises it. Application code
-- says only WHETHER to dedupe by selection, never what the key is.
--
-- Verified by probe in a rolled-back transaction against the live incident row
-- (Mariehamn v Turku PS, which carried Telegram messages 253, 254 and 268):
--   the same row re-claimed            -> NULL   (refused)
--   a NEW row id, same selection       -> NULL   (refused)  <- the #116 case
--   a mover, dedupe off                -> a claim
--   the same selection, other channel  -> a claim
--   an unseen selection                -> a claim
--
-- Additive and reversible:
--   drop index    public.posted_signals_selection_channel_unique;
--   drop function public.claim_selection_post(uuid,text,text,boolean,text);
--   drop function public.posted_selection_key(uuid);
--   alter table   public.posted_signals drop column selection_key;
-- =============================================================================

create or replace function public.posted_selection_key(p_signal_id uuid)
returns text language sql stable as $fn$
  select v.match_id::text || '|' || coalesce(v.market, 'h2h') || '|' ||
         coalesce(trim_scale(v.market_line)::text, '') || '|' || v.outcome
  from public.value_signals v where v.id = p_signal_id;
$fn$;

comment on function public.posted_selection_key(uuid) is
  'A subscriber''s identity for a signal: match|market|line|outcome. The ONLY definition of that key — never rebuild it in application code.';

alter table public.posted_signals add column if not exists selection_key text;

comment on column public.posted_signals.selection_key is
  'Set by claim_selection_post for a post that is one-per-selection. NULL means this row is not selection-deduped (an odds-movement re-alert, or a row predating migration 125).';

-- Backfill exactly ONE row per (selection, channel) — the earliest, which is
-- the record of first publication. Later repeats keep a NULL key: history is
-- preserved rather than deleted, and a partial unique index ignores NULLs.
with keyed as (
  select p.id,
         public.posted_selection_key(p.signal_id) as k,
         row_number() over (
           partition by p.channel, public.posted_selection_key(p.signal_id)
           order by p.posted_at, p.id) as rn
  from public.posted_signals p
)
update public.posted_signals p set selection_key = keyed.k
from keyed where keyed.id = p.id and keyed.rn = 1 and keyed.k is not null;

create unique index if not exists posted_signals_selection_channel_unique
  on public.posted_signals (selection_key, channel) where selection_key is not null;

-- ON CONFLICT with NO TARGET, deliberately: it catches BOTH unique
-- constraints — the row-level (signal_id, channel) from migration 015 and the
-- selection-level one above — in one atomic statement. Neither is loosened.
--
-- posted_at is never supplied. It defaults to now() and is the record of FIRST
-- publication; nothing may move it.
create or replace function public.claim_selection_post(
  p_signal_id       uuid,
  p_channel         text,
  p_message_hash    text,
  p_dedupe_selection boolean default true,
  p_run_id          text default null)
returns uuid language sql as $fn$
  insert into public.posted_signals (signal_id, channel, message_hash, run_id, selection_key)
  values (p_signal_id, p_channel, p_message_hash, p_run_id,
          case when p_dedupe_selection then public.posted_selection_key(p_signal_id) end)
  on conflict do nothing
  returning id;
$fn$;

comment on function public.claim_selection_post(uuid,text,text,boolean,text) is
  'Take the broadcast claim for a signal BEFORE sending it. Returns the claim id if this caller won, NULL if the row or the selection is already published. Atomic across concurrent runs, which a read-based dedupe is not.';

revoke all on function public.claim_selection_post(uuid,text,text,boolean,text) from public;
revoke all on function public.posted_selection_key(uuid) from public;
grant execute on function public.claim_selection_post(uuid,text,text,boolean,text) to service_role;
grant execute on function public.posted_selection_key(uuid) to service_role;
