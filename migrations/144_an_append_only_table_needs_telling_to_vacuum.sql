-- ── 29,604 HEAP FETCHES PER BOARD READ, BECAUSE NOBODY TOLD IT TO VACUUM ────
--
-- 11 Oct 2026, found while timing fixture_board(). The price read showed this:
--
--     Index Only Scan using idx_odds_board_order on odds
--           Heap Fetches: 29604
--           Buffers: shared hit=29848 read=846
--     Execution Time: 938 ms   (cold)   /   63 ms (warm)
--
-- An "index only" scan doing 29,604 heap fetches is not index-only. Those are
-- VISIBILITY CHECKS: a row can only be answered from the index if its page is
-- marked all-visible, and only VACUUM sets that mark.
--
-- WHY THE MARK WAS NEVER SET. `odds` is an append-only price-change log,
-- 1,036,290 rows and growing by roughly 138,000 a day. Autovacuum's insert
-- trigger is `autovacuum_vacuum_insert_threshold` plus
-- `autovacuum_vacuum_insert_scale_factor` x live rows, which at the defaults
-- (1,000 and 0.2) is 1,000 + 207,258 = 208,258 inserts. Measured at the time:
-- 138,738 inserts since the last vacuum, which had run 15 hours earlier. So
-- the table was vacuumed about once a day, and the pages holding the NEWEST
-- prices — exactly the ones every board read wants — were never marked.
--
-- A fixed threshold with no scale factor makes the cadence independent of how
-- big the log gets: roughly every two hours at today's rate, and it stays
-- every 20,000 inserts when the table is ten times the size.
--
-- MEASURED AFTER (same window, same query, warm):
--     Heap Fetches   29,604  ->  499
--     Buffers        30,730  ->  1,377        (240 MB of pages -> 11 MB)
--     Time              63ms ->  47ms warm, and the 938ms cold case goes with
--                                the working set
--
-- The buffer count is the number that matters. A call that touched 240MB of
-- pages was evicting everything else in cache on its way through, which is
-- why the cold 938ms kept coming back.
--
-- ROLLBACK:  alter table public.odds reset (
--              autovacuum_vacuum_insert_threshold,
--              autovacuum_vacuum_insert_scale_factor);

alter table public.odds set (
  autovacuum_vacuum_insert_threshold = 20000,
  autovacuum_vacuum_insert_scale_factor = 0.0
);

-- `matches` had 13% dead rows and had not been autovacuumed since 26 Sep,
-- which was costing 11,169 heap fetches on the fixture pick alone. It is not
-- append-only, so the default dead-row rules are right for it; it just needed
-- the one catch-up VACUUM, which was run by hand at the same time as this.
