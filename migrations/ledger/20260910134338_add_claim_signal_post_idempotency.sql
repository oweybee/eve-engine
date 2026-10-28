-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260910134338, name add_claim_signal_post_idempotency. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Atomic publish claim for posted_signals.
-- Returns the new ledger row id if THIS caller won the claim, NULL if the
-- signal was already published to this channel. Callers must send to the
-- channel only when a non-null id comes back.
-- Additive: nothing reads or depends on this yet. No RLS change.

create or replace function public.claim_signal_post(
  p_signal_id    uuid,
  p_channel      text,
  p_message_hash text,
  p_run_id       text default null
) returns uuid
language sql
volatile
as $$
  insert into public.posted_signals (signal_id, channel, message_hash, run_id)
  values (p_signal_id, p_channel, p_message_hash, p_run_id)
  on conflict (signal_id, channel) do nothing
  returning id;
$$;

comment on function public.claim_signal_post is
  'Atomically claims the right to publish a signal to a channel. Returns the ledger row id on a successful claim, NULL if already published. Send only on non-null. Release with release_signal_post() if the send fails.';

-- Release a claim when the channel send fails, so the next run retries.
create or replace function public.release_signal_post(
  p_claim_id uuid
) returns boolean
language sql
volatile
as $$
  with d as (
    delete from public.posted_signals
    where id = p_claim_id and external_msg_id is null
    returning 1
  )
  select exists (select 1 from d);
$$;

comment on function public.release_signal_post is
  'Deletes an unconfirmed claim (external_msg_id still null) after a failed channel send. Refuses to delete a confirmed publication.';

-- Record the channel message id once the send succeeds. This is the only
-- field a caller may update on an existing ledger row; posted_at is the
-- record of first publication and must never move.
create or replace function public.confirm_signal_post(
  p_claim_id       uuid,
  p_external_msg_id text
) returns boolean
language sql
volatile
as $$
  with u as (
    update public.posted_signals
    set external_msg_id = p_external_msg_id
    where id = p_claim_id
    returning 1
  )
  select exists (select 1 from u);
$$;

revoke all on function public.claim_signal_post(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.release_signal_post(uuid) from public, anon, authenticated;
revoke all on function public.confirm_signal_post(uuid, text) from public, anon, authenticated;

grant execute on function public.claim_signal_post(uuid, text, text, text) to service_role;
grant execute on function public.release_signal_post(uuid) to service_role;
grant execute on function public.confirm_signal_post(uuid, text) to service_role;
