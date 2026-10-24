// Prévisions : chances de chaque paire (qualification, 1re de poule, finale, victoire, podium) par simulation.
//
// 1. Niveau de chaque paire : régression logistique sur les SETS déjà joués (un set = un duel), avec une pénalité
//    qui ramène les niveaux vers la moyenne tant qu'il y a peu de résultats (deux matchs ne prouvent rien : lambda = 4, soit un écart-type de 0,5 sur l'échelle logistique).
//    Forfaits et doubles forfaits sont ignorés : ils ne disent rien du niveau.
// 2. Simulation de N tournois : matchs restants tirés au sort selon les niveaux, classement par les vraies règles
//    (L.standings), tableau final construit comme l'application le fait (L.knockoutSeeds, L.buildBracket).
// Logique pure : aucune base de données ici (voir test/forecast.test.js).
const L = require('./logic');

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
// Probabilité de gagner un match en 2 sets gagnants quand on gagne chaque set avec la probabilité p.
const matchProb = (p) => p * p * (3 - 2 * p);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Niveaux (échelle logistique, moyenne ≈ 0) dans l'ordre de teamIds.
function fitRatings(teamIds, matches, lambda = 4) {
  const idx = new Map(teamIds.map((id, i) => [id, i]));
  const obs = []; // [i, j, y] : y = 1 si i gagne le set
  for (const m of matches) {
    if (!m.sets || m.forfeit || m.winner === -1) continue;
    const i = idx.get(m.team1), j = idx.get(m.team2);
    if (i === undefined || j === undefined) continue;
    for (const [a, b] of m.sets) if (a !== b) obs.push([i, j, a > b ? 1 : 0]);
  }
  const n = teamIds.length;
  const r = new Array(n).fill(0);
  for (let it = 0; it < 80; it++) {
    const g = r.map((v) => -lambda * v), h = new Array(n).fill(lambda);
    for (const [i, j, y] of obs) {
      const p = sigmoid(r[i] - r[j]), e = y - p, w = p * (1 - p);
      g[i] += e; g[j] -= e; h[i] += w; h[j] += w;
    }
    for (let i = 0; i < n; i++) r[i] += (0.8 * g[i]) / h[i];
  }
  return { ratings: r, sets: obs.length };
}

// Jeux d'un set simulé (vu de l'équipe 1) : 6-x ou 7-5 / 7-6.
const LOSER_GAMES = [0.07, 0.12, 0.18, 0.22, 0.24, 0.12, 0.05];
function setScore(rng, team1Wins) {
  let u = rng(), k = 0;
  while (k < 6 && u >= LOSER_GAMES[k]) { u -= LOSER_GAMES[k]; k++; }
  const win = k >= 5 ? 7 : 6;
  return team1Wins ? [win, k] : [k, win];
}
function simulateMatch(m, p, rng) {
  const sets = [];
  let w1 = 0, w2 = 0;
  while (w1 < 2 && w2 < 2) {
    const t1 = rng() < p;
    sets.push(setScore(rng, t1));
    if (t1) w1++; else w2++;
  }
  return { team1: m.team1, team2: m.team2, sets, winner: w1 > w2 ? m.team1 : m.team2, forfeit: null };
}

// Joue (ou rejoue) un tableau : rounds[r][p] = { pos, team1, team2, winner? }. Les résultats connus sont respectés,
// les autres matchs sont tirés au sort. Retourne { champion, finalist, thirds[] }.
function playKnockout(rounds, rate, rng) {
  const R = rounds.length;
  const slots = rounds.map((ms) => ms.map(() => [null, null]));
  const lose = [];
  const win = [];
  for (let r = 0; r < R; r++) {
    win[r] = []; lose[r] = [];
    rounds[r].forEach((m, p) => {
      const a = m.team1 ?? slots[r][p][0], b = m.team2 ?? slots[r][p][1];
      let w = null, l = null;
      if (m.winner > 0) { w = m.winner; l = w === a ? b : a; }
      else if (a != null && b != null) {
        w = rng() < matchProb(sigmoid(rate.get(a) - rate.get(b))) ? a : b;
        l = w === a ? b : a;
      } else if (a != null || b != null) w = a ?? b; // exempt
      win[r][p] = w; lose[r][p] = l;
      if (r < R - 1) {
        const slot = p % 2;
        if (rounds[r + 1][p >> 1]) slots[r + 1][p >> 1][slot] = w;
        if (r === R - 2 && rounds[R - 1][1]) slots[R - 1][1][slot] = l; // perdants des demi-finales → match pour la 3e place
      }
    });
  }
  const thirds = rounds[R - 1][1] ? [win[R - 1][1]] : R >= 2 ? lose[R - 2].filter((x) => x != null) : [];
  return { champion: win[R - 1][0], finalist: lose[R - 1][0], thirds: thirds.filter((x) => x != null) };
}

// tournament : { phase, groups_count, qualifiers, win_pts, loss_pts, third_place } ; teams : [{ id, grp }] ;
// matches : tous les matchs (sets déjà décodés). Retourne les probabilités (0..1) par paire.
function forecast({ tournament: t, teams, matches, sims = 5000, seed = 20261023 }) {
  if (t.phase === 'setup' || !matches.some((m) => m.stage === 'group')) return { status: 'setup', sims: 0, teams: [] };
  const ids = teams.map((x) => x.id);
  const { ratings, sets } = fitRatings(ids, matches);
  const rate = new Map(ids.map((id, i) => [id, ratings[i]]));
  const rng = mulberry32(seed);
  const teamGroup = new Map(teams.map((x) => [x.id, x.grp]));
  const groups = Array.from({ length: t.groups_count }, (_, g) => {
    const gt = teams.filter((x) => x.grp === g);
    const gm = matches.filter((m) => m.stage === 'group' && m.grp === g && m.team1 && m.team2);
    return {
      teams: gt,
      played: gm.filter((m) => m.winner),
      todo: gm.filter((m) => !m.winner).map((m) => ({ m, p: matchProb(sigmoid(rate.get(m.team1) - rate.get(m.team2))) })),
    };
  });
  const groupsOpen = groups.some((g) => g.todo.length);
  const koMatches = matches.filter((m) => m.stage === 'ko');
  const realRounds = [];
  for (const m of koMatches) (realRounds[m.round - 1] ??= []).push(m);
  const realBracket = realRounds.length ? realRounds.map((ms) => ms.sort((a, b) => a.pos - b.pos)) : null;

  const zero = () => ({ qualify: 0, first: 0, final: 0, champion: 0, third: 0, podium: 0, rankSum: 0, pointsSum: 0 });
  const acc = new Map(ids.map((id) => [id, zero()]));
  const settled = realBracket && !groupsOpen && koMatches.every((m) => m.winner > 0);
  const n = settled ? 1 : sims; // tout est joué : une seule passe suffit
  for (let s = 0; s < n; s++) {
    const st = groups.map((g) => ({ rows: L.standings(g.teams, g.played.concat(g.todo.map(({ m, p }) => simulateMatch(m, p, rng))), t.win_pts, t.loss_pts) }));
    for (const g of st) for (const row of g.rows) {
      const a = acc.get(row.id);
      a.rankSum += row.rank; a.pointsSum += row.points;
      if (row.rank === 1) a.first++;
      if (row.rank <= t.qualifiers) a.qualify++;
    }
    let rounds = realBracket;
    if (!rounds) {
      const seeds = L.knockoutSeeds(st, teamGroup, t.qualifiers);
      rounds = seeds.length >= 2 ? L.buildBracket(seeds, !!t.third_place).rounds : null;
    }
    if (!rounds) continue;
    const res = playKnockout(rounds, rate, rng);
    if (res.champion != null) { const a = acc.get(res.champion); a.champion++; a.podium++; }
    if (res.finalist != null) { const a = acc.get(res.finalist); a.final++; a.podium++; }
    if (res.champion != null) acc.get(res.champion).final++;
    for (const x of res.thirds) { const a = acc.get(x); a.third++; a.podium++; }
  }
  const out = teams.map((x) => {
    const a = acc.get(x.id);
    return {
      id: x.id, rating: rate.get(x.id), qualify: a.qualify / n, first: a.first / n, final: a.final / n, champion: a.champion / n,
      third: a.third / n, podium: a.podium / n, avgRank: a.rankSum / n, avgPoints: a.pointsSum / n,
    };
  });
  const gm = matches.filter((m) => m.stage === 'group');
  return {
    status: 'ok', phase: t.phase, sims: n, sets, qualifiers: t.qualifiers, thirdPlace: !!t.third_place,
    groupsPlayed: gm.filter((m) => m.winner).length, groupsTotal: gm.length, teams: out,
  };
}

module.exports = { forecast, fitRatings, matchProb, mulberry32, playKnockout };
