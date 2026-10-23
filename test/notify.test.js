const test = require('node:test');
const assert = require('node:assert');
const { resultMessage, dueReminders, nowTunis } = require('../lib/notify');

const name = (id) => ({ 1: 'Omar & Aymen', 2: 'Hamza & Kais' }[id]);
const m = (o) => ({ id: 1, stage: 'group', team1: 1, team2: 2, winner: null, date: '2026-10-23', time: '20:00', court: null, late: null, deadline: null, ...o });

test('nowTunis : UTC+1', () => {
  assert.deepStrictEqual(nowTunis(new Date('2026-10-22T23:30:00Z')), { date: '2026-10-23', minutes: 30 });
  assert.deepStrictEqual(nowTunis(new Date('2026-10-22T10:00:00Z')), { date: '2026-10-22', minutes: 11 * 60 });
});

test('résultat : score vu du vainqueur', () => {
  assert.strictEqual(resultMessage({ winner: 1, sets: [[6, 3], [6, 4]], team1: 1, team2: 2 }, 'A', 'B'), 'Résultat : A bat B 6-3 6-4');
  assert.strictEqual(resultMessage({ winner: 2, sets: [[3, 6], [4, 6]], team1: 1, team2: 2 }, 'A', 'B'), 'Résultat : B bat A 6-3 6-4');
  assert.strictEqual(resultMessage({ winner: 1, sets: [[6, 3], [6, 4]], team1: 1, team2: 2 }, 'A', 'B', true), 'Résultat corrigé : A bat B 6-3 6-4');
});

test('résultat : forfaits', () => {
  assert.strictEqual(resultMessage({ winner: 2, sets: [[0, 6], [0, 6]], forfeit: 'team1', team1: 1, team2: 2 }, 'A', 'B'), 'Forfait : B gagne contre A');
  assert.strictEqual(resultMessage({ winner: -1, forfeit: 'both', team1: 1, team2: 2 }, 'A', 'B'), 'Double forfait : A et B');
});

test('rappel de la veille : seulement à partir de 18h, une seule fois', () => {
  assert.strictEqual(dueReminders([m()], { date: '2026-10-22', minutes: 17 * 60 }, new Set(), name).length, 0);
  const r = dueReminders([m()], { date: '2026-10-22', minutes: 18 * 60 }, new Set(), name);
  assert.strictEqual(r.length, 1);
  assert.match(r[0].text, /^Demain à 20:00 : Omar & Aymen vs Hamza & Kais/);
  assert.strictEqual(dueReminders([m()], { date: '2026-10-22', minutes: 19 * 60 }, new Set([r[0].key]), name).length, 0);
});

test('rappel proche : dans les 2 h avant le match', () => {
  const now = (h, mn) => ({ date: '2026-10-23', minutes: h * 60 + mn });
  assert.strictEqual(dueReminders([m()], now(17, 0), new Set(), name).length, 0);
  assert.match(dueReminders([m()], now(18, 30), new Set(), name)[0].text, /^Dans 1,5 h \(20:00\)/);
  assert.match(dueReminders([m()], now(19, 40), new Set(), name)[0].text, /^Dans 20 min/);
  assert.strictEqual(dueReminders([m()], now(20, 5), new Set(), name).length, 0);
});

test('un report déclenche de nouveaux rappels', () => {
  const now = { date: '2026-10-22', minutes: 19 * 60 };
  const first = dueReminders([m()], now, new Set(), name);
  const moved = dueReminders([m({ time: '21:30' })], now, new Set([first[0].key]), name);
  assert.strictEqual(moved.length, 1);
});

test('retard et forfait : un seul message par état, pas de rappel normal', () => {
  const now = { date: '2026-10-25', minutes: 600 };
  const late = dueReminders([m({ late: 'late', deadline: '2026-10-27' })], now, new Set(), name);
  assert.strictEqual(late.length, 1);
  assert.match(late[0].text, /^Match en retard : .* À jouer avant le .*double forfait/);
  const ff = dueReminders([m({ late: 'forfeit', deadline: '2026-10-27' })], now, new Set(), name);
  assert.match(ff[0].text, /^Match non joué à temps/);
  assert.notStrictEqual(late[0].key, ff[0].key);
});

test('rien pour un match joué, sans date ou incomplet', () => {
  const now = { date: '2026-10-22', minutes: 19 * 60 };
  assert.strictEqual(dueReminders([m({ winner: 1 }), m({ date: null }), m({ team2: null })], now, new Set(), name).length, 0);
});
