-- 196: the homepage profit curve, precomputed (12 Nov 2026). APPLIED to
-- production as migration `prime_curve_points` on 12 Nov 2026; this file
-- records it in the repo.
--
-- The homepage read performance_signals?band=eq.prime as anon. The view takes
-- ~1.8s warm (record_band_match() runs ~6,300 times per read) against anon's
-- 3s statement_timeout, and timed out under load at 10:10 and 12:20 on 12 Nov,
-- which cached the homepage without its curve. Same rows and columns, settled
-- history only (ungated everywhere), refreshed every 10 minutes. 0.3ms as anon.
create materialized view if not exists public.prime_curve_points as
  select id, detected_at, advised_odds, result, band
  from public.performance_signals
  where band = 'prime';

create unique index if not exists prime_curve_points_id on public.prime_curve_points (id);
create index if not exists prime_curve_points_detected on public.prime_curve_points (detected_at);

revoke all on public.prime_curve_points from anon, authenticated;
grant select on public.prime_curve_points to anon, authenticated;

select cron.schedule('prime-curve-refresh', '3-59/10 * * * *',
  $$refresh materialized view concurrently public.prime_curve_points$$);
