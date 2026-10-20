-- 168: player_rail answers the service role as paid.
--
-- The #hit-rates player card (postToDiscord.js players) reads player_rail with
-- the service-role key. That key carries no auth.uid(), so current_tier()
-- read 'free' and the rail was capped to the preview fixtures. The service role
-- already bypasses RLS on every table this function reads; this only stops the
-- function under-serving it. Members and anon are unchanged.
--
-- Applied live 20 Oct 2026 as a text replace of the one line, so the body is
-- exactly migration 166's with the tier test widened.
do $$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
  where p.proname = 'player_rail' and p.pronamespace = 'public'::regnamespace;
  if position('v_paid  boolean := public.current_tier() <> ''free'';' in d) = 0 then
    raise exception '168: player_rail does not carry the expected tier line';
  end if;
  d := replace(d, 'v_paid  boolean := public.current_tier() <> ''free'';',
    'v_paid  boolean := public.current_tier() <> ''free'' or coalesce(auth.role(), '''') = ''service_role'';');
  execute d;
end $$;
