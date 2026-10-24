const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/logic');
const { forecast, fitRatings, matchProb } = require('../lib/forecast');

// Poule unique de n équipes (id 1..n), aller simple ; played(i, j) → sets (vus de i) ou null.
const league = (n, played, extra = {}) => {
  const teams = Array.from({ length: n }, (_, i) => ({ id: i + 1, grp: 0, penalty: 0 }));
  const matches = [];
  let id = 0;
  L.roundRobin(teams.map((x) => x.id)).forEach((pairs, r) => pairs.forEach(([a, b], pos) => {
    const sets = played ? played(a, b) : null;
    matches.push({ id: ++id, stage: 'group', grp: 0, round: r + 1, pos, team1: a, team2: b, sets, winner: sets ? (L.matchResult(sets).winner === 1 ? a : b) : null, forfeit: null });
  }));
  return { tournament: { phase: 'groups', groups_count: 1, qualifiers: 4, win_pts: 3, loss_pts: 0, third_place: 1, ...extra }, teams, matches };
};
const sum = (r, k) => r.teams.reduce((n, t) => n + t[k], 0);

test('niveaux : la paire qui gagne tout est au-dessus de celle qui perd tout', () => {
  const { tournament, teams, matches } = league(4, (a, b) => (a < b ? [[6, 2], [6, 1]] : [[2, 6], [1, 6]]));
  const { ratings } = fitRatings(teams.map((x) => x.id), matches);
  assert.ok(ratings[0] > ratings[1] && ratings[1] > ratings[2] && ratings[2] > ratings[3]);
  assert.ok(Math.abs(ratings.reduce((n, v) => n + v, 0)) < 1e-6, 'moyenne nulle');
  assert.ok(tournament);
});

test('niveaux : forfaits ignorés', () => {
  const f = league(3, (a, b) => [[6, 0], [6, 0]]);
  f.matches.forEach((m) => { m.forfeit = 'team2'; });
  const { ratings, sets } = fitRatings(f.teams.map((x) => x.id), f.matches);
  assert.strictEqual(sets, 0);
  assert.ok(ratings.every((v) => v === 0));
});

test('probabilité de match : 50 % à niveau égal, croissante avec l\'écart de set', () => {
  assert.ok(Math.abs(matchProb(0.5) - 0.5) < 1e-12);
  assert.ok(matchProb(0.7) > 0.7 && matchProb(0.3) < 0.3);
});

test('sans aucun résultat : tout le monde a les mêmes chances, les totaux sont cohérents', () => {
  const r = forecast({ ...league(8, null), sims: 4000 });
  assert.strictEqual(r.status, 'ok');
  assert.ok(Math.abs(sum(r, 'champion') - 1) < 1e-9);
  assert.ok(Math.abs(sum(r, 'first') - 1) < 1e-9);
  assert.ok(Math.abs(sum(r, 'qualify') - 4) < 1e-9, 'les 4 premiers se qualifient');
  assert.ok(Math.abs(sum(r, 'final') - 2) < 1e-9);
  assert.ok(Math.abs(sum(r, 'podium') - 3) < 1e-9, 'champion + finaliste + 3e');
  for (const t of r.teams) assert.ok(Math.abs(t.champion - 1 / 8) < 0.025, `paire ${t.id} : ${t.champion}`);
});

test('une paire dominante a les meilleures chances', () => {
  const f = league(8, (a, b) => (a === 1 ? [[6, 1], [6, 2]] : b === 1 ? [[1, 6], [2, 6]] : null));
  const r = forecast({ ...f, sims: 3000 });
  const best = r.teams.reduce((m, t) => (t.champion > m.champion ? t : m));
  assert.strictEqual(best.id, 1);
  assert.ok(best.champion > 0.3 && best.qualify > 0.85);
});

test('poules terminées : qualification certaine ou impossible', () => {
  const f = league(6, (a, b) => (a < b ? [[6, 2], [6, 2]] : [[2, 6], [2, 6]]), { qualifiers: 2 });
  const r = forecast({ ...f, sims: 500 });
  const q = Object.fromEntries(r.teams.map((t) => [t.id, t.qualify]));
  assert.deepStrictEqual([q[1], q[2], q[3], q[6]], [1, 1, 0, 0]);
  assert.strictEqual(r.teams.find((t) => t.id === 1).first, 1);
});

test('phase finale : un résultat connu est respecté (finale jouée = 100 %)', () => {
  const f = league(4, (a, b) => (a < b ? [[6, 2], [6, 2]] : [[2, 6], [2, 6]]), { phase: 'knockout', qualifiers: 4 });
  const ko = (round, pos, t1, t2, winner) => ({ id: 100 + round * 10 + pos, stage: 'ko', round, pos, team1: t1, team2: t2, winner, sets: winner ? [[6, 3], [6, 3]] : null });
  f.matches.push(ko(1, 0, 1, 4, 1), ko(1, 1, 2, 3, 2), ko(2, 0, 1, 2, 2), ko(2, 1, 4, 3, 3));
  const r = forecast({ ...f, sims: 200 });
  const t = (id) => r.teams.find((x) => x.id === id);
  assert.strictEqual(t(2).champion, 1);
  assert.strictEqual(t(1).champion, 0);
  assert.strictEqual(t(1).final, 1);
  assert.strictEqual(t(3).third, 1);
  assert.strictEqual(t(4).podium, 0);
});

test('phase finale en cours : les demi-finalistes se partagent le titre', () => {
  const f = league(4, (a, b) => (a < b ? [[6, 2], [6, 2]] : [[2, 6], [2, 6]]), { phase: 'knockout', qualifiers: 4 });
  const ko = (round, pos, t1, t2) => ({ id: 100 + round * 10 + pos, stage: 'ko', round, pos, team1: t1, team2: t2, winner: null, sets: null });
  f.matches.push(ko(1, 0, 1, 4), ko(1, 1, 2, 3), ko(2, 0, null, null), ko(2, 1, null, null));
  const r = forecast({ ...f, sims: 3000 });
  assert.ok(Math.abs(sum(r, 'champion') - 1) < 1e-9);
  assert.ok(Math.abs(sum(r, 'podium') - 3) < 1e-9);
  assert.ok(r.teams.find((t) => t.id === 1).champion > r.teams.find((t) => t.id === 4).champion);
});

test('inscriptions : pas de prévision', () => {
  assert.strictEqual(forecast({ tournament: { phase: 'setup' }, teams: [], matches: [] }).status, 'setup');
});

test('têtes de série : 1er puis 2e de chaque poule', () => {
  const groups = [
    { rows: [{ id: 1, rank: 1, points: 9, setsFor: 6, setsAgainst: 0, gamesFor: 36, gamesAgainst: 12 }, { id: 2, rank: 2, points: 6, setsFor: 4, setsAgainst: 2, gamesFor: 30, gamesAgainst: 20 }] },
    { rows: [{ id: 3, rank: 1, points: 9, setsFor: 6, setsAgainst: 1, gamesFor: 36, gamesAgainst: 20 }, { id: 4, rank: 2, points: 3, setsFor: 2, setsAgainst: 4, gamesFor: 20, gamesAgainst: 30 }] },
  ];
  assert.deepStrictEqual(L.knockoutSeeds(groups, new Map([[1, 0], [2, 0], [3, 1], [4, 1]]), 2), [1, 3, 2, 4]);
});
