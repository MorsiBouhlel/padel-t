// Logique pure : poules, classements, tableau final.
// Enveloppé dans une fonction : chargé aussi comme script classique par le navigateur, ses noms ne doivent pas entrer en conflit avec ceux de app.js.
(function () {

// Méthode du cercle. Retourne une liste de journées, chacune une liste de [a, b].
// legs = 2 : matchs retour (domicile/extérieur inversés) à la suite.
function roundRobin(ids, legs = 1) {
  const first = roundRobinLeg(ids);
  return legs === 2 ? [...first, ...first.map((r) => r.map(([a, b]) => [b, a]))] : first;
}

function roundRobinLeg(ids) {
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a !== null && b !== null) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

// Répartition en serpent des équipes (déjà mélangées) dans `count` poules.
function snakeGroups(teamIds, count) {
  const groups = Array.from({ length: count }, () => []);
  teamIds.forEach((id, i) => {
    const row = Math.floor(i / count);
    const col = i % count;
    groups[row % 2 ? count - 1 - col : col].push(id);
  });
  return groups;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// sets : [[6,4],[3,6],[7,5]] vu du point de vue de team1/team2.
function matchResult(sets) {
  let s1 = 0, s2 = 0, g1 = 0, g2 = 0;
  for (const [a, b] of sets || []) {
    g1 += a; g2 += b;
    if (a > b) s1++; else if (b > a) s2++;
  }
  return { s1, s2, g1, g2, winner: s1 > s2 ? 1 : s2 > s1 ? 2 : 0 };
}

function validSets(sets) {
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > 5) return false;
  return sets.every(
    (s) => Array.isArray(s) && s.length === 2 && s.every((n) => Number.isInteger(n) && n >= 0 && n <= 99)
  ) && matchResult(sets).winner !== 0;
}

// Classement d'une poule. matches : matchs de cette poule (winner null = pas joué, -1 = double forfait).
// Départage : points, différence de jeux, jeux marqués, confrontation directe (égalité à deux),
// matchs joués (moins = mieux), puis ordre d'inscription (équivalent du tirage au sort).
function standings(teams, matches, winPts, lossPts) {
  const rows = new Map(
    teams.map((t) => [t.id, { id: t.id, played: 0, won: 0, lost: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0, penalty: t.penalty || 0, points: -(t.penalty || 0) }])
  );
  for (const m of matches) {
    if (!m.winner) continue;
    const a = rows.get(m.team1), b = rows.get(m.team2);
    if (!a || !b) continue;
    if (m.winner === -1) { // double forfait : défaite 0-6 0-6 pour les deux paires
      for (const x of [a, b]) { x.played++; x.lost++; x.setsAgainst += 2; x.gamesAgainst += 12; x.points += lossPts; }
      continue;
    }
    const r = matchResult(m.sets);
    a.played++; b.played++;
    a.setsFor += r.s1; a.setsAgainst += r.s2; b.setsFor += r.s2; b.setsAgainst += r.s1;
    a.gamesFor += r.g1; a.gamesAgainst += r.g2; b.gamesFor += r.g2; b.gamesAgainst += r.g1;
    const [w, l] = r.winner === 1 ? [a, b] : [b, a];
    w.won++; l.lost++; w.points += winPts; l.points += lossPts;
  }
  const list = [...rows.values()];
  const headToHead = (x, y) => {
    const m = matches.find((m) => m.winner > 0 && ((m.team1 === x.id && m.team2 === y.id) || (m.team1 === y.id && m.team2 === x.id)));
    if (!m) return 0;
    return (m.winner === 1 ? m.team1 : m.team2) === x.id ? -1 : 1;
  };
  const tiedPair = (x, y) => x.points === y.points && x.gamesFor - x.gamesAgainst === y.gamesFor - y.gamesAgainst &&
    x.gamesFor === y.gamesFor && list.filter((z) => z.points === x.points && z.gamesFor === x.gamesFor && z.gamesFor - z.gamesAgainst === x.gamesFor - x.gamesAgainst).length === 2;
  list.sort((x, y) =>
    y.points - x.points ||
    (y.gamesFor - y.gamesAgainst) - (x.gamesFor - x.gamesAgainst) ||
    y.gamesFor - x.gamesFor ||
    (tiedPair(x, y) ? headToHead(x, y) : 0) ||
    x.played - y.played ||
    x.id - y.id
  );
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

function nextPow2(n) {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

// seeds : ids des équipes qualifiées, de la meilleure tête de série à la moins bonne.
// Retourne { size, rounds } ; rounds[0] = premier tour, chaque match { pos, team1, team2 } (null = bye / à venir).
function buildBracket(seeds, thirdPlace = false) {
  const size = nextPow2(seeds.length);
  const order = seedOrder(size);
  const seedTeam = (s) => (s <= seeds.length ? seeds[s - 1] : null);
  const rounds = [];
  const first = [];
  for (let i = 0; i < size / 2; i++) {
    first.push({ pos: i, team1: seedTeam(order[2 * i]), team2: seedTeam(order[2 * i + 1]) });
  }
  rounds.push(first);
  for (let n = size / 4; n >= 1; n /= 2) {
    rounds.push(Array.from({ length: n }, (_, pos) => ({ pos, team1: null, team2: null })));
  }
  if (thirdPlace && size >= 4) rounds[rounds.length - 1].push({ pos: 1, team1: null, team2: null });
  return { size, rounds };
}

function roundName(round, totalRounds, pos = 0) {
  if (round === totalRounds && pos === 1) return 'Match pour la 3e place';
  const left = totalRounds - round;
  if (left === 0) return 'Finale';
  if (left === 1) return 'Demi-finales';
  if (left === 2) return 'Quarts de finale';
  return `${2 ** (left + 1)}es de finale`;
}

// Retard d'un match de poule sans résultat. today / m.date / m.deadline : 'YYYY-MM-DD'.
// 'forfeit' : la journée suivante a commencé (défaite 6-0 6-0 pour les deux paires) ; 'late' : date dépassée.
function lateState(m, today) {
  if (m.stage !== 'group' || m.winner || !m.team1 || !m.team2 || !m.date) return null;
  if (m.deadline && today >= m.deadline) return 'forfeit';
  return m.date < today ? 'late' : null;
}

// Têtes de série des play-offs : rang dans la poule, puis points, diff. de sets, diff. de jeux.
// groups : [{ rows }] (classements de poule), teamGroup : Map id d'équipe → poule.
function knockoutSeeds(groups, teamGroup, qualifiers) {
  const pool = groups.flatMap((g) => g.rows.filter((r) => r.rank <= qualifiers));
  const perf = (a, b) => b.points - a.points ||
    (b.setsFor - b.setsAgainst) - (a.setsFor - a.setsAgainst) ||
    (b.gamesFor - b.gamesAgainst) - (a.gamesFor - a.gamesAgainst);
  const winnersOrder = pool.filter((r) => r.rank === 1).sort(perf).map((r) => teamGroup.get(r.id));
  // Les rangs suivants gardent l'ordre des groupes des premiers : évite les chocs entre équipes d'une même poule au 1er tour.
  pool.sort((a, b) => a.rank - b.rank ||
    (a.rank === 1 ? perf(a, b) : winnersOrder.indexOf(teamGroup.get(a.id)) - winnersOrder.indexOf(teamGroup.get(b.id))));
  return pool.map((r) => r.id);
}

// Journée en cours : la plus avancée parmi les matchs de poule joués ou datés d'aujourd'hui ou avant (0 = pas commencée).
function currentRound(matches, today) {
  return matches.reduce((r, m) => (m.stage === 'group' && (m.winner || (m.date && m.date <= today)) ? Math.max(r, m.round) : r), 0);
}

// Pénalité d'un changement de partenaire : 2 points à partir de la journée 4.
const partnerPenalty = (round) => (round >= 4 ? 2 : 0);

const api = { knockoutSeeds, currentRound, partnerPenalty, lateState, roundRobin, snakeGroups, shuffle, matchResult, validSets, standings, buildBracket, roundName, nextPow2 };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else self.PadelLogic = api;
})();
