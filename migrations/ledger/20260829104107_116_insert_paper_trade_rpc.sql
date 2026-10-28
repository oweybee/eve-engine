-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829104107, name 116_insert_paper_trade_rpc. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 116 part 1: insert_paper_trade
-- ON CONFLICT DO NOTHING with no conflict target, the only form that covers an
-- EXPRESSION index. paper_trades_dedup_idx is on COALESCE(external_ref,'') and
-- COALESCE(market_line,-1), so PostgREST .upsert({onConflict}) fails with 42P10.

create or replace function public.insert_paper_trade(
  p_match_id        uuid,
  p_kickoff_at      timestamptz,
  p_model           text,
  p_model_version   text,
  p_market          text,
  p_selection       text,
  p_model_prob      numeric,
  p_price_taken     numeric,
  p_market_line     numeric     default null,
  p_book_taken      text        default null,
  p_books_quoting   integer     default null,
  p_price_avg       numeric     default null,
  p_model_lambda    numeric     default null,
  p_model_sigma     numeric     default null,
  p_mxs             integer     default null,
  p_logged_at       timestamptz default now(),
  p_external_ref    text        default null,
  p_notes           text        default null
)
returns table(trade_id uuid, status text, reason text)
language plpgsql
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_id      uuid;
  v_ref     text := coalesce(nullif(trim(p_external_ref), ''), p_match_id::text);
  v_market  text := coalesce(nullif(trim(p_market), ''), 'h2h');
  v_warn    text;
begin
  if p_match_id is null then
    return query select null::uuid, 'rejected', 'match_id is null'; return;
  end if;
  if p_kickoff_at is null then
    return query select null::uuid, 'rejected', 'kickoff_at is null (NOT NULL)'; return;
  end if;
  if p_model is null or p_model_version is null or p_selection is null then
    return query select null::uuid, 'rejected', 'model, model_version and selection are all NOT NULL'; return;
  end if;
  if p_model_prob is null or p_model_prob <= 0 or p_model_prob >= 1 then
    return query select null::uuid, 'rejected',
      format('model_prob %s fails CHECK (model_prob > 0 AND model_prob < 1)',
             coalesce(p_model_prob::text, 'null')); return;
  end if;
  if p_price_taken is null or p_price_taken <= 1 then
    return query select null::uuid, 'rejected',
      format('price_taken %s fails CHECK (price_taken > 1)',
             coalesce(p_price_taken::text, 'null')); return;
  end if;

  if not exists (
    select 1 from public.model_selection_anchor msa
    where msa.model = p_model and msa.market = v_market
  ) then
    v_warn := format('no model_selection_anchor row for %s/%s - this trade cannot be gated until one exists',
                     p_model, v_market);
  end if;

  insert into public.paper_trades (
    match_id, external_ref, kickoff_at, model, model_version, market, market_line,
    selection, model_prob, model_lambda, model_sigma, mxs,
    price_taken, book_taken, books_quoting, price_avg,
    logged_at, hours_to_kickoff, notes
  )
  values (
    p_match_id, v_ref, p_kickoff_at, p_model, p_model_version, v_market, p_market_line,
    p_selection, p_model_prob, p_model_lambda, p_model_sigma, p_mxs,
    p_price_taken, p_book_taken, p_books_quoting, p_price_avg,
    coalesce(p_logged_at, now()),
    round(extract(epoch from (p_kickoff_at - coalesce(p_logged_at, now()))) / 3600.0, 2),
    p_notes
  )
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    return query select null::uuid, 'duplicate',
      format('already logged for %s / %s / %s / line %s / %s',
             v_ref, p_model, v_market, coalesce(p_market_line::text, 'none'), p_selection);
  else
    return query select v_id, 'inserted', v_warn;
  end if;
end;
$function$;

comment on function public.insert_paper_trade is
  'Writer entry point for paper_trades. Idempotent via ON CONFLICT DO NOTHING with no target (paper_trades_dedup_idx is an expression index and cannot be named by column list, which is why PostgREST .upsert() fails with 42P10 against it). Returns (trade_id, status, reason) where status is inserted | duplicate | rejected, so a caller looping over signals logs rather than catches. scoring_anchor is not a parameter: it takes the column default set by migration 114. See migration 116.';

revoke all on function public.insert_paper_trade(
  uuid, timestamptz, text, text, text, text, numeric, numeric, numeric, text,
  integer, numeric, numeric, numeric, integer, timestamptz, text, text) from public;

grant execute on function public.insert_paper_trade(
  uuid, timestamptz, text, text, text, text, numeric, numeric, numeric, text,
  integer, numeric, numeric, numeric, integer, timestamptz, text, text) to service_role;
