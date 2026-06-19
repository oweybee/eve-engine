-- Migration 011: Bookings model edge and value columns
-- Extends computed_values with model-derived edge and value flags for
-- the booking points market, now that we have a Poisson bookings model.

ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS bookings_over_edge   NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bookings_under_edge  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bookings_over_value  BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bookings_under_value BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bookings_model_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bookings_lambda      NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN computed_values.bookings_model_prob IS 'P(total booking pts > line) from Poisson bookings model';
COMMENT ON COLUMN computed_values.bookings_lambda     IS 'Expected total booking points (model lambda)';
