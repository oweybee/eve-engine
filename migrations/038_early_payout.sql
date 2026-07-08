-- 038_early_payout.sql
-- Bookmaker "2 goals ahead" early payout (2UP) tracking.
--
-- A match-result WIN single is paid out as a winner the moment the backed team
-- goes two goals clear, regardless of the final score. We record that fact per
-- bet WITHOUT overwriting the graded result, then surface an early-payout-
-- ADJUSTED performance line alongside the true one — so the model's honest
-- accuracy and the realised "as paid out" returns are never conflated.
--
-- NULL early_payout = not yet evaluated; true/false = evaluated. Only 1X2 home/
-- away win singles are ever flagged true (see lib/earlyPayout.js).

alter table value_signals   add column if not exists early_payout boolean;
alter table recommendations add column if not exists early_payout boolean;

comment on column value_signals.early_payout is
  '2UP: backed 1X2 win single reached a 2-goal lead → paid as a winner regardless of final result. NULL = not yet evaluated.';
comment on column recommendations.early_payout is
  '2UP: backed 1X2 win single reached a 2-goal lead → paid as a winner regardless of final result. NULL = not yet evaluated.';

-- Adjusted aggregates on the performance snapshot (2UP payouts counted as wins).
alter table performance_summary add column if not exists early_payouts     int;
alter table performance_summary add column if not exists adjusted_wins      int;
alter table performance_summary add column if not exists adjusted_win_rate  numeric(5,4);
alter table performance_summary add column if not exists adjusted_yield     numeric(6,4);
alter table performance_summary add column if not exists adjusted_roi       numeric(6,4);

-- Partial index: the flagging pass repeatedly scans for as-yet-unflagged losses.
create index if not exists idx_vs_early_payout_pending
  on value_signals(result) where early_payout is null;
