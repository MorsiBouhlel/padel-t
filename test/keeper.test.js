const test = require('node:test');
const assert = require('node:assert');
const K = require('../public/keeper-engine');
const L = require('../lib/logic');

const game = (i) => [i, i, i, i];                       // la paire i gagne un jeu à 0
const games = (i, n) => Array.from({ length: n }, () => game(i)).flat();
const rep = (...parts) => K.replay(parts.flat());

test('points d\'un jeu : 0, 15, 30, 40', () => {
  const r = rep([1, 1, 2]);
  assert.deepStrictEqual(K.pointLabels(r), ['30', '15']);
});

test('40-40 : point décisif, pas d\'avantage', () => {
  const r = rep([1, 1, 1, 2, 2, 2]);
  assert.strictEqual(r.decisive, true);
  assert.deepStrictEqual(r.games, [0, 0]);
  const fin = rep([1, 1, 1, 2, 2, 2, 2]);
  assert.deepStrictEqual(fin.games, [0, 1]);
  assert.deepStrictEqual(fin.pts, [0, 0]);
});

test('un set se gagne à 6 jeux avec 2 d\'écart', () => {
  const r = rep(games(1, 6));
  assert.deepStrictEqual(r.sets, [[6, 0]]);
  assert.deepStrictEqual(r.games, [0, 0]);
  const r2 = rep(games(1, 5), games(2, 5), game(1));   // 6-5 : le set continue
  assert.strictEqual(r2.sets.length, 0);
  assert.deepStrictEqual(r2.games, [6, 5]);
  const r3 = rep(games(1, 5), games(2, 5), game(1), game(1)); // 7-5
  assert.deepStrictEqual(r3.sets, [[7, 5]]);
});

test('tie-break à 6-6 : 7 points avec 2 d\'écart, le set finit 7-6', () => {
  const tb = rep(games(1, 5), games(2, 5), game(1), game(2));
  assert.strictEqual(tb.tb, true);
  assert.deepStrictEqual(K.pointLabels(rep(games(1, 5), games(2, 5), game(1), game(2), [1, 1, 2])), ['2', '1']);
  const six6 = [games(1, 5), games(2, 5), game(1), game(2)];
  const won = rep(...six6, [1, 1, 1, 1, 1, 1, 1]);
  assert.deepStrictEqual(won.sets, [[7, 6]]);
  const longer = rep(...six6, [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2], [1]);   // 6-6 aux points : pas fini
  assert.strictEqual(longer.sets.length, 0);
  assert.deepStrictEqual(longer.pts, [7, 6]);
  assert.deepStrictEqual(rep(...six6, [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2], [1, 1]).sets, [[7, 6]]);
});

test('match en deux sets, ou en trois sets complets sans super tie-break', () => {
  const two = rep(games(1, 6), games(1, 6));
  assert.strictEqual(two.winner, 1);
  assert.deepStrictEqual(two.sets, [[6, 0], [6, 0]]);
  const three = rep(games(1, 6), games(2, 6));
  assert.strictEqual(three.winner, 0);
  assert.strictEqual(three.sets.length, 2);
  const full = rep(games(1, 6), games(2, 6), games(2, 6));
  assert.strictEqual(full.winner, 2);
  assert.deepStrictEqual(full.sets, [[6, 0], [0, 6], [0, 6]]);
});

test('les points après la victoire sont ignorés', () => {
  const pts = [...games(1, 12), 1, 2, 2];
  const r = K.replay(pts);
  assert.strictEqual(r.winner, 1);
  assert.strictEqual(r.used, 48);
});

test('le résultat produit est un score valide pour le classement', () => {
  const r = rep(games(1, 5), games(2, 5), game(1), game(1), games(2, 6), games(1, 5), games(2, 5), game(1), game(2), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepStrictEqual(r.sets, [[7, 5], [0, 6], [7, 6]]);
  assert.strictEqual(L.validSets(r.sets), true);
  assert.strictEqual(L.matchResult(r.sets).winner, 1);
});

test('balle de set et balle de match', () => {
  assert.deepStrictEqual(K.pressure([games(1, 5), [1, 1, 1]].flat()), ['set', null]);
  assert.deepStrictEqual(K.pressure([games(1, 6), games(1, 5), [1, 1, 1]].flat()), ['match', null]);
  assert.deepStrictEqual(K.pressure([]), [null, null]);
});
