// Importe le championnat Score7 (Bajada championship 4) dans l'application.
// Usage : BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... node scripts/import-score7.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Identifiants Score7 des paires (22176770 + n).
const TEAMS = {
  70: '$.Omar & $.Aymen', 71: '$.Hamza & $.Kais', 72: '$.Oussama & $Aziz', 73: '$Zied & Kais',
  74: '$Naim & $Haithem', 75: '$.Omar & $.Med Amine', 76: '$.Baha & $Yassine', 77: '$Moez & $Moetez',
  78: '$.Morsi & $.Houssem', 79: 'Daly & Syrine', 80: '$.Seif & $.Ihsen', 81: 'Nassim & Oussama',
};

// [n° du match Score7 (113339xxx), domicile, extérieur, timestamp, sets domicile, sets extérieur]
// La journée se déduit du n° : 291-296 = J1, 297-302 = J2, etc.
const MATCHES = [
  [291, 70, 81, 1792090800, [3, 6, 6], [6, 1, 4]], [292, 71, 80, 1792177200, [3, 5], [6, 7]],
  [293, 79, 72, 1792522800, [4, 4], [6, 6]], [294, 73, 78, 1792177200, [6, 6], [0, 3]],
  [295, 77, 74, 1792090800, [1, 5], [6, 7]], [296, 75, 76, 1792090800, [6, 7], [3, 6]],
  [297, 80, 70, 1792695600], [298, 81, 79, 1792782000], [299, 78, 71, 1792787400],
  [300, 72, 77, 1793041200], [301, 76, 73, 1792787400], [302, 74, 75, 1792782000],
  [303, 70, 79, 1793127600], [304, 80, 78, 1793127600], [305, 77, 81, 1793127600],
  [306, 71, 76, 1793133000], [307, 75, 72, 1793133000], [308, 73, 74, 1793127600],
  [309, 78, 70, 1793386800], [310, 79, 77, 1793386800], [311, 76, 80, 1793392200],
  [312, 81, 75, 1793127600], [313, 74, 71, 1793386800], [314, 72, 73, 1793392200],
  [315, 70, 77], [316, 78, 76], [317, 75, 79], [318, 80, 74], [319, 73, 81], [320, 71, 72],
  [321, 76, 70], [322, 77, 75], [323, 74, 78], [324, 79, 73], [325, 72, 80], [326, 81, 71],
  [327, 70, 75], [328, 76, 74], [329, 73, 77], [330, 78, 72], [331, 71, 79], [332, 80, 81],
  [333, 74, 70], [334, 75, 73], [335, 72, 76], [336, 77, 71], [337, 81, 78], [338, 79, 80],
  [339, 70, 73], [340, 74, 72], [341, 71, 75], [342, 76, 81], [343, 80, 77], [344, 78, 79],
  [345, 72, 70], [346, 73, 71], [347, 81, 74], [348, 75, 80], [349, 79, 76], [350, 77, 78],
  [351, 70, 71], [352, 72, 81], [353, 80, 73], [354, 74, 79], [355, 78, 75], [356, 76, 77],
];

// "$.Omar & $.Aymen " -> "Omar & Aymen" (le $ marque le sponsor maillot sur Score7)
const clean = (s) => s.replace(/\$\.?/g, '').replace(/\s+/g, ' ').trim();
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (ts) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

const teams = Object.entries(TEAMS).map(([k, raw]) => {
  const name = clean(raw);
  const [p1, p2] = name.split(' & ');
  return { key: k, name, p1, p2 };
});
const matches = MATCHES.map(([n, home, away, ts, hs, as]) => ({
  team1: String(home), team2: String(away), round: Math.floor((n - 291) / 6) + 1,
  ...(ts ? when(ts) : {}),
  ...(hs ? { sets: hs.map((h, i) => [h, as[i]]) } : {}),
}));

// Contrôles de cohérence avant envoi
const rounds = new Map();
for (const m of matches) (rounds.get(m.round) ?? rounds.set(m.round, []).get(m.round)).push(m.team1, m.team2);
for (const [r, ts] of rounds) if (new Set(ts).size !== 12) throw new Error(`Journée ${r} : les 12 paires ne jouent pas toutes une fois`);
if (matches.length !== 66) throw new Error(`66 matchs attendus, ${matches.length} trouvés`);

(async () => {
  const call = async (p, body, token) => {
    const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`${p} : ${data.error}`);
    return data;
  };
  const { token } = await call('/api/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD });
  let description = '';
  try { description = fs.readFileSync(path.join(__dirname, '..', 'public', 'rules-default.txt'), 'utf8'); } catch {}
  const r = await call('/api/import', {
    name: 'Bajada Championship 4 Edition', date: '2026-10-16', location: 'Padelios',
    qualifiers: 4, win_pts: 3, loss_pts: 0, description, teams, matches,
  }, token);
  console.log(`Importé : ${BASE}/#/t/${r.slug} (${teams.length} paires, ${matches.length} matchs, ${matches.filter((m) => m.sets).length} joués)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
