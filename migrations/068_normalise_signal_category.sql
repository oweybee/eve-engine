-- 068_normalise_signal_category.sql
--
-- I CONTRACTED THE CONSTRAINT BEFORE THE CODE THAT SATISFIES IT SHIPPED.
--
-- Migration 064 narrowed `value_signals_signal_category_check` to the lower-case
-- bucket keys, and the matching `categoryFor()` change is on a BRANCH. The
-- engine running in production is on `main` and still writes 'Prime' / 'Value' /
-- 'Longshot', so from the moment 064 applied, every `value_signals` insert the
-- live engine attempted would be rejected by the CHECK. Verified by probe
-- against a copy of the table carrying its constraints: a Title Case row is
-- refused.
--
-- This is the migration-034 shape exactly, and that one is written up in
-- eve-frontend/CLAUDE.md because nobody who paid ever received the product: a
-- CHECK constraint rejecting a write the running code makes, silently, because
-- the caller did not check the error. Applying the contract half of an
-- expand/contract migration before the expand half deploys is the same mistake
-- with a different column.
--
-- THE FIX IS NORMALISE-ON-WRITE, not a wider constraint. Widening to accept both
-- cases would put the retired badge words back into the allowed set and leave
-- the database holding two spellings of one bucket — which is what 064 existed
-- to end. Lower-casing on the way in means the STORED value is always the bucket
-- key, whichever version of the engine is writing, so the strict constraint
-- holds and the deploy can happen in either order.
--
-- It is deliberately permanent rather than a temporary shim. `signal_category`
-- is a key, not prose; there is no spelling of it that case should distinguish,
-- and a normaliser is cheaper to keep than a note explaining when it may be
-- removed.

begin;

create or replace function public.normalise_signal_category()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.signal_category is not null then
    new.signal_category := lower(new.signal_category);
  end if;
  return new;
end $$;

-- Row-level BEFORE triggers run ahead of constraint evaluation, so the value is
-- already normalised by the time the CHECK sees it.
drop trigger if exists trg_normalise_signal_category on public.value_signals;
create trigger trg_normalise_signal_category
  before insert or update on public.value_signals
  for each row execute function public.normalise_signal_category();

commit;
