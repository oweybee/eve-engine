-- 174: the PRIME alert footer names GamCare, not BeGambleAware (21 Oct 2026).
--
-- GambleAware closed on 31 March 2026. send_prime_alerts() (migration 112)
-- writes the safer-gambling line into the X caption and the short-form caption
-- it drafts in the owner's private Discord. Both now name the National
-- Gambling Helpline, run by GamCare, the same line the site, xCompose.js,
-- inplayFlagsX.js and the prime-post-x / prime-card functions carry.
--
-- The function body is rewritten from its own deployed definition, so nothing
-- else in it can drift from production. The assertion below fails the
-- migration if the old line survives or the new one is missing.

begin;

do $$
declare
  v_def text := pg_get_functiondef('public.send_prime_alerts'::regproc);
  v_new text;
begin
  v_new := replace(v_def,
    '18+ | begambleaware.org | Pricing analysis, not advice',
    '18+ | GamCare 0808 8020 133 | Pricing analysis, not advice');
  v_new := replace(v_new, '18+ | begambleaware.org', '18+ | GamCare 0808 8020 133');
  execute v_new;
end $$;

do $$
declare v_def text := pg_get_functiondef('public.send_prime_alerts'::regproc);
begin
  if v_def ilike '%gambleaware%' then
    raise exception '174: send_prime_alerts still names GambleAware';
  end if;
  if v_def not like '%18+ | GamCare 0808 8020 133 | Pricing analysis, not advice%' then
    raise exception '174: send_prime_alerts is missing the GamCare footer';
  end if;
end $$;

commit;
