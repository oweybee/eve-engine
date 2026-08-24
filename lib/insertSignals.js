'use strict';

/**
 * lib/insertSignals — a duplicate signal must not cost the whole run.
 *
 * `value_signals_selection_price_unique` is a PERMANENT unique index:
 *
 *     (match_id, coalesce(market,'h2h'), outcome,
 *      coalesce(model_architecture,'MARKET_CONSENSUS'), detected_odds)
 *
 * Every writer dedups against it in the application first, and two of the four
 * do it properly — they pre-filter against the FULL signal history for the
 * matches in hand. The other two only look back `SIGNAL_DEDUP_MINUTES` (60),
 * and the index has no time bound at all. So a price that sits unchanged for
 * longer than an hour and is then re-quoted collides with its own older row,
 * Postgres raises 23505, and the writer's `throw` takes the entire compute
 * cycle down with it — before secondary signals or bet-of-day ever run.
 *
 * A PRE-FILTER IS NOT A GUARANTEE, WHICH IS WHY THIS EXISTS EVEN FOR THE TWO
 * THAT HAVE ONE. It is a read followed by a write, so it is racy against a
 * concurrent tick; and it is only as complete as the read behind it, which is
 * a PostgREST read and therefore capped. The constraint is the only thing that
 * is actually true. Treat 23505 as what it is — "this row is already on
 * record" — rather than as a failure.
 *
 * WHY NOT `ON CONFLICT DO NOTHING`. That is the one-round-trip answer and it
 * cannot be used: supabase-js needs an `onConflict` column list, and Postgres
 * CANNOT INFER AN EXPRESSION INDEX FROM A PLAIN COLUMN LIST — the index above
 * coalesces two of its five columns. This repo has already paid for that
 * exact mistake once: `captureClosingLines` upserted against an expression
 * index for months and every insert was rejected with "there is no unique or
 * exclusion constraint matching the ON CONFLICT specification", so the table
 * was written entirely by a one-off backfill and looked like a feed going
 * quiet (migration 087). Do not reach for it here without changing the index.
 *
 * WHY NOT `return 0` ON A COLLISION, which is what the original fix did. A
 * batch is one statement, so ONE duplicate row aborts ALL of them — and
 * returning zero reports every genuinely-new signal in that batch as
 * "already recorded". That is the shape this repo keeps paying for: a job that
 * runs, computes the right answer and throws it away, while the symptom looks
 * like a quiet market. The retry below re-inserts row by row so the duplicates
 * are skipped and nothing else is lost.
 */

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Insert `rows` into `value_signals`, skipping only those the unique index
 * already holds.
 *
 * The batch is tried first and is the ordinary path — the row-by-row walk runs
 * only after a collision, so the extra round trips are paid on the rare branch
 * and not on every tick.
 *
 * Any error that is not a unique violation still throws. A dropped connection
 * or a rejected column must not be swallowed as "already recorded".
 *
 * @param {object} supabase
 * @param {object[]} rows
 * @param {string} tag names the caller in the log line
 * @returns {Promise<{inserted: number, duplicate: number}>}
 */
async function insertSignals(supabase, rows, tag) {
  if (!rows.length) return { inserted: 0, duplicate: 0 };

  const { error } = await supabase.from('value_signals').insert(rows);
  if (!error) return { inserted: rows.length, duplicate: 0 };
  if (error.code !== UNIQUE_VIOLATION) {
    throw new Error(`${tag}(insert): ${error.message}`);
  }

  let inserted = 0;
  let duplicate = 0;
  for (const row of rows) {
    const { error: rowErr } = await supabase.from('value_signals').insert(row);
    if (!rowErr) { inserted++; continue; }
    if (rowErr.code === UNIQUE_VIOLATION) { duplicate++; continue; }
    throw new Error(`${tag}(insert row): ${rowErr.message}`);
  }

  // Worth a warning rather than silence: a pre-filtered writer landing here
  // means its history read missed something — a race with a concurrent tick,
  // or a read that came back short.
  console.warn(
    `[${tag}] unique index rejected the batch — re-inserted row by row: ` +
    `${inserted} new, ${duplicate} already on record`
  );
  return { inserted, duplicate };
}

module.exports = { insertSignals, UNIQUE_VIOLATION };
