-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261010174554, name settle_accas. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace function public.bet_leg_outcome(
  p_market text, p_selection text, p_line numeric, p_home integer, p_away integer
) returns text
language sql immutable
set search_path to 'public', 'pg_catalog'
as $$
  select case
    when p_home is null or p_away is null then null
    when p_market = 'h2h' then
      case when lower(p_selection) = (case when p_home > p_away then 'home'
                                           when p_home < p_away then 'away'
                                           else 'draw' end)
           then 'won'
           when lower(p_selection) in ('home', 'away', 'draw') then 'lost'
      end
    when p_market = 'btts' then
      case when lower(p_selection) like '%yes%' then
             case when p_home > 0 and p_away > 0 then 'won' else 'lost' end
           when lower(p_selection) like '%no%' then
             case when p_home > 0 and p_away > 0 then 'lost' else 'won' end
      end
    when p_market = 'totals' and p_line is not null then
      case when p_home + p_away = p_line then 'void'
           when lower(p_selection) = 'over'  then case when p_home + p_away > p_line then 'won' else 'lost' end
           when lower(p_selection) = 'under' then case when p_home + p_away < p_line then 'won' else 'lost' end
      end
  end
$$;

revoke execute on function public.bet_leg_outcome(text, text, numeric, integer, integer) from public, anon;

CREATE OR REPLACE FUNCTION public.settle_my_bets()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_uid   uuid := auth.uid();
  r       record;
  v_total integer;
  v_new   text;
  v_won   boolean;
  v_close numeric;
  v_clv   numeric;
  v_count integer := 0;
  v_lost    integer;
  v_won_n   integer;
  v_legs    integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  for r in
    select b.id, b.market, b.selection, b.market_line, b.odds_taken, b.signal_id,
           m.goals_home, m.goals_away
    from public.bets b
    join public.matches m on m.id = b.match_id
    where b.user_id = v_uid
      and b.status = 'open'
      and coalesce(b.settle_mode, '') <> 'manual'
      and b.is_acca = false
      and m.status = 'completed'
      and m.goals_home is not null
      and m.goals_away is not null
  loop
    v_total := r.goals_home + r.goals_away;
    v_won   := null;

    if r.market = 'h2h' then
      v_won := (case
                  when r.goals_home > r.goals_away then 'home'
                  when r.goals_home < r.goals_away then 'away'
                  else 'draw'
                end) = lower(r.selection);
    elsif r.market = 'btts' then
      if lower(r.selection) like '%yes%' then
        v_won := (r.goals_home > 0 and r.goals_away > 0);
      elsif lower(r.selection) like '%no%' then
        v_won := not (r.goals_home > 0 and r.goals_away > 0);
      end if;
    elsif r.market = 'totals' then
      if r.market_line is not null then
        if lower(r.selection) = 'over' then
          if v_total = r.market_line then v_won := null;
          else v_won := v_total > r.market_line; end if;
        elsif lower(r.selection) = 'under' then
          if v_total = r.market_line then v_won := null;
          else v_won := v_total < r.market_line; end if;
        end if;
      end if;
    end if;

    if v_won is null and not (r.market = 'totals' and v_total = r.market_line) then
      continue;
    end if;

    if r.market = 'totals' and v_total = r.market_line then
      v_new := 'void';
    else
      v_new := case when v_won then 'won' else 'lost' end;
    end if;

    v_close := null; v_clv := null;
    if r.signal_id is not null then
      select vs.closing_odds into v_close
      from public.value_signals vs where vs.id = r.signal_id;
      if v_close is not null and v_close > 1 and r.odds_taken > 1 then
        v_clv := ln(r.odds_taken / v_close);
      end if;
    end if;

    update public.bets
       set status       = v_new,
           settled_at   = now(),
           settle_mode  = 'auto',
           closing_odds = coalesce(closing_odds, v_close),
           clv          = coalesce(clv, v_clv)
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  for r in
    select b.id, b.acca_legs
    from public.bets b
    where b.user_id = v_uid
      and b.status = 'open'
      and coalesce(b.settle_mode, '') <> 'manual'
      and b.is_acca = true
      and jsonb_typeof(b.acca_legs) = 'array'
      and jsonb_array_length(b.acca_legs) > 0
      and not exists (
        select 1 from jsonb_array_elements(b.acca_legs) l
        where nullif(l->>'match_id', '') is null
      )
  loop
    select count(*),
           count(*) filter (where o.outcome = 'lost'),
           count(*) filter (where o.outcome = 'won')
      into v_legs, v_lost, v_won_n
    from jsonb_array_elements(r.acca_legs) l
    left join public.matches m on m.id = (l->>'match_id')::uuid
    cross join lateral (
      select case when m.status = 'completed' then
        public.bet_leg_outcome(
          l->>'market', l->>'selection',
          nullif(l->>'market_line', '')::numeric,
          m.goals_home, m.goals_away)
      end as outcome
    ) o;

    if v_lost > 0 then
      v_new := 'lost';
    elsif v_won_n = v_legs then
      v_new := 'won';
    else
      continue;
    end if;

    update public.bets
       set status      = v_new,
           settled_at  = now(),
           settle_mode = 'auto'
     where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke execute on function public.settle_my_bets() from public, anon;
grant  execute on function public.settle_my_bets() to authenticated;
