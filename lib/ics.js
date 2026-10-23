// Export iCalendar (.ics) des matchs. Tunisie : UTC+1 toute l'année, donc heures converties en UTC.
const TZ_OFFSET_H = 1;
const DURATION_MIN = 90;

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const pad = (n) => String(n).padStart(2, '0');

// Coupe à 75 octets par ligne (RFC 5545), sans couper un caractère multi-octets.
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utc = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const dateOnly = (d) => d.replace(/-/g, '');

// "18:00", "18h30", "9h" → [h, m] ; sinon null (événement sur la journée)
function parseTime(t) {
  const m = /^\s*(\d{1,2})\s*[:hH]\s*(\d{2})?\s*$/.exec(t || '');
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) return null;
  return [+m[1], +(m[2] || 0)];
}

function matchEvent(m, ctx) {
  const name = (id) => ctx.names.get(id);
  const a = name(m.team1), b = name(m.team2);
  const label = m.stage === 'group' ? `Journée ${m.round}` : ctx.roundLabel(m);
  const score = m.sets ? m.sets.map((s) => `${s[0]}-${s[1]}`).join(' ') : null;
  const lines = ['BEGIN:VEVENT', `UID:match-${m.id}@${ctx.slug}.padel`, `DTSTAMP:${ctx.stamp}`, `SUMMARY:${esc(`${a} vs ${b}`)}`];
  const hm = parseTime(m.time);
  if (hm) {
    const start = new Date(`${m.date}T${pad(hm[0])}:${pad(hm[1])}:00Z`);
    start.setUTCHours(start.getUTCHours() - TZ_OFFSET_H);
    const end = new Date(start.getTime() + DURATION_MIN * 60000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`);
  } else {
    const next = new Date(`${m.date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(m.date)}`, `DTEND;VALUE=DATE:${dateOnly(next.toISOString().slice(0, 10))}`);
  }
  if (m.court) lines.push(`LOCATION:${esc([m.court, ctx.location].filter(Boolean).join(', '))}`);
  else if (ctx.location) lines.push(`LOCATION:${esc(ctx.location)}`);
  lines.push(`DESCRIPTION:${esc([ctx.tournament, label, m.winner ? `Score : ${score || 'forfait'}` : null].filter(Boolean).join(' · '))}`, 'END:VEVENT');
  return lines;
}

// matches : lignes de la table matches ; teams : [{id,name}]
function buildIcs({ slug, tournament, location, teams, matches, roundLabel, teamId = null, now = new Date() }) {
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const ctx = { slug, tournament, location, names, roundLabel, stamp: utc(now) };
  const events = matches
    .filter((m) => m.date && m.team1 && m.team2 && (!teamId || m.team1 === teamId || m.team2 === teamId))
    .flatMap((m) => matchEvent(m, ctx));
  const title = teamId ? `${names.get(teamId)} · ${tournament}` : tournament;
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Padel tournois//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(title)}`, 'X-WR-TIMEZONE:Africa/Tunis', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H', ...events, 'END:VCALENDAR']
    .map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, parseTime };
