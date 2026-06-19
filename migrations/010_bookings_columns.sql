-- Migration 010: Booking Points (cards) market columns on computed_values
-- Stores best Betfair exchange price for the booking points over/under market.
-- No model edge (no bookings prediction model yet) — raw exchange odds only.
--
-- Booking points convention: Yellow card = 10pts, Red card = 25pts,
-- 2nd Yellow (leading to red) = 35pts. Typical line is 30.5 or 35.5.

ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS bookings_over_odds  NUMERIC(8,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bookings_under_odds NUMERIC(8,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS bookings_line       NUMERIC(5,1) DEFAULT NULL;

COMMENT ON COLUMN computed_values.bookings_over_odds  IS 'Betfair exchange best back price for Over booking points line';
COMMENT ON COLUMN computed_values.bookings_under_odds IS 'Betfair exchange best back price for Under booking points line';
COMMENT ON COLUMN computed_values.bookings_line       IS 'Booking points line (e.g. 30.5 or 35.5)';
