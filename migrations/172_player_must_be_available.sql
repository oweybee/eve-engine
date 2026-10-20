-- 172: a player who has missed his club's last five games is not ranked
-- (owner, 20 Oct 2026: Buongiorno "has been injured for a very long time yet
-- he still ranks").
--
-- WHY. A player stayed in the squad if he had played for the club in the last
-- 240 days, so a long-term injury kept ranking on games from before it.
-- Buongiorno's last recorded game is 17 May 2026 and he led Napoli's fouls
-- table on 20 Oct. The same rule kept players who have since left.
--
-- WHY NOT "THIS SEASON". Seasons start at different times across the forty
-- competitions (MLS and the Nordic leagues run on the calendar year), and a
-- season cut empties every rate in the first weeks of one. The question is
-- whether the man is available, which is a fact about his club's recent games:
-- if the club has played five times since his last appearance, he is out.
--
-- The club's games are those in player_match_stats (the fixtures we hold
-- player detail for), so a cup game we never fetched does not count against
-- him. A club with fewer than five recorded games in 240 days drops nobody.
--
-- THE CLUB'S FIVE GAMES ARE READ PER CLUB WITH A LIMIT. The first cut read
-- every recorded appearance for every club on the slate (60k rows) and took
-- the rail from ~0.2s to 2.5s; a distinct-kickoff index scan that stops at
-- five takes 10ms for 186 clubs. Applied live as two steps, the second
-- (`player_must_be_available_fast`) swapping in this form.
--
-- Both readers are rewritten in place from their LIVE definitions, the way
-- 168 and 171 did, and each refuses to run if the text it expects has moved.
-- On 20 Oct this drops, from Napoli: Buongiorno (17 May), Lukaku (6 Mar),
-- Contini, Mazzocchi, Elmas, Juan Jesus and Gutiérrez (24 May).

do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  where p.proname = 'player_rail' and p.pronamespace = 'public'::regnamespace;

  if position('  app as materialized (' in d) = 0
     or position('      and (p_position is null or r.cur_pos = p_position)' in d) = 0 then
    raise exception '172: player_rail does not carry the expected text';
  end if;

  d := replace(d, '  app as materialized (',
'  team_cut as materialized (
    select u.tid, c.cut
    from unnest(v_ids) u(tid)
    cross join lateral (
      select min(k.ko) as cut, count(*) as n
      from (
        select distinct s.kickoff_at as ko
        from public.player_match_stats s
        where s.team_api_id = u.tid and s.kickoff_at > now() - interval ''240 days''
        order by s.kickoff_at desc
        limit 5
      ) k
    ) c
    where c.n >= 5
  ),
  available as materialized (
    select r.player_id as aid
    from public.player_recent_apps r
    left join team_cut c on c.tid = r.cur_team
    where r.rn = 1 and r.cur_team = any(v_ids)
      and (c.cut is null or r.kickoff_at >= c.cut)
  ),
  app as materialized (');

  d := replace(d, '      and (p_position is null or r.cur_pos = p_position)',
'      and (p_position is null or r.cur_pos = p_position)
      and r.player_id in (select aid from available)');
  execute d;
end;
$$;

do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d
  from pg_proc p
  where p.proname = 'player_form_unchecked_v3' and p.pronamespace = 'public'::regnamespace;

  if position('      select s.player_id, s.player_name, s.team_api_id, s.team_name, s.player_position
      from public.player_match_stats s
      where s.player_id = c.player_id and s.minutes > 0' in d) = 0
     or position('    where l.team_api_id = any(p_team_api_ids)
  ),' in d) = 0 then
    raise exception '172: player_form_unchecked_v3 does not carry the expected text';
  end if;

  d := replace(d, '      select s.player_id, s.player_name, s.team_api_id, s.team_name, s.player_position
      from public.player_match_stats s
      where s.player_id = c.player_id and s.minutes > 0',
'      select s.player_id, s.player_name, s.team_api_id, s.team_name, s.player_position, s.kickoff_at
      from public.player_match_stats s
      where s.player_id = c.player_id and s.minutes > 0');

  d := replace(d, '    where l.team_api_id = any(p_team_api_ids)
  ),',
'    where l.team_api_id = any(p_team_api_ids)
      and l.kickoff_at >= coalesce((
        select min(t.kickoff_at)
        from (
          select distinct s3.kickoff_at
          from public.player_match_stats s3
          where s3.team_api_id = l.team_api_id and s3.kickoff_at > now() - interval ''240 days''
          order by s3.kickoff_at desc
          limit 5
        ) t
        having count(*) >= 5
      ), ''-infinity''::timestamptz)
  ),');
  execute d;
end;
$$;
