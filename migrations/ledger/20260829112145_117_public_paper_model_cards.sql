-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260829112145, name 117_public_paper_model_cards. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- 117_public_paper_model_cards.sql
--
-- The homepage needs the harness figures. paper_trades is RLS'd to service_role,
-- so the browser reads nothing from it, and it must stay that way: raw research
-- trades are not public data.
--
-- This exposes ONLY the card figures, through a security-definer function.
-- Deliberately NOT exposed: the raw verdict string (it leaks internals such as
-- which scoring anchor is in use and the sd behind the power calculation),
-- pl_units and yield (every yield interval on this harness spans zero, so
-- publishing one would be the exact trap 116's analysis identified), and every
-- per-trade row.
--
-- The public status is a four-value enum rather than the internal verdict:
--
--   passed            cleared every gate
--   gathering_sample  HOLD on fixture count. Honest "not yet", with progress.
--   not_proven        FAIL on takeability, CLV or z. NOT dressed up as "testing".
--   under_review      any other HOLD (anchor problems). A configuration fault,
--                     not a claim about the model.
--
-- paper_models.status is the kill switch: set a model to 'retired' and its card
-- disappears without a frontend deploy.

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
  'Public read path for the research-harness cards. SECURITY DEFINER so the browser never touches paper_trades, which stays service_role-only. Exposes fixtures, CLV, takeability, z and a four-value status; deliberately excludes the raw verdict string, yield and every per-trade row. Set paper_models.status = ''retired'' to drop a model from the cards without a frontend deploy. Takes no parameters: the gate thresholds are not caller-tunable from the browser. See migration 117.';

revoke all on function public.get_paper_model_public_cards() from public;
grant execute on function public.get_paper_model_public_cards() to anon, authenticated, service_role;
