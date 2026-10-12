'use strict';

/**
 * lib/clubNames — the name a reader sees for a club in settled_match_prices.
 *
 * The results feed behind settled_match_prices abbreviates clubs ("For Sittard",
 * "Nott'm Forest", "Ein Frankfurt") and, worse, spells some clubs two ways in the
 * SAME season ("Sheffield Wed" and "Sheffield Weds", "Ath Madrid" and
 * "Atl. Madrid"). Tallying by the raw string splits those clubs into two rows,
 * each with half a season, which changes their numbers and can keep them out of
 * the ranking altogether. So the map is applied to the tally KEY, not only to the
 * label: two spellings of one club become one row.
 *
 * Keys are feed spellings, values the display name. A name not listed passes
 * through unchanged. Common short forms that read naturally (Swansea, Burnley,
 * Man City, Wolves, Paris SG) are left alone; only names that look wrong or
 * collide are changed.
 *
 * eve-frontend lib/edgeTable.ts must carry the same map so /leagues and the
 * Discord card agree.
 */

const CLUB_NAMES = {
  // England
  "Nott'm Forest": 'Nottingham Forest',
  Peterboro: 'Peterborough',
  'Sheffield Wed': 'Sheffield Wednesday',
  'Sheffield Weds': 'Sheffield Wednesday',
  Bradford: 'Bradford City',
  'Bristol Rvs': 'Bristol Rovers',
  'Boston Utd': 'Boston United',
  'Milton Keynes Dons': 'MK Dons',
  // Germany
  'Ein Frankfurt': 'Eintracht Frankfurt',
  "M'gladbach": 'Borussia Mönchengladbach',
  'FC Koln': 'FC Köln',
  Dortmund: 'Borussia Dortmund',
  Leverkusen: 'Bayer Leverkusen',
  // Spain
  'Ath Bilbao': 'Athletic Bilbao',
  'Ath Madrid': 'Atlético Madrid',
  'Atl. Madrid': 'Atlético Madrid',
  'Dep. A Coruna': 'Deportivo La Coruña',
  'La Coruna': 'Deportivo La Coruña',
  Espanol: 'Espanyol',
  Sociedad: 'Real Sociedad',
  Celta: 'Celta Vigo',
  Vallecano: 'Rayo Vallecano',
  Santander: 'Racing Santander',
  Betis: 'Real Betis',
  // Netherlands
  'For Sittard': 'Fortuna Sittard',
  'Den Haag': 'ADO Den Haag',
  Nijmegen: 'NEC Nijmegen',
  Zwolle: 'PEC Zwolle',
  'PSV Eindhoven': 'PSV',
  'AZ Alkmaar': 'AZ',
};

const clubName = raw => {
  const s = typeof raw === 'string' ? raw.trim() : raw;
  return CLUB_NAMES[s] ?? s;
};

module.exports = { CLUB_NAMES, clubName };
