-- Migration 012: Total Corners market columns on computed_values
ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS corners_over_odds   NUMERIC(8,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_under_odds  NUMERIC(8,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_line        NUMERIC(5,1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_over_edge   NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_under_edge  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_over_value  BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS corners_under_value BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS corners_model_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS corners_lambda      NUMERIC(6,2) DEFAULT NULL;
