-- 199: the GDPR export carries the lineup-alert data from 197: the teams a
-- member follows, their DM-blocked state, and the log of DMs sent to them.
create or replace function public.export_my_data()
returns json
language sql stable security definer set search_path to 'public', 'pg_catalog'
as $function$
  select json_build_object(
    'account',      (select row_to_json(p) from public.profiles p where p.id = auth.uid()),
    'preferences',  (select row_to_json(pr) from public.preferences pr where pr.user_id = auth.uid()),
    'bets',         (select coalesce(json_agg(b order by b.created_at), '[]'::json)
                       from public.bets b where b.user_id = auth.uid()),
    'follows',      (select coalesce(json_agg(fo order by fo.created_at), '[]'::json)
                       from public.follows fo where fo.user_id = auth.uid()),
    'slip_scans',   (select coalesce(json_agg(sc order by sc.created_at), '[]'::json)
                       from public.slip_scans sc where sc.user_id = auth.uid()),
    'bankroll_transactions', (select coalesce(json_agg(t order by t.occurred_at), '[]'::json)
                       from public.bankroll_transactions t where t.user_id = auth.uid()),
    'bookmakers',   (select coalesce(json_agg(ub), '[]'::json)
                       from public.user_bookmakers ub where ub.user_id = auth.uid()),
    'subscription', (select row_to_json(s) from public.subscriptions s where s.user_id = auth.uid()),
    'discord',      (select row_to_json(d) from public.discord_links d where d.user_id = auth.uid()),
    'lineup_alerts', json_build_object(
      'teams', (select coalesce(json_agg(json_build_object('team', t.name, 'since', f.created_at) order by f.created_at), '[]'::json)
                  from public.team_follows f join public.teams t on t.id = f.team_id where f.user_id = auth.uid()),
      'state', (select row_to_json(s) from public.lineup_alert_state s where s.user_id = auth.uid()),
      'dms',   (select coalesce(json_agg(g order by g.created_at), '[]'::json)
                  from public.lineup_dm_log g where g.user_id = auth.uid())),
    'exported_at',  now()
  )
  where auth.uid() is not null;
$function$;
