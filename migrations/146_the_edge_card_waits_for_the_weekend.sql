-- 146: #edge-table moves from Monday 08:27 UTC to Tuesday 08:27 UTC.
--
-- football-data.co.uk, the only source for settled results and closing
-- prices, posts the weekend's results during Monday. In Aug 2026 both
-- weekends first reached match_results between the Monday morning and Monday
-- night ingests, so a Monday 08:27 card showed the weekend before. Tuesday
-- 08:27 follows the Monday 17:20 and 23:20 UTC ingests.
--
-- Migration 145 is edited to match, so a fresh build schedules Tuesday too.
select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'discord-edge'),
  schedule := '27 8 * * 2'
);
