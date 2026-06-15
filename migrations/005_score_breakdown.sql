-- ===========================================================================
-- Max Edge — Max Edge Score breakdown (Feature #5: no hidden magic numbers)
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
-- ===========================================================================

alter table computed_values add column if not exists mes_breakdown jsonb;
