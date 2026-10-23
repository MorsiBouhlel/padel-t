const test = require('node:test');
const assert = require('node:assert');
const { buildIcs, parseTime } = require('../lib/ics');

test('parseTime accepte 18:00, 9h, 18h30 et refuse le reste', () => {
  assert.deepStrictEqual(parseTime('18:00'), [18, 0]);
  assert.deepStrictEqual(parseTime('9h'), [9, 0]);
  assert.deepStrictEqual(parseTime('18h30'), [18, 30]);
  assert.strictEqual(parseTime('soir'), null);
  assert.strictEqual(parseTime('25:00'), null);
});

const base = { slug: 's', tournament: 'Bajada, Édition 4', location: 'Club', teams: [{ id: 1, name: 'A/B' }, { id: 2, name: 'C/D' }, { id: 3, name: 'E/F' }], roundLabel: () => 'Finale', now: new Date('2026-10-22T10:00:00Z') };

test('buildIcs : heure locale Tunis convertie en UTC, journée entière sans heure, filtrage par paire', () => {
  const matches = [
    { id: 1, stage: 'group', round: 1, team1: 1, team2: 2, date: '2026-11-03', time: '18:30', court: 'Terrain 1', sets: [[6, 4], [6, 3]], winner: 1 },
    { id: 2, stage: 'group', round: 2, team1: 2, team2: 3, date: '2026-11-10', time: 'soir', court: null },
    { id: 3, stage: 'group', round: 2, team1: 1, team2: null, date: '2026-11-10' },
    { id: 4, stage: 'group', round: 3, team1: 1, team2: 3, date: null },
  ];
  const all = buildIcs({ ...base, matches });
  assert.strictEqual((all.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(all, /DTSTART:20261103T173000Z/);
  assert.match(all, /DTEND:20261103T190000Z/);
  assert.match(all, /DTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261111/);
  assert.match(all, /Score : 6-4 6-3/);
  assert.ok(all.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  const one = buildIcs({ ...base, matches, teamId: 3 });
  assert.strictEqual((one.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(one, /SUMMARY:C\/D vs E\/F/);
});
