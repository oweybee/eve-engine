-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829113004, name 118_editorial_failure_is_publishable. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 118_editorial_failure_is_publishable.sql
--
-- The public status in 117 was derived from the gate verdict alone, and the gate
-- cannot fail a model on sample-size grounds: it HOLDs until the fixture count
-- clears. So a model with a decisively negative CLV rendered as "Gathering
-- sample", which reads as "coming soon" for something that is not coming. The
-- only way to stop that was to retire the model, i.e. delete the card.
--
-- This adds one editorial channel: paper_models.status = 'failed' publishes as
-- "Did not pass", with the model's real CLV still on the card.
--
-- THE OVERRIDE IS ONE-WAY BY DESIGN. 'failed' can pull a status DOWN from
-- gathering_sample to not_proven. Nothing here lets a human push a status UP to
-- 'passed' -- that still requires clearing every gate in paper_trade_gate(),
-- including the fixture count, the takeability floor and the CLV z. An editorial
-- override that could promote would defeat the entire harness; one that can only
-- demote is a judgement call about when to stop waiting, which is a person's to
-- make.

create or replace function public.get_paper_model_public_cards()
returns table (
  model             text,
  market            text,
  settled_fixtures  integer,
  required_fixtures integer,
  avg_clv_pct       numeric,
  clv_takeable_pct  numeric,
  takeable_pct      numeric,
  clv_zscore        numeric,
  status            text,
  status_label      text
)
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $function$
  with gate as (
    select * from public.paper_trade_gate()
  ),
  mapped as (
    select
      g.model             as m_model,
      g.market            as m_market,
      g.settled_fixtures  as m_fx,
      g.required_fixtures as m_req,
      g.avg_clv_pct       as m_clv,
      g.clv_takeable_pct  as m_clv_tk,
      g.takeable_pct      as m_tk,
      g.clv_zscore        as m_z,
      coalesce(pm.status, 'testing') as m_model_status,
      case
        -- Editorial demotion wins over the gate's "still waiting".
        when coalesce(pm.status, 'testing') = 'failed' then 'not_proven'
        when g.verdict like 'PASS%' then 'passed'
        when g.verdict like 'FAIL%' then 'not_proven'
        when g.verdict like 'HOLD -%settled fixtures%' then 'gathering_sample'
        else 'under_review'
      end as m_status
    from gate g
    left join public.paper_models pm on pm.model = g.model
  )
  select
    mapped.m_model,
    mapped.m_market,
    mapped.m_fx,
    mapped.m_req,
    mapped.m_clv,
    mapped.m_clv_tk,
    mapped.m_tk,
    mapped.m_z,
    mapped.m_status,
    case mapped.m_status
      when 'passed'           then 'Passed'
      when 'gathering_sample' then 'Gathering sample'
      when 'not_proven'       then 'Did not pass'
      else                         'Under review'
    end
  from mapped
  where mapped.m_model_status <> 'retired'
  order by mapped.m_model, mapped.m_market;
$function$;

comment on function public.get_paper_model_public_cards() is
  'Public read path for the research-harness cards. SECURITY DEFINER so the browser never touches paper_trades, which stays service_role-only. Exposes fixtures, CLV, takeability, z and a four-value status; deliberately excludes the raw verdict string, yield and every per-trade row. paper_models.status = ''failed'' publishes the card as "Did not pass" (a one-way editorial demotion - nothing can promote a model to "Passed" except clearing paper_trade_gate); ''retired'' drops the card entirely. Takes no parameters: gate thresholds are not caller-tunable from the browser. See migrations 117 and 118.';

-- API_PREDICTIVE: -3.87% no-vig CLV at z = -4.88 against independent_consensus,
-- over 77 settled fixtures. Under the most optimistic (and unexecutable)
-- selection rule -- keeping the best price of each re-alert rather than the
-- first -- it is still -2.50% at z = -3.54. Waiting for 489 fixtures would
-- confirm the sign, not change it.
update public.paper_models
set status = 'failed',
    notes  = coalesce(notes || ' ', '') ||
             'Marked failed 2026-08-29: no-vig CLV -3.87% at z = -4.88 vs independent_consensus over 77 fixtures; -2.50% at z = -3.54 even under a best-price hindsight rule. Demoted from the homepage headline track on the same date.'
where model = 'API_PREDICTIVE';
