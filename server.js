const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const L = require('./lib/logic');
const { buildIcs } = require('./lib/ics');
const webpush = require('web-push');
const N = require('./lib/notify');
const { forecast } = require('./lib/forecast');
const K = require('./public/keeper-engine');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Mot de passe organisateur -------------------------------------------
function loadSecrets() {
  const file = path.join(DATA_DIR, 'secrets.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let dirty = false;
  if (!s.sessionSecret) { s.sessionSecret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (!process.env.ADMIN_PASSWORD && !s.adminPassword) {
    s.adminPassword = crypto.randomBytes(6).toString('hex');
    dirty = true;
    console.log(`Mot de passe organisateur généré : ${s.adminPassword} (stocké dans ${file})`);
  }
  if (!s.vapidPublic || !s.vapidPrivate) {
    const k = webpush.generateVAPIDKeys();
    s.vapidPublic = k.publicKey; s.vapidPrivate = k.privateKey;
    dirty = true;
  }
  if (dirty) fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  return { sessionSecret: s.sessionSecret, adminPassword: process.env.ADMIN_PASSWORD || s.adminPassword, vapidPublic: s.vapidPublic, vapidPrivate: s.vapidPrivate };
}
const secrets = loadSecrets();
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// --- Base de données -------------------------------------------------------
const db = new Database(path.join(DATA_DIR, 'padel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  date TEXT, location TEXT,
  phase TEXT NOT NULL DEFAULT 'setup',
  groups_count INTEGER NOT NULL DEFAULT 2,
  qualifiers INTEGER NOT NULL DEFAULT 2,
  win_pts INTEGER NOT NULL DEFAULT 3,
  loss_pts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL, p1 TEXT, p2 TEXT,
  grp INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,           -- 'group' | 'ko'
  grp INTEGER, round INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0,
  team1 INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  team2 INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  sets TEXT, winner INTEGER,
  court TEXT, time TEXT
);
CREATE INDEX IF NOT EXISTS idx_matches_t ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_teams_t ON teams(tournament_id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  return safeEq(crypto.scryptSync(pw, salt, 64).toString('hex'), hash);
};

// Compte propriétaire "admin" : créé au 1er démarrage ; si ADMIN_PASSWORD est défini, il réinitialise son mot de passe à chaque démarrage.
{
  const owner = db.prepare('SELECT * FROM users WHERE is_owner = 1').get();
  if (!owner) db.prepare('INSERT INTO users (username, password_hash, is_owner) VALUES (?, ?, 1)').run('admin', hashPassword(secrets.adminPassword));
  else if (process.env.ADMIN_PASSWORD) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(process.env.ADMIN_PASSWORD), owner.id);
}

const SESSION_MS = 30 * 24 * 3600e3;
const sign = (payload) => crypto.createHmac('sha256', secrets.sessionSecret).update(payload).digest('hex');
const makeToken = (userId) => { const p = `${userId}.${Date.now() + SESSION_MS}`; return `${p}.${sign(p)}`; };
const userFromToken = (token) => {
  const [id, exp, sig] = String(token).split('.');
  if (!sig || !safeEq(sig, sign(`${id}.${exp}`)) || Number(exp) < Date.now()) return null;
  return db.prepare('SELECT id, username, is_owner FROM users WHERE id = ?').get(Number(id)) || null;
};

db.exec(`
CREATE TABLE IF NOT EXISTS postponements (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  from_date TEXT, from_time TEXT, to_date TEXT NOT NULL, to_time TEXT,
  reason TEXT, username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_postp_m ON postponements(match_id);`);

db.exec(`
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER,
  username TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_t ON audit_log(tournament_id, id);`);
const audit = (req, tid, detail) => db.prepare('INSERT INTO audit_log (tournament_id, username, detail) VALUES (?, ?, ?)').run(tid, req.user.username, detail);
const autoName = (p1, p2) => [p1, p2].filter(Boolean).join(' & ');
const teamLabel = (id) => (id ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(id) || {}).name || `#${id}` : '?');
const setsText = (sets) => (sets ? sets.map((x) => `${x[0]}-${x[1]}`).join(' ') : null);

db.exec(`
CREATE TABLE IF NOT EXISTS partner_changes (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  old_p1 TEXT, old_p2 TEXT, new_p1 TEXT, new_p2 TEXT,
  round INTEGER NOT NULL, penalty INTEGER NOT NULL DEFAULT 0,
  reason TEXT, username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pc_team ON partner_changes(team_id);`);

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player INTEGER NOT NULL,          -- 1 ou 2
  amount REAL NOT NULL,
  method TEXT, note TEXT, paid_on TEXT,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pay_team ON payments(team_id);`);

db.exec(`
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,   -- NULL = tout le tournoi
  endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (endpoint, tournament_id)
);
CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);

db.exec(`
CREATE TABLE IF NOT EXISTS live_scores (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,       -- lien secret du score keeper (jamais exposé dans l'état public)
  points TEXT NOT NULL,             -- JSON : [1,2,1,...] paire qui marque chaque point ; le score est recalculé en rejouant
  status TEXT NOT NULL DEFAULT 'live', -- 'live' | 'submitted' (résultat proposé, à valider par un organisateur)
  updated_at INTEGER NOT NULL
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS player_photos (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player INTEGER NOT NULL,          -- 1 ou 2
  data BLOB NOT NULL,               -- JPEG carré réduit côté navigateur (~256 px)
  v INTEGER NOT NULL,               -- version : change à chaque remplacement (cache navigateur)
  PRIMARY KEY (team_id, player)
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS broadcast_templates (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
const saveTemplates = db.transaction((list) => {
  db.prepare('DELETE FROM broadcast_templates').run();
  const ins = db.prepare('INSERT INTO broadcast_templates (label, text, position) VALUES (?, ?, ?)');
  list.forEach((x, i) => ins.run(x.label, x.text, i));
});
// Les messages par défaut ne sont installés qu'une fois : ensuite la liste appartient aux organisateurs (même vide).
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'broadcast_seeded'").get()) {
  saveTemplates(N.DEFAULT_TEMPLATES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('broadcast_seeded', '1')").run();
}

const addCol = (table, col, def) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
addCol('tournaments', 'legs', 'INTEGER NOT NULL DEFAULT 1');
addCol('tournaments', 'third_place', 'INTEGER NOT NULL DEFAULT 1');
addCol('tournaments', 'description', 'TEXT');
addCol('tournaments', 'fee', 'INTEGER NOT NULL DEFAULT 150');
addCol('live_scores', 'code', 'TEXT');
addCol('tournaments', 'prev_id', 'INTEGER');
addCol('teams', 'penalty', 'INTEGER NOT NULL DEFAULT 0');
// Ancien format de nom automatique « A / B » → « A & B »
db.exec("UPDATE teams SET name = p1 || ' & ' || p2 WHERE p1 IS NOT NULL AND p2 IS NOT NULL AND name = p1 || ' / ' || p2");
addCol('matches', 'date', 'TEXT');
addCol('matches', 'forfeit', 'TEXT');

const q = {
  tournament: db.prepare('SELECT * FROM tournaments WHERE id = ?'),
  bySlug: db.prepare('SELECT * FROM tournaments WHERE slug = ?'),
  teams: db.prepare('SELECT * FROM teams WHERE tournament_id = ? ORDER BY id'),
  matches: db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY stage, round, grp, pos, id'),
  match: db.prepare('SELECT * FROM matches WHERE id = ?'),
  koMatch: db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND stage = 'ko' AND round = ? AND pos = ?"),
  maxKoRound: db.prepare("SELECT MAX(round) AS r FROM matches WHERE tournament_id = ? AND stage = 'ko'"),
};
const parseMatch = (m) => ({ ...m, sets: m.sets ? JSON.parse(m.sets) : null });
const getMatches = (tid) => q.matches.all(tid).map(parseMatch);

// --- Score keeper (comptage en direct) -----------------------------------------
const LIVE_STALE_MS = 6 * 3600 * 1000;   // au-delà, un comptage sans nouveau point n'est plus affiché en direct
const liveView = (l) => {
  const r = K.replay(JSON.parse(l.points));
  return { status: l.status, sets: r.sets, games: r.games, pts: K.pointLabels(r), tb: r.tb, winner: r.winner, points: r.used, updated_at: l.updated_at };
};

// --- Calcul de l'état complet d'un tournoi ----------------------------------
function groupStandings(t, teams, matches) {
  const out = [];
  for (let g = 0; g < t.groups_count; g++) {
    const gt = teams.filter((x) => x.grp === g);
    const gm = matches.filter((m) => m.stage === 'group' && m.grp === g);
    out.push({ group: g, rows: L.standings(gt, gm, t.win_pts, t.loss_pts) });
  }
  return out;
}

const todayTn = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Tunis' });

function fullState(t) {
  const today = todayTn();
  const teams = q.teams.all(t.id);
  const matches = getMatches(t.id);
  // Limite de jeu d'un match de poule reporté : la journée suivante commence à la date de son premier match.
  const firstDate = {};
  for (const m of matches) {
    if (m.stage !== 'group' || !m.date) continue;
    const k = `${m.grp}-${m.round}`;
    if (!firstDate[k] || m.date < firstDate[k]) firstDate[k] = m.date;
  }
  const moves = {};
  const reports = {};
  const rows = db.prepare('SELECT p.match_id, p.from_date, p.from_time, p.to_date, p.to_time FROM postponements p JOIN matches m ON m.id = p.match_id WHERE m.tournament_id = ? ORDER BY p.id').all(t.id);
  const byId = new Map(matches.map((m) => [m.id, m]));
  for (const r of rows) {
    (moves[r.match_id] ??= []).push({ from_date: r.from_date, from_time: r.from_time, to_date: r.to_date, to_time: r.to_time });
    const m = byId.get(r.match_id);
    for (const id of [m.team1, m.team2]) reports[id] = (reports[id] || 0) + 1;
  }
  for (const m of matches) {
    if (m.stage !== 'group') continue;
    m.deadline = firstDate[`${m.grp}-${m.round + 1}`] || null;
    m.moves = moves[m.id] || [];
    m.late = t.phase === 'groups' ? L.lateState(m, today) : null;
  }
  const lives = db.prepare('SELECT l.match_id, l.points, l.status, l.updated_at FROM live_scores l JOIN matches m ON m.id = l.match_id WHERE m.tournament_id = ?').all(t.id);
  for (const l of lives) {
    const m = byId.get(l.match_id);
    if (m.winner || (l.status === 'live' && Date.now() - l.updated_at > LIVE_STALE_MS)) continue;
    m.live = liveView(l);
  }
  const changes = db.prepare('SELECT c.team_id, c.old_p1, c.old_p2, c.new_p1, c.new_p2, c.round, c.penalty, c.reason, c.created_at FROM partner_changes c JOIN teams x ON x.id = c.team_id WHERE x.tournament_id = ? ORDER BY c.id').all(t.id);
  const photos = db.prepare('SELECT f.team_id, f.player, f.v FROM player_photos f JOIN teams x ON x.id = f.team_id WHERE x.tournament_id = ?').all(t.id);
  for (const x of teams) {
    x.reports = reports[x.id] || 0; x.changes = changes.filter((c) => c.team_id === x.id);
    for (const n of [1, 2]) x[`photo${n}`] = (photos.find((f) => f.team_id === x.id && f.player === n) || {}).v || null;
  }
  const koRounds = matches.filter((m) => m.stage === 'ko').reduce((n, m) => Math.max(n, m.round), 0);
  const final = matches.find((m) => m.stage === 'ko' && m.round === koRounds && m.pos === 0);
  const phase = final && final.winner ? 'finished' : t.phase;
  return {
    tournament: {
      ...t, phase,
      prev: (t.prev_id && db.prepare('SELECT slug, name FROM tournaments WHERE id = ?').get(t.prev_id)) || null,
      next: db.prepare('SELECT slug, name FROM tournaments WHERE prev_id = ? ORDER BY id LIMIT 1').get(t.id) || null,
    },
    teams,
    matches,
    standings: t.phase === 'setup' ? [] : groupStandings(t, teams, matches),
    koRounds,
    roundNames: Object.fromEntries(Array.from({ length: koRounds }, (_, i) => [i + 1, L.roundName(i + 1, koRounds)])),
    thirdName: L.roundName(koRounds, koRounds, 1),
  };
}

// --- Tableau final : propagation des vainqueurs ------------------------------
const setMatch = db.prepare('UPDATE matches SET team1 = ?, team2 = ?, sets = ?, winner = ?, forfeit = ? WHERE id = ?');

// Place `value` dans le créneau d'un match du tableau ; si l'équipe change, le résultat en aval est annulé.
function setSlot(tid, round, pos, slot, value) {
  const next = q.koMatch.get(tid, round, pos);
  if (!next || next[slot] === value) return;
  const hadResult = next.winner != null;
  next[slot] = value;
  setMatch.run(next.team1, next.team2, null, null, null, next.id);
  if (hadResult) propagate({ ...next, winner: null });
}

// Le vainqueur avance ; en demi-finale, le perdant va en match pour la 3e place (s'il existe).
function propagate(m) {
  const maxRound = q.maxKoRound.get(m.tournament_id).r;
  if (m.round >= maxRound) return;
  const slot = m.pos % 2 ? 'team2' : 'team1';
  setSlot(m.tournament_id, m.round + 1, m.pos >> 1, slot, m.winner ?? null);
  if (m.round === maxRound - 1) {
    const loser = m.winner ? (m.winner === m.team1 ? m.team2 : m.team1) : null;
    setSlot(m.tournament_id, maxRound, 1, slot, loser);
  }
}

// --- Express -----------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // derrière Caddy : l'IP du visiteur vient de X-Forwarded-For (limite de tentatives de connexion)
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, ...(e.needsForce ? { needsForce: true } : {}) });
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const admin = (req, res, next) => {
  const h = req.headers.authorization || '';
  const user = h.startsWith('Bearer ') ? userFromToken(h.slice(7)) : null;
  if (!user) return res.status(401).json({ error: 'Authentification requise' });
  req.user = user;
  next();
};
const owner = (req, res, next) => (req.user.is_owner ? next() : res.status(403).json({ error: 'Réservé au propriétaire' }));
const str = (v, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const intIn = (v, min, max, def) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};
const loadT = (id) => q.tournament.get(id) || (() => { throw fail(404, 'Tournoi introuvable'); })();

// Rate limit simple sur le login
const attempts = new Map();
app.post('/api/login', wrap((req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw fail(429, 'Trop de tentatives, réessayez plus tard');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username, 40) || 'admin');
  // Hash factice si l'utilisateur n'existe pas, pour ne pas révéler les identifiants valides par le temps de réponse.
  const ok = checkPassword(str(req.body.password, 200), user ? user.password_hash : hashPassword('x')) && !!user;
  if (!ok) {
    attempts.set(ip, { ...a, n: a.n + 1 });
    throw fail(401, 'Identifiant ou mot de passe incorrect');
  }
  res.json({ token: makeToken(user.id), user: { username: user.username, owner: !!user.is_owner } });
}));

app.get('/api/me', admin, wrap((req, res) => {
  res.json({ username: req.user.username, owner: !!req.user.is_owner });
}));

app.put('/api/me/password', admin, wrap((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const pw = str(req.body.new, 200);
  if (!checkPassword(str(req.body.current, 200), user.password_hash)) throw fail(403, 'Mot de passe actuel incorrect');
  if (pw.length < 6) throw fail(400, 'Le nouveau mot de passe doit faire au moins 6 caractères');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), user.id);
  res.json({ ok: true });
}));

// Gestion des organisateurs (propriétaire uniquement)
app.get('/api/users', admin, owner, wrap((req, res) => {
  res.json(db.prepare('SELECT id, username, is_owner AS owner FROM users ORDER BY is_owner DESC, username').all());
}));

app.post('/api/users', admin, owner, wrap((req, res) => {
  const username = str(req.body.username, 40);
  const pw = str(req.body.password, 200);
  if (!/^[\w.-]{3,40}$/.test(username)) throw fail(400, 'Identifiant : 3 à 40 caractères (lettres, chiffres, . _ -)');
  if (pw.length < 6) throw fail(400, 'Le mot de passe doit faire au moins 6 caractères');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail(409, 'Cet identifiant existe déjà');
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(pw));
  res.status(201).json({ id: info.lastInsertRowid });
}));

app.put('/api/users/:id/password', admin, owner, wrap((req, res) => {
  const pw = str(req.body.password, 200);
  if (pw.length < 6) throw fail(400, 'Le mot de passe doit faire au moins 6 caractères');
  const r = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), req.params.id);
  if (!r.changes) throw fail(404, 'Utilisateur introuvable');
  res.json({ ok: true });
}));

app.delete('/api/users/:id', admin, owner, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) throw fail(404, 'Utilisateur introuvable');
  if (u.is_owner) throw fail(400, 'Le propriétaire ne peut pas être supprimé');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ ok: true });
}));

// Sauvegardes de la base (propriétaire uniquement : contient hachages et paiements)
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;
const backupFiles = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => /^padel-[\d-]+(_\d+)?\.db$/.test(f)).sort().reverse() : []);
function makeBackup(force = false) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const day = new Date().toLocaleDateString('sv', { timeZone: 'Africa/Tunis' });
  let name = `padel-${day}.db`;
  if (fs.existsSync(path.join(BACKUP_DIR, name))) {
    if (!force) return null;
    name = `padel-${day}_${Date.now()}.db`;
  }
  db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, name).replace(/'/g, "''")}'`);
  backupFiles().slice(BACKUP_KEEP).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  return name;
}
const backupInfo = (f) => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; };

app.get('/api/backups', admin, owner, wrap((req, res) => res.json(backupFiles().map(backupInfo))));

app.post('/api/backups', admin, owner, wrap((req, res) => res.status(201).json(backupInfo(makeBackup(true)))));

app.get('/api/backups/:name', admin, owner, wrap((req, res) => {
  if (!backupFiles().includes(req.params.name)) throw fail(404, 'Sauvegarde introuvable');
  res.download(path.join(BACKUP_DIR, req.params.name));
}));

// Public

// --- Notifications push (Web Push, VAPID) ------------------------------------
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://pt.algoris.tn', secrets.vapidPublic, secrets.vapidPrivate);

// teamIds : paires concernées (null = tout le monde). Reçoivent le message : les abonnés au tournoi entier et ceux de ces paires.
function notify(tid, teamIds, body, tag) {
  try {
    const t = q.tournament.get(tid);
    if (!t) return 0;
    const payload = JSON.stringify({ title: t.name, body, url: `/#/t/${t.slug}`, tag: tag || `t${t.id}` });
    const subs = db.prepare('SELECT * FROM push_subs WHERE tournament_id = ?').all(tid)
      .filter((s) => s.team_id === null || !teamIds || teamIds.includes(s.team_id));
    for (const s of subs) pushTo(s, payload);
    return subs.length;
  } catch (e) { console.error('Notification échouée :', e.message); return 0; }
}
function pushTo(s, payload) {
  webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 }).catch((e) => {
    if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id); // abonnement expiré
    else console.error('Push échoué :', e.statusCode || e.message);
  });
}

// Messages prédéfinis envoyés par un organisateur à tous les abonnés du tournoi (y compris ceux qui ne suivent qu'une paire).
const lastBroadcast = new Map();
const broadcastCtx = (t, round) => {
  const todo = getMatches(t.id).filter((m) => m.stage === 'group' && !m.winner).map((m) => m.round);
  return { round: intIn(round, 1, 99, todo.length ? Math.min(...todo) : 1), fee: t.fee };
};
const templateRows = () => db.prepare('SELECT id, label, text FROM broadcast_templates ORDER BY position, id').all();
app.get('/api/tournaments/:id/broadcasts', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const ctx = broadcastCtx(t);
  res.json({
    subscribers: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE tournament_id = ?').get(t.id).n,
    round: ctx.round,
    templates: templateRows().map((x) => ({ id: x.id, label: x.label, params: N.templateParams(x.text), text: N.fillTemplate(x.text, ctx) })),
  });
}));
app.post('/api/tournaments/:id/broadcast', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const tpl = db.prepare('SELECT * FROM broadcast_templates WHERE id = ?').get(Number(req.body.template));
  if (!tpl) throw fail(400, 'Message inconnu');
  const key = `${t.id}:${tpl.id}`;
  if (Date.now() - (lastBroadcast.get(key) || 0) < 60e3) throw fail(429, 'Ce message vient d\'être envoyé : patientez une minute');
  lastBroadcast.set(key, Date.now());
  const text = N.fillTemplate(tpl.text, broadcastCtx(t, req.body.round));
  const sent = notify(t.id, null, text, `b${Date.now()}`);
  audit(req, t.id, `Notification envoyée à tous (${sent} appareil${sent > 1 ? 's' : ''}) : ${text}`);
  res.json({ ok: true, sent });
}));

// Configuration des messages prédéfinis (commune à tous les tournois, modifiable par tout organisateur)
app.get('/api/broadcast-templates', admin, wrap((req, res) => res.json(templateRows())));
app.put('/api/broadcast-templates', admin, wrap((req, res) => {
  const list = Array.isArray(req.body.templates) ? req.body.templates : null;
  if (!list || list.length > 30) throw fail(400, 'Liste invalide (30 messages maximum)');
  const clean = list.map((x) => ({ label: str(x.label, 60), text: str(x.text, 300) }));
  if (clean.some((x) => !x.label || !x.text)) throw fail(400, 'Chaque message a besoin d\'un titre et d\'un texte');
  saveTemplates(clean);
  res.json(templateRows());
}));
app.post('/api/broadcast-templates/reset', admin, wrap((req, res) => {
  saveTemplates(N.DEFAULT_TEMPLATES);
  res.json(templateRows());
}));

// Rappels de match (veille 18h, 2 h avant) et alertes de retard/forfait, une seule fois par message (table push_sent).
function runReminders() {
  try {
    const now = N.nowTunis();
    for (const t of db.prepare("SELECT * FROM tournaments WHERE phase IN ('groups', 'knockout')").all()) {
      if (!db.prepare('SELECT 1 FROM push_subs WHERE tournament_id = ?').get(t.id)) continue;
      const st = fullState(t);
      const prefix = `${t.id}:`;
      const sent = new Set(db.prepare('SELECT key FROM push_sent WHERE key LIKE ?').all(`${prefix}%`).map((r) => r.key.slice(prefix.length)));
      const names = new Map(st.teams.map((x) => [x.id, x.name]));
      for (const r of N.dueReminders(st.matches, now, sent, (id) => names.get(id) || '?')) {
        db.prepare('INSERT OR IGNORE INTO push_sent (key) VALUES (?)').run(prefix + r.key);
        notify(t.id, [r.match.team1, r.match.team2], r.text);
      }
    }
    db.prepare("DELETE FROM push_sent WHERE sent_at < datetime('now', '-60 days')").run();
  } catch (e) { console.error('Rappels échoués :', e.message); }
}

// Abonnements (publics : aucun compte, l'abonnement du navigateur fait foi)
const validSub = (s) => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length <= 800 &&
  s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' && s.keys.p256dh.length <= 200 && s.keys.auth.length <= 100;
const MAX_SUBS = 3000;

app.get('/api/push/key', wrap((req, res) => res.json({ key: secrets.vapidPublic })));

app.post('/api/t/:slug/push', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const sub = req.body.subscription;
  if (!validSub(sub)) throw fail(400, 'Abonnement invalide');
  let teamId = null;
  if (req.body.team_id !== null && req.body.team_id !== undefined && req.body.team_id !== '') {
    teamId = Number(req.body.team_id);
    if (!db.prepare('SELECT 1 FROM teams WHERE id = ? AND tournament_id = ?').get(teamId, t.id)) throw fail(400, 'Paire inconnue');
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n >= MAX_SUBS) throw fail(503, 'Trop d\'abonnements');
  const existed = !!db.prepare('SELECT 1 FROM push_subs WHERE tournament_id = ? AND endpoint = ?').get(t.id, sub.endpoint);
  db.prepare(`INSERT INTO push_subs (tournament_id, team_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint, tournament_id) DO UPDATE SET team_id = excluded.team_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(t.id, teamId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  // Notification de bienvenue au premier abonnement (pas à chaque changement de paire suivie).
  if (!existed) {
    const row = db.prepare('SELECT * FROM push_subs WHERE tournament_id = ? AND endpoint = ?').get(t.id, sub.endpoint);
    const who = teamId ? `la paire ${teamLabel(teamId)}` : 'tout le tournoi';
    pushTo(row, JSON.stringify({ title: t.name, body: `Bienvenue ! Vous suivez ${who} : résultats, matchs reportés, rappels, retards et phase finale.`, url: `/#/t/${t.slug}`, tag: 'welcome' }));
  }
  res.status(201).json({ ok: true, team_id: teamId });
}));

app.post('/api/t/:slug/push/status', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const r = db.prepare('SELECT team_id FROM push_subs WHERE tournament_id = ? AND endpoint = ?').get(t.id, str(req.body.endpoint, 800));
  res.json({ subscribed: !!r, team_id: r ? r.team_id : null });
}));

app.delete('/api/t/:slug/push', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const endpoint = str(req.body.endpoint, 800);
  db.prepare('DELETE FROM push_subs WHERE tournament_id = ? AND endpoint = ?').run(t.id, endpoint);
  res.json({ ok: true, remaining: db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE endpoint = ?').get(endpoint).n });
}));

// Notification de test envoyée à l'appareil lui-même (un essai toutes les 10 s par appareil)
const lastTest = new Map();
app.post('/api/t/:slug/push/test', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const endpoint = str(req.body.endpoint, 800);
  const s = db.prepare('SELECT * FROM push_subs WHERE tournament_id = ? AND endpoint = ?').get(t.id, endpoint);
  if (!s) throw fail(404, 'Pas abonné');
  if (Date.now() - (lastTest.get(endpoint) || 0) < 10e3) throw fail(429, 'Patientez quelques secondes');
  lastTest.set(endpoint, Date.now());
  pushTo(s, JSON.stringify({ title: t.name, body: 'Test : les notifications fonctionnent sur cet appareil.', url: `/#/t/${t.slug}`, tag: 'test' }));
  res.json({ ok: true });
}));

app.get('/api/tournaments', wrap((req, res) => {
  const rows = db.prepare(`SELECT t.id, t.slug, t.name, t.date, t.location, t.phase,
    (SELECT COUNT(*) FROM teams WHERE tournament_id = t.id) AS teams,
    (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id AND team1 IS NOT NULL AND team2 IS NOT NULL) AS matches,
    (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id AND team1 IS NOT NULL AND team2 IS NOT NULL AND winner IS NOT NULL) AS played
    FROM tournaments t ORDER BY COALESCE(t.date, t.created_at) DESC, t.id DESC`).all();
  const nextMatch = db.prepare(`SELECT m.date, m.time, a.name AS t1, b.name AS t2 FROM matches m
    JOIN teams a ON a.id = m.team1 JOIN teams b ON b.id = m.team2
    WHERE m.tournament_id = ? AND m.winner IS NULL AND m.date >= ? ORDER BY m.date, m.time LIMIT 1`);
  const today = todayTn();
  // « Terminé » se déduit de la finale jouée : on ne le calcule que pour les tournois en phase finale
  res.json(rows.map(({ id, ...r }) => {
    const phase = r.phase === 'knockout' ? fullState(q.tournament.get(id)).tournament.phase : r.phase;
    return { ...r, phase, next: phase === 'groups' || phase === 'knockout' ? nextMatch.get(id, today) || null : null };
  }));
}));
app.get('/api/t/:slug', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  res.json(fullState(t));
}));

// Prévisions (organisateurs pour le moment) : probabilités par simulation, recalculées seulement quand les résultats changent.
const forecastCache = new Map();
app.get('/api/t/:slug/forecast', admin, wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const teams = q.teams.all(t.id), matches = getMatches(t.id);
  const sig = crypto.createHash('md5').update(JSON.stringify([t.phase, t.qualifiers, t.groups_count, t.win_pts, t.loss_pts, t.third_place,
    teams.map((x) => [x.id, x.grp, x.penalty]), matches.map((m) => [m.id, m.team1, m.team2, m.winner, m.sets, m.forfeit])])).digest('hex');
  const hit = forecastCache.get(t.id);
  if (hit && hit.sig === sig) return res.json(hit.data);
  const data = forecast({ tournament: t, teams, matches });
  forecastCache.set(t.id, { sig, data });
  if (forecastCache.size > 50) forecastCache.delete(forecastCache.keys().next().value);
  res.json(data);
}));

// Historique des modifications (organisateurs uniquement)
// Abonnés aux notifications (anonymes : on ne connaît que les appareils et leur choix de suivi)
app.get('/api/tournaments/:id/followers', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const subs = db.prepare('SELECT team_id FROM push_subs WHERE tournament_id = ?').all(t.id);
  const perTeam = {};
  for (const s of subs) if (s.team_id) perTeam[s.team_id] = (perTeam[s.team_id] || 0) + 1;
  res.json({ devices: subs.length, wide: subs.filter((s) => s.team_id === null).length, perTeam });
}));

app.get('/api/tournaments/:id/audit', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const limit = intIn(req.query.limit, 1, 1000, 300);
  res.json(db.prepare('SELECT id, username, detail, created_at FROM audit_log WHERE tournament_id = ? ORDER BY id DESC LIMIT ?').all(t.id, limit));
}));

// Calendrier .ics (public) : tout le tournoi, ou une paire avec ?team=<id>
app.get('/api/t/:slug/calendar.ics', wrap((req, res) => {
  const t = q.bySlug.get(req.params.slug);
  if (!t) throw fail(404, 'Tournoi introuvable');
  const d = fullState(t);
  const teamId = req.query.team ? Number(req.query.team) : null;
  if (teamId && !d.teams.some((x) => x.id === teamId)) throw fail(404, 'Paire introuvable');
  const roundLabel = (m) => (m.pos === 1 && m.round === d.koRounds ? d.thirdName : d.roundNames[m.round]);
  const ics = buildIcs({ slug: t.slug, tournament: t.name, location: t.location, teams: d.teams, matches: d.matches, roundLabel, teamId });
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${t.slug}${teamId ? `-${teamId}` : ''}.ics"`, 'Cache-Control': 'no-cache' }).send(ics);
}));

// Tournois
app.post('/api/tournaments', admin, wrap((req, res) => {
  const name = str(req.body.name);
  if (!name) throw fail(400, 'Nom requis');
  const slug = crypto.randomBytes(5).toString('hex');
  const info = db.prepare(`INSERT INTO tournaments (slug, name, date, location, groups_count, qualifiers, win_pts, loss_pts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    slug, name, str(req.body.date, 10) || null, str(req.body.location) || null,
    intIn(req.body.groups_count, 1, 8, 1), intIn(req.body.qualifiers, 1, 8, 4),
    intIn(req.body.win_pts, 0, 20, 3), intIn(req.body.loss_pts, 0, 20, 0));
  db.prepare('UPDATE tournaments SET fee = ? WHERE id = ?').run(intIn(req.body.fee, 0, 100000, 150), info.lastInsertRowid);
  db.prepare('UPDATE tournaments SET legs = ?, third_place = ?, description = ? WHERE id = ?').run(
    intIn(req.body.legs, 1, 2, 1), req.body.third_place === '0' || req.body.third_place === 0 ? 0 : 1, str(req.body.description, 8000) || null, info.lastInsertRowid);
  audit(req, info.lastInsertRowid, `Tournoi créé : « ${name} »`);
  res.status(201).json({ id: info.lastInsertRowid, slug });
}));

app.put('/api/tournaments/:id', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const b = req.body;
  const setup = t.phase === 'setup';
  db.prepare(`UPDATE tournaments SET name=?, date=?, location=?, groups_count=?, qualifiers=?, win_pts=?, loss_pts=? WHERE id=?`).run(
    str(b.name) || t.name, b.date !== undefined ? str(b.date, 10) || null : t.date,
    b.location !== undefined ? str(b.location) || null : t.location,
    setup ? intIn(b.groups_count, 1, 8, t.groups_count) : t.groups_count,
    setup ? intIn(b.qualifiers, 1, 8, t.qualifiers) : t.qualifiers,
    intIn(b.win_pts, 0, 20, t.win_pts), intIn(b.loss_pts, 0, 20, t.loss_pts), t.id);
  db.prepare('UPDATE tournaments SET fee = ? WHERE id = ?').run(intIn(b.fee, 0, 100000, t.fee), t.id);
  db.prepare('UPDATE tournaments SET legs = ?, third_place = ?, description = ? WHERE id = ?').run(
    setup ? intIn(b.legs, 1, 2, t.legs) : t.legs,
    t.phase === 'setup' || t.phase === 'groups' ? (b.third_place === undefined ? t.third_place : b.third_place === '0' || b.third_place === 0 ? 0 : 1) : t.third_place,
    b.description !== undefined ? str(b.description, 8000) || null : t.description, t.id);
  const n = loadT(t.id);
  const labels = { name: 'nom', date: 'date', location: 'lieu', groups_count: 'nombre de poules', qualifiers: 'qualifiés', win_pts: 'points victoire', loss_pts: 'points défaite', fee: 'frais par joueur', legs: 'aller/retour', third_place: 'match 3e place', description: 'règlement' };
  const diffs = Object.keys(labels).filter((k) => (t[k] ?? null) !== (n[k] ?? null))
    .map((k) => (k === 'description' ? 'règlement modifié' : `${labels[k]} : ${t[k] ?? '—'} → ${n[k] ?? '—'}`));
  if (diffs.length) audit(req, t.id, `Réglages du tournoi : ${diffs.join(' ; ')}`);
  res.json({ ok: true });
}));

app.delete('/api/tournaments/:id', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM audit_log WHERE tournament_id = ?').run(t.id);
  res.json({ ok: true });
}));

// Équipes
app.post('/api/tournaments/:id/teams', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase !== 'setup') throw fail(409, 'Les poules ont déjà démarré');
  const p1 = str(req.body.p1), p2 = str(req.body.p2);
  const name = str(req.body.name) || autoName(p1, p2);
  if (!name) throw fail(400, 'Nom ou joueurs requis');
  const info = db.prepare('INSERT INTO teams (tournament_id, name, p1, p2) VALUES (?, ?, ?, ?)').run(t.id, name, p1 || null, p2 || null);
  audit(req, t.id, `Paire ajoutée : ${name}`);
  res.status(201).json({ id: info.lastInsertRowid });
}));

app.put('/api/teams/:id', admin, wrap((req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw fail(404, 'Équipe introuvable');
  const t = loadT(team.tournament_id);
  const p1 = req.body.p1 !== undefined ? str(req.body.p1) : team.p1;
  const p2 = req.body.p2 !== undefined ? str(req.body.p2) : team.p2;
  // Nom vide ou identique à l'ancien nom automatique : il suit les joueurs (« A & B »).
  const oldAuto = autoName(team.p1, team.p2);
  let name = req.body.name !== undefined ? str(req.body.name) : team.name;
  if (!name || name === oldAuto) name = autoName(p1, p2) || team.name;
  let grp = team.grp;
  if (req.body.grp !== undefined) {
    if (t.phase !== 'setup') throw fail(409, 'Les poules sont figées');
    grp = req.body.grp === null ? null : intIn(req.body.grp, 0, t.groups_count - 1, team.grp);
  }
  const penalty = req.body.penalty !== undefined ? intIn(req.body.penalty, 0, 99, team.penalty) : team.penalty;
  db.prepare('UPDATE teams SET name=?, p1=?, p2=?, grp=?, penalty=? WHERE id=?').run(name, p1 || null, p2 || null, grp, penalty, team.id);
  const d = [];
  if (name !== team.name) d.push(`nom : ${team.name} → ${name}`);
  if ((p1 || null) !== (team.p1 || null)) d.push(`joueur 1 : ${team.p1 || '—'} → ${p1 || '—'}`);
  if ((p2 || null) !== (team.p2 || null)) d.push(`joueur 2 : ${team.p2 || '—'} → ${p2 || '—'}`);
  if (grp !== team.grp) d.push(`poule : ${team.grp === null ? '—' : String.fromCharCode(65 + team.grp)} → ${grp === null ? '—' : String.fromCharCode(65 + grp)}`);
  if (penalty !== team.penalty) d.push(`pénalité : ${team.penalty} → ${penalty} pt(s)`);
  if (d.length) audit(req, t.id, `Paire « ${team.name} » modifiée : ${d.join(' ; ')}`);
  res.json({ ok: true });
}));

// Changement de partenaire : autorisé pendant les poules uniquement ; pénalité de 2 points à partir de la journée 4.
// Photos des joueurs : lecture publique, envoi réservé aux organisateurs (JPEG déjà réduit par le navigateur)
app.get('/api/photos/:teamId/:n', wrap((req, res) => {
  const r = db.prepare('SELECT data FROM player_photos WHERE team_id = ? AND player = ?').get(Number(req.params.teamId), Number(req.params.n));
  if (!r) throw fail(404, 'Pas de photo');
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).send(r.data);
}));

const photoTarget = (req) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw fail(404, 'Équipe introuvable');
  const n = Number(req.params.n);
  if (n !== 1 && n !== 2) throw fail(400, 'Joueur invalide');
  if (!(n === 1 ? team.p1 : team.p2)) throw fail(400, 'Ce joueur n\'a pas de nom');
  return { team, n, who: n === 1 ? team.p1 : team.p2 };
};
app.put('/api/teams/:id/photo/:n', admin, express.raw({ type: 'image/jpeg', limit: '400kb' }), wrap((req, res) => {
  const { team, n, who } = photoTarget(req);
  const b = req.body;
  if (!Buffer.isBuffer(b) || b.length < 200 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw fail(400, 'Photo JPEG requise (400 Ko maximum)');
  db.prepare('INSERT INTO player_photos (team_id, player, data, v) VALUES (?, ?, ?, ?) ON CONFLICT (team_id, player) DO UPDATE SET data = excluded.data, v = excluded.v')
    .run(team.id, n, b, Date.now());
  audit(req, team.tournament_id, `Photo enregistrée : ${who} (${team.name})`);
  res.json({ ok: true });
}));
app.delete('/api/teams/:id/photo/:n', admin, wrap((req, res) => {
  const { team, n, who } = photoTarget(req);
  if (db.prepare('DELETE FROM player_photos WHERE team_id = ? AND player = ?').run(team.id, n).changes) audit(req, team.tournament_id, `Photo retirée : ${who} (${team.name})`);
  res.json({ ok: true });
}));

app.post('/api/teams/:id/partner-change', admin, wrap((req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw fail(404, 'Équipe introuvable');
  const t = loadT(team.tournament_id);
  if (t.phase !== 'groups') throw fail(409, t.phase === 'setup' ? 'Les poules n\'ont pas démarré : modifiez directement les joueurs' : 'Aucun changement de partenaire pendant les phases finales');
  const player = Number(req.body.player);
  if (player !== 1 && player !== 2) throw fail(400, 'Joueur à remplacer invalide');
  const name = str(req.body.name);
  if (!name) throw fail(400, 'Nom du nouveau partenaire requis');
  const old = [team.p1, team.p2], next = [...old];
  if (old[player - 1] === name) throw fail(400, 'Le partenaire est inchangé');
  next[player - 1] = name;
  const round = L.currentRound(getMatches(t.id), todayTn());
  const penalty = req.body.penalty !== undefined ? intIn(req.body.penalty, 0, 99, 0) : L.partnerPenalty(round);
  const newName = team.name === autoName(old[0], old[1]) ? autoName(next[0], next[1]) : team.name;
  db.transaction(() => {
    db.prepare('INSERT INTO partner_changes (team_id, old_p1, old_p2, new_p1, new_p2, round, penalty, reason, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(team.id, old[0], old[1], next[0], next[1], round, penalty, str(req.body.reason, 200) || null, req.user.username);
    db.prepare('UPDATE teams SET p1 = ?, p2 = ?, name = ?, penalty = penalty + ? WHERE id = ?').run(next[0], next[1], newName, penalty, team.id);
    db.prepare('DELETE FROM player_photos WHERE team_id = ? AND player = ?').run(team.id, player); // la photo était celle du joueur remplacé
  })();
  audit(req, t.id, `Changement de partenaire (${team.name}, journée ${round}) : ${old[player - 1] || '—'} → ${name}, pénalité ${penalty} pt(s)${str(req.body.reason, 200) ? ` — ${str(req.body.reason, 200)}` : ''}`);
  res.json({ ok: true, round, penalty });
}));

app.delete('/api/teams/:id', admin, wrap((req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw fail(404, 'Équipe introuvable');
  if (loadT(team.tournament_id).phase !== 'setup') throw fail(409, 'Les poules ont déjà démarré');
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  audit(req, team.tournament_id, `Paire supprimée : ${team.name}`);
  res.json({ ok: true });
}));

// Édition suivante : reprend les réglages et les paires choisies (la dernière du classement est écartée par défaut côté interface)
app.post('/api/tournaments/:id/next-edition', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase === 'setup') throw fail(409, 'Ce tournoi n\'a pas encore démarré');
  if (db.prepare('SELECT 1 FROM tournaments WHERE prev_id = ?').get(t.id)) throw fail(409, 'L\'édition suivante existe déjà');
  const name = str(req.body.name);
  if (!name) throw fail(400, 'Nom requis');
  const ids = Array.isArray(req.body.team_ids) ? req.body.team_ids.map(Number) : [];
  const teams = ids.map((id) => q.teams.all(t.id).find((x) => x.id === id)).filter(Boolean);
  if (new Set(ids).size !== ids.length || teams.length !== ids.length) throw fail(400, 'Paires invalides');
  if (teams.length < t.groups_count * 2) throw fail(400, `Il faut au moins ${t.groups_count * 2} paires`);
  const slug = crypto.randomBytes(5).toString('hex');
  const nid = db.transaction(() => {
    const info = db.prepare(`INSERT INTO tournaments (slug, name, date, location, groups_count, qualifiers, win_pts, loss_pts, fee, legs, third_place, description, prev_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, name, isDate(req.body.date) ? req.body.date : null, t.location, t.groups_count, t.qualifiers,
      t.win_pts, t.loss_pts, t.fee, t.legs, t.third_place, t.description, t.id);
    const ins = db.prepare('INSERT INTO teams (tournament_id, name, p1, p2) VALUES (?, ?, ?, ?)');
    const copyPhotos = db.prepare('INSERT INTO player_photos (team_id, player, data, v) SELECT ?, player, data, v FROM player_photos WHERE team_id = ?');
    teams.forEach((x) => copyPhotos.run(ins.run(info.lastInsertRowid, x.name, x.p1, x.p2).lastInsertRowid, x.id));
    return info.lastInsertRowid;
  })();
  audit(req, nid, `Tournoi créé comme édition suivante de « ${t.name} » avec ${teams.length} paire(s) reprise(s)`);
  audit(req, t.id, `Édition suivante créée : « ${name} » (${teams.length} paire(s) reprise(s) sur ${q.teams.all(t.id).length})`);
  res.status(201).json({ id: nid, slug });
}));

// Tirage au sort
app.post('/api/tournaments/:id/draw', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase !== 'setup') throw fail(409, 'Les poules ont déjà démarré');
  const teams = q.teams.all(t.id);
  if (teams.length < t.groups_count * 2) throw fail(400, `Il faut au moins ${t.groups_count * 2} équipes pour ${t.groups_count} poule(s)`);
  const groups = L.snakeGroups(L.shuffle(teams.map((x) => x.id)), t.groups_count);
  const upd = db.prepare('UPDATE teams SET grp = ? WHERE id = ?');
  db.transaction(() => groups.forEach((ids, g) => ids.forEach((id) => upd.run(g, id))))();
  audit(req, t.id, 'Tirage au sort des poules effectué');
  res.json({ ok: true });
}));

// Lancer les poules
app.post('/api/tournaments/:id/start', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase !== 'setup') throw fail(409, 'Déjà lancé');
  const teams = q.teams.all(t.id);
  if (teams.some((x) => x.grp === null)) throw fail(400, 'Toutes les équipes doivent avoir une poule (faites le tirage)');
  const counts = Array.from({ length: t.groups_count }, (_, g) => teams.filter((x) => x.grp === g).length);
  if (counts.some((c) => c < 2)) throw fail(400, 'Chaque poule doit avoir au moins 2 équipes');
  if (counts.some((c) => c < t.qualifiers)) throw fail(400, 'Le nombre de qualifiés dépasse la taille d\'une poule');
  const ins = db.prepare('INSERT INTO matches (tournament_id, stage, grp, round, pos, team1, team2) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let g = 0; g < t.groups_count; g++) {
      const ids = teams.filter((x) => x.grp === g).map((x) => x.id);
      L.roundRobin(ids, t.legs).forEach((pairs, r) => pairs.forEach(([a, b], i) => ins.run(t.id, 'group', g, r + 1, i, a, b)));
    }
    db.prepare("UPDATE tournaments SET phase = 'groups' WHERE id = ?").run(t.id);
  })();
  audit(req, t.id, 'Championnat lancé (calendrier des poules généré)');
  res.json({ ok: true });
}));

// Générer le tableau final
app.post('/api/tournaments/:id/knockout', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase !== 'groups') throw fail(409, 'Phase de poules non active');
  const teams = q.teams.all(t.id);
  const matches = getMatches(t.id);
  if (matches.some((m) => m.stage === 'group' && !m.winner)) throw fail(400, 'Tous les matchs de poule doivent être terminés');
  const st = groupStandings(t, teams, matches);
  const seeds = L.knockoutSeeds(st, new Map(teams.map((x) => [x.id, x.grp])), t.qualifiers);
  if (seeds.length < 2) throw fail(400, 'Au moins 2 qualifiés nécessaires');
  const { rounds } = L.buildBracket(seeds, !!t.third_place);
  const ins = db.prepare('INSERT INTO matches (tournament_id, stage, round, pos, team1, team2) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    rounds.forEach((ms, r) => ms.forEach((m) => ins.run(t.id, 'ko', r + 1, m.pos, m.team1, m.team2)));
    db.prepare("UPDATE tournaments SET phase = 'knockout' WHERE id = ?").run(t.id);
    // Byes : l'équipe seule passe directement au tour suivant
    for (const m of db.prepare("SELECT * FROM matches WHERE tournament_id = ? AND stage = 'ko' AND round = 1").all(t.id)) {
      if ((m.team1 === null) !== (m.team2 === null)) {
        const winner = m.team1 ?? m.team2;
        setMatch.run(m.team1, m.team2, null, winner, null, m.id);
        propagate({ ...m, winner });
      }
    }
  })();
  audit(req, t.id, 'Tableau des play-offs généré');
  notify(t.id, null, 'Les play-offs sont lancés : le tableau est disponible.');
  res.json({ ok: true });
}));

// Score keeper : un appareil compte les points en direct avec un lien secret propre au match.
// Le résultat n'entre dans le classement qu'après validation par un organisateur (PUT /api/matches/:id habituel).
// Code court à saisir par les joueurs à la place du lien : 6 caractères sans ambiguïté (ni 0/O ni 1/I/L), affiché « ABC-DEF ».
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newLiveCode = () => {
  for (;;) {
    let c = '';
    for (const b of crypto.randomBytes(6)) c += CODE_CHARS[b % CODE_CHARS.length];
    if (!db.prepare('SELECT 1 FROM live_scores WHERE code = ?').get(c)) return c;
  }
};
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
for (const r of db.prepare('SELECT match_id FROM live_scores WHERE code IS NULL').all()) db.prepare('UPDATE live_scores SET code = ? WHERE match_id = ?').run(newLiveCode(), r.match_id);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS live_scores_code ON live_scores(code)');
const liveByToken = db.prepare('SELECT * FROM live_scores WHERE token = ?');
const liveByMatch = db.prepare('SELECT * FROM live_scores WHERE match_id = ?');

// Organisateurs seulement : crée le comptage d'un match, ou renvoie le lien existant (à partager aux joueurs).
app.post('/api/matches/:id/live', admin, wrap((req, res) => {
  const m = q.match.get(req.params.id);
  if (!m) throw fail(404, 'Match introuvable');
  const t = loadT(m.tournament_id);
  if (!m.team1 || !m.team2) throw fail(400, 'Les deux équipes ne sont pas encore connues');
  if (m.winner) throw fail(409, 'Ce match a déjà un résultat');
  if (m.stage === 'group' && t.phase !== 'groups') throw fail(409, 'Les poules sont closes');
  const old = liveByMatch.get(m.id);
  if (old) return res.json({ token: old.token, code: old.code });
  const token = crypto.randomBytes(16).toString('hex'), code = newLiveCode();
  db.prepare('INSERT INTO live_scores (match_id, token, code, points, status, updated_at) VALUES (?, ?, ?, \'[]\', \'live\', ?)').run(m.id, token, code, Date.now());
  res.json({ token, code });
}));

// Public : un joueur saisit le code reçu d'un organisateur et obtient l'accès au comptage (même limite d'essais que la connexion).
const codeAttempts = new Map();
app.post('/api/live-code', wrap((req, res) => {
  const ip = req.ip;
  const a = codeAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 15) throw fail(429, 'Trop d\'essais, réessayez dans quelques minutes');
  const l = db.prepare('SELECT token FROM live_scores WHERE code = ?').get(normCode(req.body.code));
  if (!l) { codeAttempts.set(ip, { ...a, n: a.n + 1 }); throw fail(404, 'Code inconnu, ou score keeper déjà fermé'); }
  res.json({ token: l.token });
}));

app.get('/api/live/:token', wrap((req, res) => {
  const l = liveByToken.get(req.params.token);
  if (!l) throw fail(404, 'Ce score keeper n\'existe plus (résultat saisi, fermé ou remplacé).');
  const m = q.match.get(l.match_id);
  const t = loadT(m.tournament_id);
  const team = (id) => db.prepare('SELECT id, name FROM teams WHERE id = ?').get(id);
  res.json({
    slug: t.slug, tournament: t.name,
    match: { id: m.id, stage: m.stage, round: m.round, grp: m.grp, court: m.court, time: m.time, date: m.date, team1: team(m.team1), team2: team(m.team2) },
    points: JSON.parse(l.points), status: l.status, updated_at: l.updated_at, code: l.code,
  });
}));

app.put('/api/live/:token', wrap((req, res) => {
  const l = liveByToken.get(req.params.token);
  if (!l) throw fail(404, 'Ce score keeper n\'existe plus (résultat saisi, fermé ou remplacé).');
  const m = q.match.get(l.match_id);
  if (m.winner) throw fail(409, 'Un résultat a déjà été saisi pour ce match');
  const pts = req.body.points;
  if (!Array.isArray(pts) || pts.length > 600 || !pts.every((x) => x === 1 || x === 2)) throw fail(400, 'Points invalides');
  const r = K.replay(pts);
  const points = pts.slice(0, r.used);
  let status = 'live';
  if (req.body.submit) {
    if (!r.winner) throw fail(400, 'Le match n\'est pas terminé');
    status = 'submitted';
  }
  db.prepare('UPDATE live_scores SET points = ?, status = ?, updated_at = ? WHERE match_id = ?').run(JSON.stringify(points), status, Date.now(), m.id);
  res.json({ ok: true, points, status, winner: r.winner });
}));

app.delete('/api/live/:token', wrap((req, res) => {
  db.prepare('DELETE FROM live_scores WHERE token = ?').run(req.params.token);
  res.json({ ok: true });
}));

// Organisateurs : fermer ou rejeter un comptage (libère le match).
app.delete('/api/matches/:id/live', admin, wrap((req, res) => {
  const m = q.match.get(req.params.id);
  if (!m) throw fail(404, 'Match introuvable');
  const l = liveByMatch.get(m.id);
  db.prepare('DELETE FROM live_scores WHERE match_id = ?').run(m.id);
  if (l) audit(req, m.tournament_id, `Score keeper fermé : ${teamLabel(m.team1)} vs ${teamLabel(m.team2)}${l.status === 'submitted' ? ' (résultat proposé rejeté)' : ''}`);
  res.json({ ok: true });
}));

// Saisie d'un résultat / planning
const FORFEIT_SETS = { team1: [[6, 0], [6, 0]], team2: [[0, 6], [0, 6]] };
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

app.put('/api/matches/:id', admin, wrap((req, res) => {
  const m = q.match.get(req.params.id);
  if (!m) throw fail(404, 'Match introuvable');
  const t = loadT(m.tournament_id);
  const b = req.body;
  const court = b.court !== undefined ? str(b.court, 30) || null : m.court;
  const time = b.time !== undefined ? str(b.time, 30) || null : m.time;
  const date = b.date !== undefined ? (isDate(b.date) ? b.date : null) : m.date;
  const oldSets = m.sets ? JSON.parse(m.sets) : null;
  const resultText = (sets, forfeit, winner) => (forfeit === 'both' || winner === -1 ? 'double forfait' : forfeit ? `forfait de ${teamLabel(forfeit === 'team1' ? m.team2 : m.team1)} (${setsText(sets)})` : setsText(sets) || 'aucun score');
  let newResult = null, scored = null;
  db.transaction(() => {
    db.prepare('UPDATE matches SET court = ?, time = ?, date = ? WHERE id = ?').run(court, time, date, m.id);
    if (b.sets === undefined && b.forfeit === undefined) return;
    if (!m.team1 || !m.team2) throw fail(400, 'Les deux équipes ne sont pas encore connues');
    if (m.stage === 'group' && t.phase !== 'groups') throw fail(409, 'Les poules sont closes');
    let sets = b.sets, winner = null, forfeit = null;
    if (b.forfeit) {
      if (b.forfeit === 'both' && m.stage === 'group') { sets = null; winner = -1; forfeit = 'both'; }
      else if (FORFEIT_SETS[b.forfeit]) { sets = FORFEIT_SETS[b.forfeit]; forfeit = b.forfeit; }
      else throw fail(400, 'Forfait invalide');
    }
    if (sets && winner === null) {
      if (!L.validSets(sets)) throw fail(400, 'Score invalide (un vainqueur est requis)');
      winner = L.matchResult(sets).winner === 1 ? m.team1 : m.team2;
    }
    setMatch.run(m.team1, m.team2, sets ? JSON.stringify(sets) : null, winner, forfeit, m.id);
    db.prepare('DELETE FROM live_scores WHERE match_id = ?').run(m.id);
    if (m.stage === 'ko') propagate({ ...m, winner });
    newResult = resultText(sets, forfeit, winner);
    if (sets || winner === -1) scored = { winner, sets, forfeit };
  })();
  const label = `${teamLabel(m.team1)} vs ${teamLabel(m.team2)}`;
  if (newResult !== null) audit(req, t.id, `Score ${label} : ${resultText(oldSets, m.forfeit, m.winner)} → ${newResult}`);
  if (scored && newResult !== resultText(oldSets, m.forfeit, m.winner)) {
    notify(t.id, [m.team1, m.team2], N.resultMessage({ ...scored, team1: m.team1, team2: m.team2 }, teamLabel(m.team1), teamLabel(m.team2), !!m.winner));
  }
  const pd = [];
  if ((date || null) !== (m.date || null)) pd.push(`date : ${m.date || '—'} → ${date || '—'}`);
  if ((time || null) !== (m.time || null)) pd.push(`heure : ${m.time || '—'} → ${time || '—'}`);
  if ((court || null) !== (m.court || null)) pd.push(`terrain : ${m.court || '—'} → ${court || '—'}`);
  if (pd.length) audit(req, t.id, `Planning ${label} : ${pd.join(' ; ')}`);
  // Édition d'un match : les deux paires sont prévenues d'un changement de planning ou d'un résultat effacé.
  if (m.team1 && m.team2) {
    if (pd.length && !m.winner && !scored) {
      notify(t.id, [m.team1, m.team2], `Planning modifié : ${label} → ${N.whenText(date, time)}${court ? ` (${court})` : ''}`);
    }
    if (newResult === 'aucun score' && m.winner) notify(t.id, [m.team1, m.team2], `Résultat annulé : ${label}`);
  }
  res.json({ ok: true });
}));

// Applique la règle « non joué avant la journée suivante » : double forfait pour tous les matchs concernés.
app.post('/api/tournaments/:id/apply-forfeits', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  if (t.phase !== 'groups') throw fail(409, 'Les poules ne sont pas en cours');
  const due = fullState(t).matches.filter((m) => m.late === 'forfeit');
  db.transaction(() => { for (const m of due) { setMatch.run(m.team1, m.team2, null, -1, 'both', m.id); db.prepare('DELETE FROM live_scores WHERE match_id = ?').run(m.id); } })();
  audit(req, t.id, `Double forfait appliqué à ${due.length} match(s) en retard : ${due.map((m) => `${teamLabel(m.team1)} vs ${teamLabel(m.team2)}`).join(', ') || '—'}`);
  for (const m of due) notify(t.id, [m.team1, m.team2], `Double forfait appliqué : ${teamLabel(m.team1)} vs ${teamLabel(m.team2)} (non joué dans les délais, 6-0 / 6-0 pour les deux paires).`);
  res.json({ ok: true, count: due.length });
}));

// Paiements (organisateurs uniquement : jamais inclus dans l'état public)
const round3 = (n) => Math.round(n * 1000) / 1000;

function paymentsSummary(t) {
  const teams = q.teams.all(t.id);
  const pays = db.prepare('SELECT p.* FROM payments p JOIN teams x ON x.id = p.team_id WHERE x.tournament_id = ? ORDER BY p.id').all(t.id);
  let due = 0, paid = 0, complete = 0, players = 0;
  const out = teams.map((x) => {
    const list = [[1, x.p1], [2, x.p2]].filter(([n, name]) => n === 1 || name).map(([n, name]) => {
      const payments = pays.filter((p) => p.team_id === x.id && p.player === n);
      const sum = round3(payments.reduce((a, p) => a + p.amount, 0));
      due += t.fee; paid += sum; players++;
      if (sum >= t.fee) complete++;
      return { n, name: name || x.name, paid: sum, due: t.fee, payments };
    });
    return { id: x.id, name: x.name, players: list };
  });
  return { fee: t.fee, teams: out, totals: { due, paid: round3(paid), remaining: round3(Math.max(0, due - paid)), players, complete } };
}

app.get('/api/tournaments/:id/payments', admin, wrap((req, res) => {
  res.json(paymentsSummary(loadT(req.params.id)));
}));

app.post('/api/teams/:id/payments', admin, wrap((req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) throw fail(404, 'Équipe introuvable');
  const player = intIn(req.body.player, 1, 2, 0);
  if (!player || (player === 2 && !team.p2)) throw fail(400, 'Joueur invalide');
  const amount = round3(Number(req.body.amount));
  if (!(amount > 0) || amount > 100000) throw fail(400, 'Montant invalide');
  const method = ['especes', 'virement', 'autre'].includes(req.body.method) ? req.body.method : null;
  const paidOn = isDate(req.body.paid_on) ? req.body.paid_on : new Date().toISOString().slice(0, 10);
  const info = db.prepare('INSERT INTO payments (team_id, player, amount, method, note, paid_on, username) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(team.id, player, amount, method, str(req.body.note, 200) || null, paidOn, req.user.username);
  audit(req, team.tournament_id, `Paiement enregistré : ${amount} DT (${team.name}, joueur ${player})`);
  res.status(201).json({ id: info.lastInsertRowid });
}));

app.delete('/api/payments/:id', admin, wrap((req, res) => {
  const pay = db.prepare('SELECT p.*, x.name, x.tournament_id FROM payments p JOIN teams x ON x.id = p.team_id WHERE p.id = ?').get(req.params.id);
  if (!pay) throw fail(404, 'Paiement introuvable');
  db.prepare('DELETE FROM payments WHERE id = ?').run(pay.id);
  audit(req, pay.tournament_id, `Paiement supprimé : ${pay.amount} DT (${pay.name}, joueur ${pay.player})`);
  res.json({ ok: true });
}));

app.get('/api/tournaments/:id/payments.csv', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const sum = paymentsSummary(t);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Paire', 'Joueur', 'Dû (DT)', 'Payé (DT)', 'Reste (DT)', 'Statut'].map(cell).join(';')];
  for (const x of sum.teams) for (const p of x.players) {
    lines.push([x.name, p.name, p.due, p.paid, round3(Math.max(0, p.due - p.paid)), p.paid >= p.due ? 'Payé' : p.paid > 0 ? 'Partiel' : 'Impayé'].map(cell).join(';'));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="paiements-${t.slug}.csv"`).send('\ufeff' + lines.join('\r\n'));
}));

// Report de match : nouvelle date avant la journée suivante (sinon confirmation explicite = exception).
const isTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
const dayBefore = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

app.get('/api/matches/:id/postponements', admin, wrap((req, res) => {
  res.json(db.prepare('SELECT from_date, from_time, to_date, to_time, reason, username, created_at FROM postponements WHERE match_id = ? ORDER BY id').all(req.params.id));
}));

app.post('/api/matches/:id/postpone', admin, wrap((req, res) => {
  const m = q.match.get(req.params.id);
  if (!m) throw fail(404, 'Match introuvable');
  const t = loadT(m.tournament_id);
  if (m.stage !== 'group' || t.phase !== 'groups') throw fail(409, 'Seuls les matchs de poule peuvent être reportés pendant le championnat');
  if (m.winner) throw fail(409, 'Ce match a déjà un résultat');
  if (!m.team1 || !m.team2) throw fail(400, 'Match incomplet');
  const b = req.body;
  if (!isDate(b.date)) throw fail(400, 'Nouvelle date requise');
  const time = isTime(b.time) ? b.time : null;
  if (b.date === m.date && time === (m.time || null)) throw fail(400, 'La date et l\'horaire sont inchangés');
  const next = db.prepare("SELECT MIN(date) AS d FROM matches WHERE tournament_id = ? AND stage = 'group' AND grp = ? AND round = ? AND date IS NOT NULL").get(t.id, m.grp, m.round + 1).d;
  if (next && b.date >= next && !b.force) {
    throw Object.assign(fail(409, `Cette date n'est pas avant la journée suivante (${next}) : sans résultat à cette date, les deux paires perdent 6-0 / 6-0.`), { needsForce: true });
  }
  const court = b.court !== undefined ? str(b.court, 30) || null : m.court;
  db.transaction(() => {
    db.prepare('INSERT INTO postponements (match_id, from_date, from_time, to_date, to_time, reason, username) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.date, m.time, b.date, time, str(b.reason, 200) || null, req.user.username);
    db.prepare('UPDATE matches SET date = ?, time = ?, court = ? WHERE id = ?').run(b.date, time, court, m.id);
  })();
  audit(req, t.id, `Match reporté ${teamLabel(m.team1)} vs ${teamLabel(m.team2)} : ${m.date || '—'}${m.time ? ` ${m.time}` : ''} → ${b.date}${time ? ` ${time}` : ''}${b.force ? ' (hors limite, confirmé)' : ''}${str(b.reason, 200) ? ` — ${str(b.reason, 200)}` : ''}`);
  notify(t.id, [m.team1, m.team2], `Match reporté : ${teamLabel(m.team1)} vs ${teamLabel(m.team2)} → ${N.whenText(b.date, time)}${str(b.reason, 200) ? ` (${str(b.reason, 200)})` : ''}`);
  res.json({ ok: true, deadline: next ? dayBefore(next) : null });
}));

// Calendrier : attribue date, horaire et terrain aux matchs de poule, une journée par jour de jeu.
app.post('/api/tournaments/:id/schedule', admin, wrap((req, res) => {
  const t = loadT(req.params.id);
  const b = req.body;
  if (t.phase !== 'groups') throw fail(409, 'Le calendrier se génère une fois les poules lancées');
  if (!isDate(b.start)) throw fail(400, 'Date de début invalide');
  const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y);
  const times = (Array.isArray(b.times) ? b.times : []).map((x) => str(x, 5)).filter((x) => /^\d{2}:\d{2}$/.test(x));
  const courts = intIn(b.courts, 1, 20, 3);
  if (!days.length || !times.length) throw fail(400, 'Choisissez au moins un jour et un horaire');
  const matches = getMatches(t.id).filter((m) => m.stage === 'group' && !m.winner);
  const rounds = [...new Set(matches.map((m) => m.round))].sort((x, y) => x - y);
  const cursor = new Date(`${b.start}T12:00:00Z`);
  const nextDay = () => { while (!days.includes(cursor.getUTCDay())) cursor.setUTCDate(cursor.getUTCDate() + 1); const d = cursor.toISOString().slice(0, 10); cursor.setUTCDate(cursor.getUTCDate() + 1); return d; };
  const upd = db.prepare('UPDATE matches SET date = ?, time = ?, court = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rounds) {
      const date = nextDay();
      matches.filter((m) => m.round === r).sort((x, y) => x.grp - y.grp || x.pos - y.pos).forEach((m, i) => {
        const slot = Math.floor(i / courts);
        upd.run(date, times[Math.min(slot, times.length - 1)], `Terrain ${(i % courts) + 1}`, m.id);
      });
    }
  })();
  audit(req, t.id, `Calendrier généré à partir du ${b.start} (${rounds.length} journée(s), ${matches.length} match(s) planifiés)`);
  res.json({ ok: true, days: rounds.length });
}));

// Import d'un championnat existant (équipes + calendrier + scores) : crée directement un tournoi en phase de poules.
app.post('/api/import', admin, wrap((req, res) => {
  const b = req.body;
  const name = str(b.name);
  if (!name) throw fail(400, 'Nom requis');
  if (!Array.isArray(b.teams) || b.teams.length < 2 || !Array.isArray(b.matches)) throw fail(400, 'Équipes et matchs requis');
  const keys = new Set(b.teams.map((x) => x.key));
  if (keys.size !== b.teams.length) throw fail(400, 'Clés d\'équipe en double');
  const pairs = new Set();
  for (const m of b.matches) {
    if (!keys.has(m.team1) || !keys.has(m.team2) || m.team1 === m.team2) throw fail(400, `Match invalide : ${m.team1} / ${m.team2}`);
    const k = [m.team1, m.team2].sort().join('|');
    if (pairs.has(k)) throw fail(400, `Match en double : ${m.team1} / ${m.team2}`);
    pairs.add(k);
    if (m.sets && !L.validSets(m.sets)) throw fail(400, `Score invalide : ${m.team1} / ${m.team2}`);
  }
  const slug = crypto.randomBytes(5).toString('hex');
  const insT = db.prepare(`INSERT INTO tournaments (slug, name, date, location, phase, groups_count, qualifiers, win_pts, loss_pts, legs, third_place, description)
    VALUES (?, ?, ?, ?, 'groups', 1, ?, ?, ?, 1, 1, ?)`);
  const insTeam = db.prepare('INSERT INTO teams (tournament_id, name, p1, p2, grp) VALUES (?, ?, ?, ?, 0)');
  const insM = db.prepare('INSERT INTO matches (tournament_id, stage, grp, round, pos, team1, team2, sets, winner, court, time, date) VALUES (?, \'group\', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tid = db.transaction(() => {
    const id = insT.run(slug, name, isDate(b.date) ? b.date : null, str(b.location) || null, intIn(b.qualifiers, 1, 8, 4),
      intIn(b.win_pts, 0, 20, 3), intIn(b.loss_pts, 0, 20, 0), str(b.description, 8000) || null).lastInsertRowid;
    const ids = {};
    for (const t of b.teams) ids[t.key] = insTeam.run(id, str(t.name), str(t.p1) || null, str(t.p2) || null).lastInsertRowid;
    const pos = {};
    for (const m of b.matches) {
      const r = intIn(m.round, 1, 99, 1);
      pos[r] = (pos[r] ?? -1) + 1;
      const winner = m.sets ? (L.matchResult(m.sets).winner === 1 ? ids[m.team1] : ids[m.team2]) : null;
      insM.run(id, r, pos[r], ids[m.team1], ids[m.team2], m.sets ? JSON.stringify(m.sets) : null, winner,
        str(m.court, 30) || null, str(m.time, 30) || null, isDate(m.date) ? m.date : null);
    }
    return id;
  })();
  audit(req, tid, `Tournoi importé : « ${name} » (${b.teams.length} paires, ${b.matches.length} matchs)`);
  res.status(201).json({ id: tid, slug });
}));

// Redirige les URLs partageables vers l'application
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  const autoBackup = () => { try { makeBackup(); } catch (e) { console.error('Sauvegarde auto échouée :', e.message); } };
  autoBackup();
  setInterval(autoBackup, 3600e3).unref();
  setTimeout(runReminders, 20e3).unref();
  setInterval(runReminders, 10 * 60e3).unref();
  app.listen(PORT, () => console.log(`Padel tournois sur http://localhost:${PORT}`));
}
module.exports = { app, db };
