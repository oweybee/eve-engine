-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260802145437, name preview_pricing_follows_preview_signals. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 045_preview_pricing_follows_preview_signals.sql
-- The free preview's pricing follows its signals: a visitor permitted to read a
-- detection may read the pricing for the match that detection is about.
-- Additive — preview_computed_value_ids() is untouched.

create or replace function public.preview_signal_match_ids()
returns setof uuid language sql stable security definer
set search_path = public, pg_catalog as $$
  select distinct match_id
  from public.value_signals
  where match_id is not null
    and id in (select public.preview_value_signal_ids())
$$;

revoke all on function public.preview_signal_match_ids() from public;
grant execute on function public.preview_signal_match_ids() to anon, authenticated;

drop policy if exists "tiered_read_computed_values" on public.computed_values;
create policy "tiered_read_computed_values" on public.computed_values
  for select to anon, authenticated
  using (
    current_tier() <> 'free'
    or id in (select public.preview_computed_value_ids())
    or match_id in (select public.preview_signal_match_ids())
  );
