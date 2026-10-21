-- 175: the PRIME alert no longer drafts a TikTok caption (21 Oct 2026).
--
-- send_prime_alerts() ended every PRIME LIVE message in the owner's private
-- Discord with a "TikTok / Reels (no odds)" caption reading
-- "<fixture>: <selection>. PRIME on the board at maxedge.live". That breaks
-- the TikTok rules in claude/social-agent-rules.md three ways: it names a
-- rung (PRIME), it carries a site link, and the selection is bet framing.
-- A PRIME alert is a price claim, so it has no TikTok-safe version at all.
-- The draft is replaced with one line saying so; the X caption is untouched.
--
-- Rewritten from the deployed definition, as 174 did, and asserted below.

begin;

do $mig$
declare
  v_def text := pg_get_functiondef('public.send_prime_alerts'::regproc);
  v_new text;
begin
  v_new := replace(v_def,
$old$E'\n```\nTikTok / Reels (no odds):\n```\n'
      || v_fix || ': ' || v_sel || '. PRIME on the board at maxedge.live' || E'\n'
      || '18+ | GamCare 0808 8020 133' || E'\n```';$old$,
$new$E'\n```\nNot for TikTok or Reels: a PRIME alert is a price claim, so it stays on X and Discord.';$new$);
  if v_new = v_def then
    raise exception '175: the TikTok caption block was not found, nothing replaced';
  end if;
  execute v_new;
end $mig$;

do $chk$
declare v_def text := pg_get_functiondef('public.send_prime_alerts'::regproc);
begin
  if v_def like '%PRIME on the board at maxedge.live%' or v_def like '%TikTok / Reels (no odds)%' then
    raise exception '175: the TikTok caption survives';
  end if;
  if v_def not like '%18+ | GamCare 0808 8020 133 | Pricing analysis, not advice%' then
    raise exception '175: the X caption footer was lost';
  end if;
  if v_def not like '%Not for TikTok or Reels%' then
    raise exception '175: the replacement line is missing';
  end if;
end $chk$;

commit;
