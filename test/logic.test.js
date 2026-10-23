const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/logic');

test('roundRobin : chaque paire se rencontre une fois', () => {
  for (const n of [3, 4, 5, 6]) {
    const pairs = L.roundRobin([...Array(n).keys()]).flat().map(([a, b]) => [a, b].sort().join('-'));
    assert.strictEqual(pairs.length, (n * (n - 1)) / 2);
    assert.strictEqual(new Set(pairs).size, pairs.length);
  }
});

test('buildBracket : byes pour les meilleures têtes de série', () => {
  const { size, rounds } = L.buildBracket([1, 2, 3, 4, 5, 6]);
  assert.strictEqual(size, 8);
  assert.deepStrictEqual(rounds.map((r) => r.length), [4, 2, 1]);
  const byes = rounds[0].filter((m) => m.team1 === null || m.team2 === null).map((m) => m.team1 ?? m.team2);
  assert.deepStrictEqual(byes.sort(), [1, 2]);
});

test('standings : points, puis confrontation directe', () => {
  const teams = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const m = (t1, t2, sets) => ({ team1: t1, team2: t2, sets, winner: L.matchResult(sets).winner === 1 ? t1 : t2 });
  const s = L.standings(teams, [m(1, 2, [[6, 0], [6, 0]]), m(2, 3, [[6, 4], [6, 4]]), m(3, 1, [[6, 4], [6, 4]])], 3, 1);
  assert.strictEqual(s.every((r) => r.points === 4), true);
  assert.strictEqual(s[0].rank, 1);
});

test('validSets refuse égalité et scores invalides', () => {
  assert.strictEqual(L.validSets([[6, 4], [4, 6]]), false);
  assert.strictEqual(L.validSets([[6, 4]]), true);
  assert.strictEqual(L.validSets([[-1, 4]]), false);
});

test('buildBracket : match pour la 3e place avec 4 qualifiés', () => {
  const { rounds } = L.buildBracket([1, 2, 3, 4], true);
  assert.deepStrictEqual(rounds.map((r) => r.length), [2, 2]);
  assert.deepStrictEqual([rounds[0][0].team1, rounds[0][0].team2, rounds[0][1].team1, rounds[0][1].team2], [1, 4, 2, 3]);
});

test('standings : pénalité, double forfait et départage par différence de jeux', () => {
  const teams = [{ id: 1, name: 'A', penalty: 2 }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
  const win = (t1, t2, sets) => ({ team1: t1, team2: t2, sets, winner: t1 });
  const s = L.standings(teams, [win(1, 2, [[6, 0], [6, 0]]), win(3, 1, [[6, 4], [6, 4]]), { team1: 2, team2: 3, sets: null, winner: -1 }], 3, 0);
  const byId = Object.fromEntries(s.map((r) => [r.id, r]));
  assert.strictEqual(byId[1].points, 1);   // 3 - 2 de pénalité
  assert.strictEqual(byId[3].points, 3);
  assert.strictEqual(byId[2].played, 2);
  assert.strictEqual(s[0].id, 3);
});

test('lateState : retard puis forfait à la journée suivante', () => {
  const m = { stage: 'group', team1: 1, team2: 2, winner: null, date: '2026-10-10', deadline: '2026-10-17' };
  assert.strictEqual(L.lateState(m, '2026-10-10'), null);
  assert.strictEqual(L.lateState(m, '2026-10-11'), 'late');
  assert.strictEqual(L.lateState(m, '2026-10-17'), 'forfeit');
  assert.strictEqual(L.lateState({ ...m, deadline: null }, '2026-12-01'), 'late');
  assert.strictEqual(L.lateState({ ...m, winner: 1 }, '2026-12-01'), null);
  assert.strictEqual(L.lateState({ ...m, date: null }, '2026-12-01'), null);
});

test('currentRound / partnerPenalty : 2 points à partir de la journée 4', () => {
  const ms = [1, 2, 3, 4, 5].map((r) => ({ stage: 'group', round: r, winner: r <= 3 ? 1 : null, date: r === 4 ? '2026-10-20' : r === 5 ? '2026-10-27' : null }));
  assert.strictEqual(L.currentRound(ms, '2026-10-21'), 4);
  assert.strictEqual(L.currentRound(ms, '2026-10-10'), 3);
  assert.strictEqual(L.currentRound([], '2026-10-10'), 0);
  assert.strictEqual(L.partnerPenalty(3), 0);
  assert.strictEqual(L.partnerPenalty(4), 2);
});
