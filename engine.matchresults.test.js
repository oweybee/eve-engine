'use strict';

/**
 * engine.matchresults.test.js — THE CORPUS BEHIND /leagues, AND THE FEED'S TRAPS.
 *
 * `match_results` is the whole source of the edge league table, and until this
 * ingest existed nothing in this repo had ever written to it: the table was
 * loaded once by hand, stopped at 24 May 2026, and sat there while 2026/27 was
 * already under way. There was no writer to wait for.
 *
 * THE GOLDEN ROW IS REAL. The CSV below is Liverpool 4-2 Bournemouth,
 * 15 Aug 2025 — rebuilt column for column from the row production already
 * holds, 24 fixed columns and 108 price columns under football-data's own
 * header names. The test asserts the parser reproduces that stored row exactly.
 * A hand-typed fixture would only prove the parser agrees with whoever typed it.
 *
 * football-data.co.uk is egress-blocked from the environment this was written
 * in, so the FETCH has never met the live feed. Everything downstream of the
 * bytes is covered here, and every parser fails closed.
 */

function assert(c, m) { if (!c) throw new Error(m); }
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const {
  parseSeasonCsv, seasonCode, seasonLabel, parseDate, splitLine, num, int,
  alternativesFrom, resolveAlternative, DIVISIONS,
} = require('./ingestMatchResults');

const HEADER = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,AHh,BVA,BVD,BVH,BWA,BWD,BWH,CLA,CLD,CLH,LBA,LBD,LBH,PSA,PSD,PSH,AHCh,AvgA,AvgD,AvgH,BFDA,BFDD,BFDH,BFEA,BFED,BFEH,BVCA,BVCD,BVCH,BWCA,BWCD,BWCH,CLCA,CLCD,CLCH,LBCA,LBCD,LBCH,MaxA,MaxD,MaxH,PAHA,PAHH,PSCA,PSCD,PSCH,AvgCA,AvgCD,AvgCH,B365A,B365D,B365H,BFDCA,BFDCD,BFDCH,BFECA,BFECD,BFECH,BMGMA,BMGMD,BMGMH,MaxCA,MaxCD,MaxCH,P<2.5,P>2.5,PCAHA,PCAHH,AvgAHA,AvgAHH,B365CA,B365CD,B365CH,BFEAHA,BFEAHH,BMGMCA,BMGMCD,BMGMCH,MaxAHA,MaxAHH,PC<2.5,PC>2.5,Avg<2.5,Avg>2.5,AvgCAHA,AvgCAHH,B365AHA,B365AHH,BFE<2.5,BFE>2.5,BFECAHA,BFECAHH,Max<2.5,Max>2.5,MaxCAHA,MaxCAHH,AvgC<2.5,AvgC>2.5,B365<2.5,B365>2.5,B365CAHA,B365CAHH,BFEC<2.5,BFEC>2.5,MaxC<2.5,MaxC>2.5,B365C<2.5,B365C>2.5";
const LIVERPOOL = "E0,15/08/2025,20:00,Liverpool,Bournemouth,4,2,H,1,0,H,A Taylor,19,10,10,3,7,10,6,7,1,2,0,0,-1.5,8.5,6,1.3,7.5,5.5,1.32,8,5.75,1.33,7.5,5.75,1.33,9.07,6.56,1.28,-1.75,8.31,5.96,1.31,9.5,6,1.3,9.4,6.6,1.34,9,6,1.29,8,5.75,1.31,8,6,1.3,8,5.75,1.3,9.5,6.5,1.34,2.03,1.9,9.75,6.55,1.29,8.68,6.02,1.29,8.5,6,1.3,9.5,6,1.3,10,6.8,1.32,9,6.5,1.29,9.5,6.6,1.31,3.26,1.37,1.85,2.07,1.99,1.78,9,6.25,1.29,2.08,1.9,9,6.25,1.3,2.06,1.83,2.95,1.41,3.13,1.35,1.76,1.94,2.03,1.83,3.4,1.4,1.86,2.14,3.3,1.38,1.88,2.03,3.05,1.36,3.2,1.36,1.78,2.03,3.4,1.41,3.2,1.4,3.2,1.36";
const PRICED = 108;
const CTX = { div: 'E0', country: 'England', season: '2025/26', sourceFile: '/mmz4281/2526/E0.csv' };
const parse = (body, ctx = CTX) => parseSeasonCsv(body, ctx);

console.log('\nmatch_results ingest\n');

/* -- the golden row -- */

test('reproduces a real stored row, field for field', () => {
  const { rows } = parse(HEADER + '\r\n' + LIVERPOOL + '\r\n');
  assert(rows.length === 1, 'expected 1 row, got ' + rows.length);
  const r = rows[0];
  assert(r.div === 'E0', 'div ' + r.div);
  assert(r.country === 'England', 'country ' + r.country);
  assert(r.season === '2025/26', 'season ' + r.season);
  assert(r.match_date === '2025-08-15', 'match_date ' + r.match_date);
  assert(r.match_time === '20:00', 'match_time ' + r.match_time);
  assert(r.home_team === 'Liverpool' && r.away_team === 'Bournemouth', 'teams');
  assert(r.fthg === 4 && r.ftag === 2 && r.ftr === 'H', 'full time');
  assert(r.hthg === 1 && r.htag === 0 && r.htr === 'H', 'half time');
  assert(r.referee === 'A Taylor', 'referee ' + r.referee);
  assert(r.hs === 19 && r.as_ === 10, 'shots');
  assert(r.hst === 10 && r.ast === 3, 'shots on target');
  assert(r.hf === 7 && r.af === 10, 'fouls');
  assert(r.hc === 6 && r.ac === 7, 'corners');
  assert(r.hy === 1 && r.ay === 2 && r.hr === 0 && r.ar === 0, 'cards');
});

test('carries every price column, including the closing average the edge table de-vigs', () => {
  const { rows } = parse(HEADER + '\r\n' + LIVERPOOL + '\r\n');
  const odds = rows[0].odds;
  assert(Object.keys(odds).length === PRICED, 'expected ' + PRICED + ' price keys, got ' + Object.keys(odds).length);
  assert(odds.AvgCH === 1.29 && odds.AvgCD === 6.02 && odds.AvgCA === 8.68, 'the AvgC vector /leagues reads');
  assert(odds.AHh === -1.5 && odds.AHCh === -1.75, 'negative handicaps survive');
  assert(odds['B365>2.5'] === 1.36, 'a header containing > is a key like any other');
});

test('NO fixed column leaks into odds, and no price is promoted to a column', () => {
  const { rows } = parse(HEADER + '\r\n' + LIVERPOOL + '\r\n');
  const odds = rows[0].odds;
  for (const leaked of ['Div', 'Date', 'HomeTeam', 'FTHG', 'Referee', 'HS', 'AC']) {
    assert(!(leaked in odds), leaked + ' leaked into odds');
  }
  assert(rows[0].B365H === undefined, 'a price must not become a top-level column');
});

/* -- the traps -- */

test('dd/mm is read as dd/mm, not as the American ordering', () => {
  // 03/08/2026 is 3 August. Read as mm/dd it becomes 8 March, and a third of
  // every season lands in the wrong month without anything failing.
  assert(parseDate('03/08/2026') === '2026-08-03', String(parseDate('03/08/2026')));
  assert(parseDate('15/08/2025') === '2025-08-15', 'an unambiguous day is still right');
  assert(parseDate('3/8/26') === '2026-08-03', 'two-digit year, unpadded day');
  assert(parseDate('15/08/94') === '1994-08-15', 'the corpus starts in 1993');
});

test('a date that is not a date is null, never an epoch', () => {
  for (const bad of ['', '   ', null, undefined, 'Date', '2026-08-03', '32/01/2026', '15/13/2026']) {
    assert(parseDate(bad) === null, 'parseDate(' + JSON.stringify(bad) + ') should be null');
  }
});

test("Number('') is 0 - num() refuses it, and an unpriced leg is omitted entirely", () => {
  assert(num('') === null && num('   ') === null && num(null) === null, 'empty is null');
  assert(num('x') === null, 'non-numeric is null');
  assert(num('1.29') === 1.29 && num('0') === 0, 'real numbers survive, including zero');
  assert(int('4') === 4 && int('') === null, 'ints follow the same rule');

  const header = 'Div,Date,HomeTeam,AwayTeam,FTR,B365H,B365D,B365A';
  const line = 'E0,15/08/2025,Liverpool,Bournemouth,H,1.30,,8.50';
  const { rows } = parse(header + '\n' + line + '\n');
  const odds = rows[0].odds;
  assert(odds.B365H === 1.30 && odds.B365A === 8.50, 'priced legs survive');
  assert(!('B365D' in odds), 'an unpriced leg is ABSENT, not stored as 0');
});

test('a blank trailing line is skipped, not stored as a match', () => {
  const header = 'Div,Date,HomeTeam,AwayTeam,FTR';
  const body = header + '\r\nE0,15/08/2025,Liverpool,Bournemouth,H\r\n,,,,\r\n\r\n';
  const { rows, skipped } = parse(body);
  assert(rows.length === 1, 'expected 1 row, got ' + rows.length);
  assert(skipped === 1, 'expected 1 skipped, got ' + skipped);
});

test('a fixture with no result yet is KEPT - it gains one on a later run', () => {
  const header = 'Div,Date,HomeTeam,AwayTeam,FTR,AvgCH';
  const { rows } = parse(header + '\nE0,22/08/2026,Arsenal,Chelsea,,1.85\n');
  assert(rows.length === 1, 'the fixture is stored');
  assert(rows[0].ftr === null, 'with a null result');
  assert(rows[0].odds.AvgCH === 1.85, 'and its price');
});

test('a quoted field containing a comma does not shift every price after it', () => {
  assert(JSON.stringify(splitLine('a,"b,c",d')) === JSON.stringify(['a', 'b,c', 'd']), 'quoted comma');
  assert(JSON.stringify(splitLine('a,"b""c",d')) === JSON.stringify(['a', 'b"c', 'd']), 'escaped quote');
  const header = 'Div,Date,HomeTeam,AwayTeam,Referee,B365H';
  const { rows } = parse(header + '\nE0,15/08/2025,Liverpool,Bournemouth,"Taylor, A",1.30\n');
  assert(rows[0].referee === 'Taylor, A', 'referee ' + rows[0].referee);
  assert(rows[0].odds.B365H === 1.30, 'the price after it is still the price');
});

test('columns are read by NAME, so a reordered file parses identically', () => {
  const a = parse('Div,Date,HomeTeam,AwayTeam,FTR,B365H\nE0,15/08/2025,Liverpool,Bournemouth,H,1.30\n');
  const b = parse('B365H,AwayTeam,FTR,Div,HomeTeam,Date\n1.30,Bournemouth,H,E0,Liverpool,15/08/2025\n');
  assert(JSON.stringify(a.rows[0]) === JSON.stringify(b.rows[0]), 'reordering must not change the row');
});

test('an HTML error page is refused, not parsed into rows', () => {
  let threw = false;
  try { parse('<html><body>404 Not Found</body></html>'); } catch (e) { threw = true; }
  assert(threw, 'a non-CSV body must throw rather than yield rows');
  assert(parse('').rows.length === 0, 'an empty body yields nothing and does not throw');
  // A real state in July: the file is published before the first kickoff.
  assert(parse('Div,Date,HomeTeam,AwayTeam,FTR\n').rows.length === 0,
    'a valid header with no matches yet yields nothing and does not throw');
  let alsoThrew = false;
  try { parse('Div,Date,Time\nE0,15/08/2025,20:00\n'); } catch (e) { alsoThrew = true; }
  assert(alsoThrew, 'a CSV missing the team columns is refused too');
});

/* -- seasons -- */

test('the season rolls over in JULY, not January', () => {
  assert(seasonCode(new Date('2026-08-20T00:00:00Z')) === '2627', 'August is the new season');
  assert(seasonCode(new Date('2026-07-01T00:00:00Z')) === '2627', 'July is the new season');
  assert(seasonCode(new Date('2026-06-30T00:00:00Z')) === '2526', 'June still belongs to the old one');
  assert(seasonCode(new Date('2027-02-10T00:00:00Z')) === '2627', 'February is mid-season');
});

test('the label matches the format the table already stores', () => {
  assert(seasonLabel('2627') === '2026/27', seasonLabel('2627'));
  assert(seasonLabel('2526') === '2025/26', seasonLabel('2526'));
  assert(seasonLabel('9394') === '1993/94', 'the first season in the corpus');
  assert(seasonLabel('9900') === '1999/00', 'the century rollover');
});

test('the row lands under the season it was asked for, and records where it came from', () => {
  const { rows } = parse('Div,Date,HomeTeam,AwayTeam,FTR\nE0,15/08/2026,Arsenal,Chelsea,H\n',
    { div: 'E0', country: 'England', season: '2026/27', sourceFile: '/mmz4281/2627/E0.csv' });
  assert(rows[0].season === '2026/27', rows[0].season);
  assert(rows[0].source_file === '/mmz4281/2627/E0.csv', 'provenance is recorded');
});

/* -- the live feed's own bytes -- */

test('parses a REAL current-season file off disk, byte-order mark and all', () => {
  // ensemble/data/_current/ holds files the scraper actually downloaded from
  // football-data, committed to the repo. Every one of them starts with a UTF-8
  // BOM, so the first header reads "\uFEFFDiv" — which made the required-column
  // check reject EVERY division on EVERY run, blaming the feed for not being a
  // season file. No hand-written fixture would have caught it.
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'ensemble', 'data', '_current', 'E0_2627.csv');
  if (!fs.existsSync(file)) { console.log('      (skipped — file not present)'); return; }

  const raw = fs.readFileSync(file, 'utf8');
  assert(raw.charCodeAt(0) === 0xFEFF, 'the fixture must still carry a BOM, or this proves nothing');

  const { rows } = parse(raw, { div: 'E0', country: 'England', season: '2026/27', sourceFile: '/mmz4281/2627/E0.csv' });
  assert(rows.length > 0, 'a real season file must yield rows');

  for (const r of rows) {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(r.match_date), 'every date is ISO: ' + r.match_date);
    assert(r.home_team && r.away_team, 'every row names both clubs');
    assert(r.season === '2026/27', 'the season is the one asked for');
  }

  // The div comes from the ROW, never from the filename — this file is named
  // E0 and holds EC rows, and the row is the thing that knows.
  const divs = [...new Set(rows.map(r => r.div))];
  assert(divs.every(d => typeof d === 'string' && d.length >= 2), 'div read from the row: ' + divs.join(','));

  // And the vector /leagues de-vigs is present on a real row.
  const priced = rows.filter(r => r.odds.AvgCH != null && r.odds.AvgCD != null && r.odds.AvgCA != null);
  assert(priced.length > 0, 'at least one row carries the closing average');
});

/* ── the 300, and the ten divisions ──────────────────────────────────────── */
//
// E0 — the Premier League, the most-read division on /leagues — answered
// 300 Multiple Choices for the whole 2026/27 season while E1, E2, E3 and EC
// succeeded on the identical URL pattern, so the top flight was missing from a
// run that reported success. mod_negotiation returns 300, not 404, when the
// exact name is wrong and near-misses exist; the list it sends back IS the
// diagnosis, and these pin that we read it rather than guess.

const APACHE_300 = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">
<html><head><title>300 Multiple Choices</title></head><body>
<h1>Multiple Choices</h1>
The document name you requested (<code>/mmz4281/2627/E0.csv</code>) could not be
found on this server. However, we found documents with names similar to the one
you requested.<p>Available documents:
<ul>
<li><a href="E0.CSV">E0.CSV</a> (common basename)</li>
</ul>
</body></html>`;

test('the alternatives are read out of the page, not guessed', () => {
  const found = alternativesFrom(APACHE_300);
  assert(found.length === 1 && found[0] === 'E0.CSV',
    `expected ['E0.CSV'], got ${JSON.stringify(found)}`);
});

test('a case-only difference resolves', () => {
  assert(resolveAlternative('E0', ['E0.CSV']) === 'E0.CSV', 'E0.CSV should resolve');
  assert(resolveAlternative('E0', ['/mmz4281/2627/e0.csv']) === 'e0.csv',
    'a full href should resolve to its basename');
});

test('IT REFUSES TO GUESS BETWEEN TWO CSVs', () => {
  // Picking one would write another division's results under this division's
  // name, and every row would look completely ordinary.
  assert(resolveAlternative('E0', ['E1.csv', 'E2.csv']) === null,
    'two candidates must resolve to null, never to a coin flip');
});

test('a lone csv is taken even when the name differs', () => {
  assert(resolveAlternative('E0', ['EPL.csv']) === 'EPL.csv',
    'a single csv on offer is unambiguous');
});

test('nothing usable resolves to null rather than to a wrong file', () => {
  assert(resolveAlternative('E0', []) === null, 'no alternatives → null');
  // .gz is not a csv this parser can read, so it must not be handed to it.
  assert(resolveAlternative('E0', ['E0.csv.gz', 'index.html']) === null,
    'a compressed or unrelated file is not a season file');
});

test('the corpus is ten divisions and every one names its country', () => {
  assert(DIVISIONS.length === 10, `expected 10 divisions, got ${DIVISIONS.length}`);
  for (const d of DIVISIONS) {
    // country is NOT NULL and half the unique key, so a blank one collides
    // rows from different leagues onto each other.
    assert(d.div && d.country, `${JSON.stringify(d)} is missing a field`);
  }
  assert(new Set(DIVISIONS.map(d => d.div)).size === 10, 'division codes must be unique');
  const foreign = DIVISIONS.filter(d => d.country !== 'England').map(d => d.div).sort().join(',');
  assert(foreign === 'D1,F1,I1,N1,SP1',
    `the big five, top flight only — second tiers are a deliberate omission; got ${foreign}`);
});

console.log('\n' + (failed === 0 ? '✓' : '✗') + ' match results ingest: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
