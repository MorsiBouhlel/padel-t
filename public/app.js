'use strict';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const dlg = $('#dlg');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const groupLetter = (g) => String.fromCharCode(65 + g);
const PHASES = { setup: 'Inscriptions', groups: 'Phase de poules', knockout: 'Phase finale', finished: 'Terminé' };

let token = null;
let me = null; // { username, owner }
try { token = localStorage.getItem('token'); me = JSON.parse(localStorage.getItem('me')); } catch {}
const isAdmin = () => !!token;

let cur = null; // { slug, tab, data, filter }

// --- Utilitaires -----------------------------------------------------------
async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && path !== '/api/login') { setToken(null); render(); }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur réseau'), { data });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

function setToken(t, user = null) {
  token = t;
  me = t ? user || me : null;
  try {
    if (t) { localStorage.setItem('token', t); localStorage.setItem('me', JSON.stringify(me)); }
    else { localStorage.removeItem('token'); localStorage.removeItem('me'); }
  } catch {}
  $('#auth').textContent = t ? `${me?.username || 'Compte'} ▾` : 'Organisateur';
}

function openDialog(html, onSubmit) {
  dlg.innerHTML = `<form method="dialog" id="dform">${html}<p class="err" id="derr"></p></form>`;
  const form = $('#dform');
  form.querySelectorAll('button[value="cancel"]').forEach((b) => (b.formNoValidate = true));
  form.addEventListener('submit', async (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel') return;
    e.preventDefault();
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), action);
      dlg.close();
    } catch (err) { $('#derr').textContent = err.message; }
  });
  dlg.showModal();
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await load(); } catch (e) { toast(e.message); }
}

// --- Routage -----------------------------------------------------------------
async function render() {
  keeperStop();
  const m = location.hash.match(/^#\/t\/([\w-]+)(?:\/team\/(\d+))?/);
  const k = location.hash.match(/^#\/live\/(\w+)/);
  try {
    if (k) {
      cur = null;
      $('#bell').hidden = true;
      await renderKeeper(k[1]);
    } else if (m) {
      if (!cur || cur.slug !== m[1]) cur = { slug: m[1], tab: null, filter: 'all', data: null };
      cur.team = m[2] ? Number(m[2]) : null;
      await load();
      window.scrollTo(0, 0);
    } else {
      cur = null;
      $('#bell').hidden = true;
      await renderHome();
    }
  } catch (e) {
    keeperStop();
    app.innerHTML = `<div class="empty">${esc(e.message)}<p><a href="#/">Retour</a></p></div>`;
  }
}

async function load() {
  if (!cur) return renderHome();
  cur.data = await api(`/api/t/${cur.slug}`);
  cur.pay = isAdmin() ? await api(`/api/tournaments/${cur.data.tournament.id}/payments`).catch(() => null) : null;
  cur.log = isAdmin() ? await api(`/api/tournaments/${cur.data.tournament.id}/audit`).catch(() => []) : null;
  cur.followers = isAdmin() ? await api(`/api/tournaments/${cur.data.tournament.id}/followers`).catch(() => null) : null;
  if (!cur.tab) cur.tab = { setup: isAdmin() ? 'teams' : 'info', groups: 'groups' }[cur.data.tournament.phase] || 'bracket';
  if (isAdmin() && (cur.tab === 'chances' || cur.team)) await loadForecast();
  renderTournament();
}

// --- Accueil -------------------------------------------------------------------
async function renderHome() {
  const list = await api('/api/tournaments');
  const meta = (t) => [t.date && new Date(t.date).toLocaleDateString('fr-FR'), t.location, `${t.teams} équipe${t.teams > 1 ? 's' : ''}`].filter(Boolean).map(esc).join(' · ');
  const arrow = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  // Grande carte pour un tournoi en cours : avancement et prochain match.
  const live = (t) => {
    const d = t.next && new Date(`${t.next.date}T12:00:00`);
    const pct = t.matches ? Math.round((t.played / t.matches) * 100) : 0;
    return `<a class="card tcard" href="#/t/${esc(t.slug)}">
      <div class="row between"><span class="badge live">EN COURS</span><span class="muted">${PHASES[t.phase]}</span></div>
      <h2>${esc(t.name)}</h2><div class="muted">${meta(t)}</div>
      ${t.matches ? `<div class="row between" style="margin-top:14px"><strong>${t.played} match${t.played > 1 ? 's' : ''} joué${t.played > 1 ? 's' : ''}</strong><span class="muted">sur ${t.matches}</span></div><div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${t.next ? `<div class="next"><div class="datechip"><b>${d.getDate()}</b><span>${esc(d.toLocaleDateString('fr-FR', { month: 'short' }))}</span></div>
        <div class="grow"><div class="muted">Prochain match${t.next.time ? ` · ${esc(t.next.time)}` : ''}</div><strong>${esc(t.next.t1)} – ${esc(t.next.t2)}</strong></div></div>` : ''}
      <span class="cta">Voir le tournoi ${arrow}</span></a>`;
  };
  const simple = (t) => `
      <a class="card" href="#/t/${esc(t.slug)}">
        <div class="row between"><strong>${esc(t.name)}</strong><span class="badge">${PHASES[t.phase]}</span></div>
        <div class="muted">${meta(t)}</div>
      </a>`;
  const running = list.filter((t) => t.phase === 'groups' || t.phase === 'knockout');
  const others = list.filter((t) => t.phase === 'setup');
  const archived = list.filter((t) => t.phase === 'finished');
  app.innerHTML = `
    ${isAdmin() ? '<div class="row between"><h1>Tournois</h1><button id="new" class="primary">+ Nouveau</button></div>' : ''}
    ${isAdmin() ? '' : codeEntry()}
    ${list.length ? running.map(live).join('') + others.map(simple).join('') + (archived.length ? `<h2>Archives</h2>${archived.map(simple).join('')}` : '') : '<div class="empty">Aucun tournoi pour le moment.</div>'}`;
  $('#new')?.addEventListener('click', () => tournamentDialog());
}

async function tournamentDialog(t) {
  const setup = !t || t.phase === 'setup';
  let description = t?.description ?? '';
  if (!t) { try { description = await (await fetch('/rules-default.txt')).text(); } catch {} }
  openDialog(`
    <h3>${t ? 'Réglages' : 'Nouveau tournoi'}</h3>
    <label>Nom</label><input name="name" required maxlength="80" value="${esc(t?.name)}">
    <div class="grid2"><div><label>Date</label><input type="date" name="date" value="${esc(t?.date)}"></div>
    <div><label>Lieu</label><input name="location" maxlength="80" value="${esc(t?.location)}"></div></div>
    <div class="grid2"><div><label>Nombre de poules</label><input type="number" inputmode="numeric" name="groups_count" min="1" max="8" value="${t?.groups_count ?? 1}" ${setup ? '' : 'disabled'}></div>
    <div><label>Qualifiés par poule</label><input type="number" inputmode="numeric" name="qualifiers" min="1" max="8" value="${t?.qualifiers ?? 4}" ${setup ? '' : 'disabled'}></div></div>
    <div class="grid2"><div><label>Points victoire</label><input type="number" inputmode="numeric" name="win_pts" min="0" max="20" value="${t?.win_pts ?? 3}"></div>
    <div><label>Points défaite</label><input type="number" inputmode="numeric" name="loss_pts" min="0" max="20" value="${t?.loss_pts ?? 0}"></div></div>
    <div class="grid2"><div><label>Matchs en poule</label><select name="legs" ${setup ? '' : 'disabled'}><option value="1" ${t?.legs !== 2 ? 'selected' : ''}>Aller simple</option><option value="2" ${t?.legs === 2 ? 'selected' : ''}>Aller / retour</option></select></div>
    <div><label>Match pour la 3e place</label><select name="third_place" ${!t || ['setup', 'groups'].includes(t.phase) ? '' : 'disabled'}><option value="1" ${t?.third_place !== 0 ? 'selected' : ''}>Oui</option><option value="0" ${t?.third_place === 0 ? 'selected' : ''}>Non</option></select></div></div>
    <label>Frais de participation par joueur (DT)</label><input type="number" inputmode="numeric" name="fee" min="0" max="100000" value="${t?.fee ?? 150}">
    <label>Description / règlement</label><textarea name="description" rows="6" maxlength="8000">${esc(description)}</textarea>
    <div class="row between" style="margin-top:16px">
      ${t ? '<button value="delete" class="danger small">Supprimer</button>' : '<span></span>'}
      <span class="row"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Enregistrer</button></span>
    </div>`, async (f, action) => {
    if (action === 'delete') {
      if (!confirm('Supprimer définitivement ce tournoi ?')) throw new Error('Suppression annulée');
      await api(`/api/tournaments/${t.id}`, 'DELETE');
      location.hash = '#/';
      return;
    }
    if (t) { await api(`/api/tournaments/${t.id}`, 'PUT', f); await load(); toast('Réglages enregistrés'); }
    else { const r = await api('/api/tournaments', 'POST', f); location.hash = `#/t/${r.slug}`; }
  });
}

// Édition suivante : reprend les paires, sans la dernière de chaque poule par défaut (règlement)
function nextEditionDialog() {
  const { tournament: t, teams, standings } = cur.data;
  const last = new Set(standings.map((g) => g.rows[g.rows.length - 1]?.id));
  const rank = new Map(standings.flatMap((g) => g.rows.map((r) => [r.id, r.rank])));
  const ordered = [...teams].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
  const name = /\d+/.test(t.name) ? t.name.replace(/\d+/, (n) => Number(n) + 1) : `${t.name} (suite)`;
  const provisional = t.phase !== 'finished' && cur.data.matches.some((m) => m.stage === 'group' && !m.winner);
  openDialog(`<h3>Édition suivante</h3>
    <label>Nom</label><input name="name" required maxlength="80" value="${esc(name)}">
    <label>Date (facultatif)</label><input type="date" name="date">
    <label>Paires reprises</label>
    ${provisional ? '<p class="muted" style="margin:0 0 6px">⚠ Le classement est encore provisoire : vérifiez la case décochée.</p>' : ''}
    ${ordered.map((x) => `<label class="row" style="padding:6px 0;border-bottom:1px solid var(--line);gap:10px;font-weight:400"><input type="checkbox" name="t${x.id}" ${last.has(x.id) ? '' : 'checked'} style="width:auto"> <span>${rank.get(x.id) ? `${rank.get(x.id)}. ` : ''}${esc(x.name)}${last.has(x.id) ? ' <span class="muted">(dernière : écartée par défaut)</span>' : ''}</span></label>`).join('')}
    <p class="muted">Réglages et règlement repris ; pénalités, scores et paiements repartent à zéro. Les poules seront à tirer au sort de nouveau.</p>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="ok" class="primary">Créer l'édition</button></div>`,
    async (f) => {
      const ids = ordered.filter((x) => f[`t${x.id}`] !== undefined).map((x) => x.id);
      const r = await api(`/api/tournaments/${t.id}/next-edition`, 'POST', { name: f.name, date: f.date || null, team_ids: ids });
      location.hash = `#/t/${r.slug}`; toast('Édition créée');
    });
}

// --- Tournoi ---------------------------------------------------------------------
function renderTournament() {
  if (cur.team) return renderTeamPage();
  const { tournament: t, teams } = cur.data;
  if ((cur.tab === 'pay' || cur.tab === 'log' || cur.tab === 'dash' || cur.tab === 'manage' || cur.tab === 'chances' || cur.tab === 'teams') && !isAdmin()) cur.tab = t.phase === 'setup' ? 'info' : 'groups';
  const adminTabs = [['teams', 'Équipes'], ['dash', 'Suivi'], ['pay', 'Paiements'], ['log', 'Historique'], ['manage', 'Gestion']];
  document.title = `${t.name} · Padel`;
  app.innerHTML = `
    <div class="hero">
      <div class="row between"><a href="#/" class="back">← Tous les tournois</a><span class="badge ${t.phase === 'groups' || t.phase === 'knockout' ? 'live' : ''}">${PHASES[t.phase]}</span></div>
      <h1>${esc(t.name)}</h1>
      <div class="muted">${[t.date && new Date(t.date).toLocaleDateString('fr-FR', { dateStyle: 'full' }), t.location, `${teams.length} équipes`].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="row" style="margin-top:10px">
        <button class="ghost small" id="share" style="color:inherit">Copier le lien</button>
        <button class="ghost small" id="notif" style="color:inherit" data-off="🔔 Activer les notifications" data-on="🔔 Notifications ✓">🔔 Notifications</button>
      </div>
      ${t.prev || t.next ? `<div class="muted" style="margin-top:8px">${[t.prev && `← <a href="#/t/${esc(t.prev.slug)}">${esc(t.prev.name)}</a>`, t.next && `<a href="#/t/${esc(t.next.slug)}">${esc(t.next.name)}</a> →`].filter(Boolean).join(' · ')}</div>` : ''}
    </div>
    ${isAdmin() ? `<div class="chips"><span class="lab">Organisation</span>${adminTabs.map(([k, l]) => `<button data-tab="${k}" aria-selected="${cur.tab === k}">${l}</button>`).join('')}</div>` : ''}
    <div id="panel" style="margin-top:6px">${{ teams: teamsPanel, groups: groupsPanel, matches: matchesPanel, bracket: bracketPanel, stats: statsPanel, chances: chancesPanel, live: livePanel, info: infoPanel, dash: dashPanel, pay: payPanel, log: logPanel, manage: managePanel }[cur.tab]()}</div>
    ${navHtml(cur.tab)}`;

  $('#share').onclick = async () => {
    const url = `${location.origin}/#/t/${t.slug}`;
    try { await navigator.clipboard.writeText(url); toast('Lien copié'); } catch { prompt('Lien du tournoi', url); }
  };
  $('#notif').onclick = () => pushDialog();
  updateNotifButton();
  $('#settings')?.addEventListener('click', () => tournamentDialog(t));
  $('#broadcast')?.addEventListener('click', broadcastDialog);
  $('#nextEd')?.addEventListener('click', nextEditionDialog);
  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = async () => {
    cur.tab = b.dataset.tab;
    renderTournament();
    // Les prévisions se calculent à la demande : on les charge à l'ouverture de l'onglet.
    if (cur.tab === 'chances' && isAdmin()) { await loadForecast(); if (cur.tab === 'chances') renderTournament(); }
  }));
  bindPanel();
}

// Joueurs « A & B », affichés sous le nom seulement s'il diffère (nom de paire personnalisé) : sinon rien.
const playersLine = (x) => { const l = [x.p1, x.p2].filter(Boolean).join(' & '); return l && l !== x.name ? l : ''; };
// --- Photos des joueurs ----------------------------------------------------
// Avatars : photo du joueur, ou son initiale à défaut.
function avatar(x, n, px) {
  const name = n === 1 ? x.p1 : x.p2;
  if (!name) return '';
  const v = x[`photo${n}`];
  return v
    ? `<img class="av" style="--s:${px}px" src="/api/photos/${x.id}/${n}?v=${v}" alt="${esc(name)}" loading="lazy">`
    : `<span class="av ini" style="--s:${px}px" aria-hidden="true">${esc(name.trim().charAt(0).toUpperCase())}</span>`;
}
const avatars = (id, px = 28) => {
  const x = cur.data.teams.find((t) => t.id === id);
  return x && (x.p1 || x.p2) ? `<span class="avs">${avatar(x, 1, px)}${avatar(x, 2, px)}</span>` : '';
};

// Photo carrée 256 px en JPEG : léger à envoyer et à afficher, quelle que soit la photo d'origine.
async function resizePhoto(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
  const S = 256, side = Math.min(bmp.width, bmp.height);
  const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Photo illisible');
  return blob;
}
async function uploadPhoto(teamId, n, file) {
  const body = await resizePhoto(file);
  const res = await fetch(`/api/teams/${teamId}/photo/${n}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${token}` }, body });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Envoi impossible');
}

// Navigation du bas : onglets publics, icônes en trait fin.
const NAV = [
  ['groups', 'Classement', 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z'],
  ['matches', 'Matchs', 'M5 5h14v15H5zM5 10h14M9 3v4M15 3v4'],
  ['live', 'Live', 'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13'],
  ['bracket', 'Play-offs', 'M4 5h5v4H4zM4 15h5v4H4zM9 7h4v10H9M13 12h7'],
  ['chances', 'Chances', 'M19 5L5 19M7.5 7.5h.01M16.5 16.5h.01'],
  ['stats', 'Stats', 'M5 20V10M12 20V4M19 20v-7'],
  ['info', 'Infos', 'M12 8h.01M11 12h1v5h1M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0'],
];
// Parties en cours de comptage (score keeper) : l'onglet Live n'apparaît que s'il y en a, pour ne pas surcharger la barre.
const liveMatches = () => cur.data.matches.filter((m) => m.live && !m.winner && m.live.status === 'live' && m.live.points > 0);
const navHtml = (active) => {
  const n = liveMatches().length;
  return `<nav class="tabs" role="tablist" aria-label="Sections du tournoi">${NAV.filter(([k]) => (k !== 'chances' || isAdmin()) && (k !== 'live' || n || active === 'live')).map(([k, l, d]) =>
    `<button role="tab" data-tab="${k}" aria-selected="${active === k}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>${l}${k === 'live' && n ? '<i class="navdot"></i>' : ''}</button>`).join('')}</nav>`;
};

const teamName = (id) => (cur.data.teams.find((t) => t.id === id) || {}).name;
const teamLink = (id) => `<a class="tlink" href="#/t/${esc(cur.slug)}/team/${id}">${esc(teamName(id))}</a>`;

// Équipes
function teamsPanel() {
  const { tournament: t, teams } = cur.data;
  const setup = t.phase === 'setup';
  const adminSetup = isAdmin() && setup;
  const adminGroups = isAdmin() && t.phase === 'groups';
  const done = cur.data.matches.filter((m) => m.stage === 'group' && m.winner).length;
  const total = cur.data.matches.filter((m) => m.stage === 'group').length;
  return `
    ${adminSetup ? `
      <form id="addTeam" class="card">
        <h3>Ajouter une équipe</h3>
        <div class="grid2"><input name="p1" placeholder="Joueur 1" required maxlength="40" autocomplete="off"><input name="p2" placeholder="Joueur 2" maxlength="40" autocomplete="off"></div>
        <button class="primary" style="margin-top:10px;width:100%">Ajouter</button>
      </form>` : ''}
    ${adminSetup ? `<div class="row"><button id="draw" class="grow">🎲 Tirage au sort des poules</button><button id="start" class="primary grow">Lancer les poules</button></div>
      <p class="muted">${t.groups_count} poule(s), ${t.qualifiers} qualifié(s) par poule. Vous pouvez ajuster les poules à la main après le tirage.</p>` : ''}
    ${adminGroups ? `<div class="card"><strong>${done}/${total} matchs de poule joués</strong>
      <p class="muted">Quand tous les matchs sont saisis, générez le tableau final.</p>
      <div class="row"><button id="schedule">📅 Planifier le calendrier</button>
      <button id="ko" class="primary" ${done < total ? 'disabled' : ''}>Générer les play-offs</button></div></div>` : ''}
    ${teams.length ? teams.map((x) => `
      <div class="card row between">
        ${avatars(x.id, 38)}
        <div class="grow"><strong>${isAdmin() && t.phase === 'setup' ? esc(x.name) : teamLink(x.id)}</strong>${playersLine(x) ? `<div class="muted">${esc(playersLine(x))}</div>` : ''}</div>
        ${adminSetup ? `<select data-grp="${x.id}" style="width:auto" aria-label="Poule">
            <option value="">—</option>${Array.from({ length: t.groups_count }, (_, g) => `<option value="${g}" ${x.grp === g ? 'selected' : ''}>Poule ${groupLetter(g)}</option>`).join('')}</select>
          <button class="danger small" data-del="${x.id}" aria-label="Supprimer ${esc(x.name)}">✕</button>`
          : t.groups_count > 1 && x.grp !== null ? `<span class="badge">Poule ${groupLetter(x.grp)}</span>` : ''}
        ${x.reports ? `<span class="badge" title="Matchs reportés">${x.reports} report${x.reports > 1 ? 's' : ''}</span>` : ''}
        ${x.penalty ? `<span class="badge" style="background:var(--danger);color:#fff">−${x.penalty} pt${x.penalty > 1 ? 's' : ''}</span>` : ''}
        ${isAdmin() ? `<button class="ghost small" data-edit="${x.id}" style="color:inherit">Modifier</button>` : ''}
      </div>`).join('') : '<div class="empty">Aucune équipe inscrite.</div>'}`;
}

// Classement
function groupsPanel() {
  const { standings, tournament: t } = cur.data;
  if (!standings.length) return '<div class="empty">Le classement sera affiché après le lancement du championnat.</div>';
  const podium = (rows) => {
    const col = (r, cls) => `<div class="${cls}">${avatars(r.id, 40)}<div class="nm">${teamLink(r.id)}</div><div class="pts">${r.points} pts</div><div class="step">${r.rank}</div></div>`;
    return rows.length >= 3 && rows[0].played > 0 ? `<div class="card"><div class="podium">${col(rows[1], 'p2')}${col(rows[0], 'p1')}${col(rows[2], 'p3')}</div></div>` : '';
  };
  return standings.map((g) => `${podium(g.rows)}
    <div class="card">
      ${t.groups_count > 1 ? `<h3>Poule ${groupLetter(g.group)}</h3>` : ''}
      <table><thead><tr><th>#</th><th class="name">Équipe</th><th title="Matchs joués">J</th><th title="Victoires">V</th><th title="Défaites">D</th><th title="Jeux marqués">Pour</th><th title="Différence de jeux">Diff</th><th>Pts</th></tr></thead>
      <tbody>${g.rows.map((r) => `<tr class="${r.rank <= t.qualifiers ? 'qual' : ''}"><td>${r.rank}</td><td class="name">${avatars(r.id, 24)}${teamLink(r.id)}${r.penalty ? ` <span class="muted" title="Pénalité">(−${r.penalty})</span>` : ''}</td><td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td>
        <td>${r.gamesFor}</td><td>${signed(r.gamesFor - r.gamesAgainst)}</td><td><strong>${r.points}</strong></td></tr>`).join('')}</tbody></table>
    </div>`).join('') + `<p class="muted">La barre verte indique les équipes qualifiées. Départage : points, différence de jeux, jeux marqués, confrontation directe, moins de matchs joués, puis tirage au sort.</p>
    <div class="row" style="margin-top:8px"><button class="primary small" data-share="rank">Partager sur WhatsApp</button><button class="ghost small" data-share="img" style="color:inherit">Image du classement</button><button class="ghost small" data-share="rank-copy" style="color:inherit">Copier le texte</button></div>`;
}
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const signed = (n) => (n > 0 ? `+${n}` : n);

// Matchs
function matchCard(m) {
  const { tournament: t } = cur.data;
  const bye = m.stage === 'ko' && m.round === 1 && m.winner && (!m.team1 || !m.team2);
  const editable = isAdmin() && m.team1 && m.team2 && (m.stage === 'ko' || t.phase === 'groups');
  const line = (id, i) => {
    const name = id ? (editable ? esc(teamName(id)) : teamLink(id)) : bye ? 'Exempt' : 'À déterminer';
    // Le score le plus haut de chaque set est en gras, quelle que soit l'équipe qui gagne le match.
    const sc = m.sets ? m.sets.map((s) => (s[i] > s[1 - i] ? `<strong>${s[i]}</strong>` : s[i])).join(' ') : m.forfeit === 'both' ? 'F' : '';
    return `<div class="t ${m.winner && m.winner === id ? 'win' : ''} ${id ? '' : 'tbd'} ${id && id === cur.team ? 'me' : ''}"><span>${name}</span></div><div class="sc">${sc}</div>`;
  };
  const label = m.stage === 'group' ? (t.groups_count > 1 ? `Poule ${groupLetter(m.grp)} · J${m.round}` : `J${m.round}`) : m.pos === 1 && m.round === cur.data.koRounds ? cur.data.thirdName : cur.data.roundNames[m.round];
  const forfeit = { team1: `Forfait ${esc(teamName(m.team2))}`, team2: `Forfait ${esc(teamName(m.team1))}`, both: 'Double forfait' }[m.forfeit];
  const first = m.moves?.[0];
  const moved = first && !m.winner ? `<strong>Reporté</strong> (prévu ${first.from_date ? fmtDate(first.from_date) : '—'})${m.deadline ? `, à jouer avant le ${fmtDate(m.deadline)}` : ''}` : first ? `Reporté (prévu ${first.from_date ? fmtDate(first.from_date) : '—'})` : '';
  const lateTag = { late: '<strong>⚠ En retard</strong>', forfeit: '<strong>⚠ Forfait à appliquer</strong>' }[m.late];
  const meta = [label, m.date && fmtDate(m.date), m.time, m.court, moved, lateTag, forfeit && `<strong>${forfeit}</strong>`].filter(Boolean).map((x) => (x.includes('<strong>') ? x : x.startsWith('Reporté') ? x : esc(x))).join(' · ');
  const tag = editable ? 'button' : 'div';
  return `<${tag} class="match ${m.winner || bye ? '' : 'todo'} ${editable ? 'editable' : ''}" ${editable ? `data-match="${m.id}"` : ''}>
    ${line(m.team1, 0)}${line(m.team2, 1)}<div class="meta">${meta}${editable && !m.winner ? ' · Saisir le score' : ''}</div></${tag}>${liveBar(m)}`;
}

// Score keeper : bandeau sous un match à jouer (lancer / en direct / résultat proposé à valider).
const liveText = (l) => (l.winner ? l.sets.map((x) => x.join('-')).join(' ') : `${[...l.sets.map((x) => x.join('-')), l.games.join('-')].join(' ')} · ${l.pts.join('-')}`);
const keeperToken = (id) => { try { return localStorage.getItem(`keeperMatch:${id}`); } catch { return null; } };
function liveBar(m) {
  if (m.winner || !m.team1 || !m.team2 || !(m.stage === 'ko' || cur.data.tournament.phase === 'groups')) return '';
  const l = m.live, own = keeperToken(m.id), adm = isAdmin();
  const close = adm ? `<button class="small ghost" data-liveclose="${m.id}">${l?.status === 'submitted' ? 'Rejeter' : '✕ Fermer'}</button>` : '';
  if (l?.status === 'submitted') {
    return `<div class="livebar sub"><span>✅ Résultat envoyé : <strong>${esc(l.sets.map((x) => x.join('-')).join(' '))}</strong>${adm ? '' : ' · en attente de validation'}</span>
      ${adm ? `<button class="small primary" data-livevalid="${m.id}">Valider</button>` : ''}${close}</div>`;
  }
  // Seuls les organisateurs créent le lien ; les joueurs l'ouvrent depuis le lien reçu (et peuvent reprendre sur leur appareil).
  const open = adm || own ? `<button class="small" data-keeper="${m.id}">▶ ${l?.points ? 'Reprendre' : 'Score keeper'}</button>` : '';
  const link = adm ? `<button class="small ghost" data-keeperlink="${m.id}">🔗 Lien</button>` : '';
  if (l?.points) return `<div class="livebar"><span><i class="livedot"></i> En direct · <strong>${esc(liveText(l))}</strong></span>${open}${link}${close}</div>`;
  return adm ? `<div class="livebar">${open}${link}${l ? close : ''}</div>` : '';
}

async function openKeeper(matchId) {
  let tk = null;
  if (isAdmin()) tk = (await api(`/api/matches/${matchId}/live`, 'POST')).token;
  else {
    tk = keeperToken(matchId);
    try { await api(`/api/live/${tk}`); } catch (e) { try { localStorage.removeItem(`keeperMatch:${matchId}`); } catch {} throw e; }
  }
  location.hash = `#/live/${tk}`;
}

// Copie ou partage : doit partir directement d'un tap (iPhone/Safari refusent après un appel réseau), d'où la fenêtre intermédiaire.
async function copyOrShare(url, action, input, done = 'Lien copié') {
  if (action === 'share') { try { await navigator.share({ title: 'Score keeper', url }); } catch {} return; }
  try { await navigator.clipboard.writeText(url); }
  catch {
    input.focus(); input.select(); input.setSelectionRange(0, url.length);
    if (!document.execCommand?.('copy')) throw new Error('Copie impossible : le lien est sélectionné, copiez-le à la main.');
  }
  toast(done);
}

const fmtCode = (c) => `${c.slice(0, 3)}-${c.slice(3)}`;
const codeMessage = (c) => `Code score keeper : ${fmtCode(c)}\nSaisissez-le sur ${location.origin} pour compter les points du match.`;

async function shareKeeperLink(matchId) {
  const { code } = await api(`/api/matches/${matchId}/live`, 'POST');
  openDialog(`<h3>Code du score keeper</h3>
    <p class="muted">Donnez ce code à la paire qui va compter les points : elle le saisit dans « Code score keeper » sur la page d'accueil ou l'onglet Matchs. Il reste valable jusqu'à la saisie du résultat.</p>
    <input id="kurl" class="kcode" readonly value="${esc(fmtCode(code))}" onfocus="this.select()">
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Fermer</button>${navigator.share ? '<button value="share">Partager</button>' : ''}<button value="copy" class="primary">Copier</button></div>`,
  async (f, action) => {
    if (action === 'share') { try { await navigator.share({ title: 'Score keeper', text: codeMessage(code) }); } catch {} return; }
    await copyOrShare(codeMessage(code), 'copy', $('#kurl'), 'Code copié');
  });
  load().catch(() => {});
}

// Champ où un joueur saisit le code reçu d'un organisateur pour ouvrir le score keeper.
const codeEntry = () => `<form class="card codeform" data-codeform>
  <label for="kcode"><strong>Code score keeper</strong></label>
  <div class="muted">Un organisateur vous a donné un code ? Saisissez-le pour compter les points.</div>
  <div class="row" style="margin-top:8px"><input id="kcode" class="kcode" name="code" placeholder="ABC-DEF" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" required><button class="primary">Ouvrir</button></div></form>`;

app.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-codeform]');
  if (!f) return;
  e.preventDefault();
  try {
    const { token: tk } = await api('/api/live-code', 'POST', { code: f.code.value });
    location.hash = `#/live/${tk}`;
  } catch (err) { toast(err.message); }
});

app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-keeper],[data-keeperlink],[data-livevalid],[data-liveclose]');
  if (!b) return;
  try {
    if (b.dataset.keeper) await openKeeper(b.dataset.keeper);
    else if (b.dataset.keeperlink) await shareKeeperLink(b.dataset.keeperlink);
    else if (b.dataset.livevalid) {
      const m = cur.data.matches.find((x) => x.id == b.dataset.livevalid);
      await api(`/api/matches/${m.id}`, 'PUT', { sets: m.live.sets });
      await load(); toast('Résultat validé');
    } else if (b.dataset.liveclose) {
      if (!confirm('Fermer ce score keeper ? Les points comptés seront perdus.')) return;
      await api(`/api/matches/${b.dataset.liveclose}/live`, 'DELETE');
      await load(); toast('Score keeper fermé');
    }
  } catch (err) { toast(err.message); }
});

const icsLinks = (team) => {
  const path = `/api/t/${cur.slug}/calendar.ics${team ? `?team=${team}` : ''}`;
  return `<span class="muted">Agenda : <a href="webcal://${location.host}${path}">s'abonner</a> · <a href="${path}" download>télécharger .ics</a></span>`;
};

function matchesPanel() {
  const entry = isAdmin() ? '' : codeEntry();
  const ms = cur.data.matches.filter((m) => !(m.stage === 'ko' && m.round === 1 && m.winner && (!m.team1 || !m.team2)));
  if (!ms.length) return '<div class="empty">Aucun match pour le moment.</div>';
  const f = cur.filter;
  // Filtres cumulables : statut, paire, journée / tour (clés « g-3 » ou « ko-2 », comme les sections).
  const roundKey = (m) => (m.stage === 'ko' ? `ko-${m.round}` : `g-${m.round}`);
  const fTeam = cur.fTeam || '', fRound = cur.fRound || '';
  const shown = ms.filter((m) => (f === 'all' || (f === 'todo' ? !m.winner : f === 'moved' ? m.moves?.length : f === 'late' ? m.late : !!m.winner))
    && (!fTeam || m.team1 === Number(fTeam) || m.team2 === Number(fTeam)) && (!fRound || roundKey(m) === fRound));
  const rounds = [...new Map(ms.map((m) => [roundKey(m), m])).entries()]
    .sort(([a], [b]) => (a[0] === b[0] ? parseInt(a.slice(a.indexOf('-') + 1)) - parseInt(b.slice(b.indexOf('-') + 1)) : a[0] === 'g' ? -1 : 1))
    .map(([k, m]) => [k, m.stage === 'ko' ? cur.data.roundNames[m.round] : `Journée ${m.round}`]);
  const teamsSorted = [...cur.data.teams].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const selects = `<div class="grid2" style="margin-top:8px">
    <select data-fteam aria-label="Filtrer par paire"><option value="">Toutes les paires</option>${teamsSorted.map((x) => `<option value="${x.id}" ${String(x.id) === String(fTeam) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <select data-fround aria-label="Filtrer par journée"><option value="">Toutes les journées</option>${rounds.map(([k, l]) => `<option value="${k}" ${k === fRound ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const nLate = ms.filter((m) => m.late).length, nFf = ms.filter((m) => m.late === 'forfeit').length;
  const sections = new Map();
  for (const m of shown) {
    const key = m.stage === 'ko' ? `ko-${m.round}` : `g-${m.round}`;
    const title = m.stage === 'ko' ? cur.data.roundNames[m.round] : `Journée ${m.round}`;
    if (!sections.has(key)) sections.set(key, { title, items: [] });
    sections.get(key).items.push(m);
  }
  const ordered = [...sections.entries()].sort(([a], [b]) => (a[0] === b[0] ? parseInt(a.slice(2)) - parseInt(b.slice(2)) : a[0] === 'g' ? -1 : 1));
  const alert = nLate ? `<div class="card"><strong>⚠ ${nLate} match${nLate > 1 ? 's' : ''} en retard</strong>${nFf ? `<div class="muted">${nFf} dont la journée suivante a commencé : défaite 6-0 / 6-0 pour les deux paires.</div>${isAdmin() ? `<button class="danger small" id="applyFf" style="margin-top:8px">Appliquer ${nFf} forfait${nFf > 1 ? 's' : ''}</button>` : ''}` : ''}</div>` : '';
  return `${entry}${alert}${isAdmin() ? `<div class="row" style="margin-top:12px"><button class="primary small" data-share="next">Partager les prochains matchs</button><button class="ghost small" data-share="next-copy" style="color:inherit">Copier</button></div><div style="margin-top:8px">${icsLinks()}</div>` : ''}<div class="row" style="margin-top:8px">${[['all', 'Tous'], ['todo', 'À jouer'], ['done', 'Terminés'], ['moved', 'Reportés'], ...(nLate ? [['late', `En retard (${nLate})`]] : [])].map(([k, l]) =>
    `<button class="${f === k ? 'primary' : 'ghost'} small" data-filter="${k}" style="${f === k ? '' : 'color:inherit'}">${l}</button>`).join('')}</div>${selects}
    ${ordered.map(([, s]) => `<h2>${esc(s.title)}</h2>${s.items.map(matchCard).join('')}`).join('') || '<div class="empty">Aucun match dans cette catégorie.</div>'}`;
}

// Export WhatsApp : texte (wa.me) et image du classement (partage natif, sinon téléchargement)
const shareUrl = () => `${location.origin}/#/t/${cur.slug}`;
function rankText() {
  const { standings, tournament: t } = cur.data;
  const medal = ['🥇', '🥈', '🥉'];
  const blocks = standings.map((g) => (t.groups_count > 1 ? `📌 *Poule ${groupLetter(g.group)}*\n` : '') + g.rows.map((r) =>
    `${medal[r.rank - 1] || (r.rank < 10 ? `${r.rank}️⃣` : `${r.rank}.`)} ${teamName(r.id)} — *${r.points} pts* (${r.played} J, ${signed(r.gamesFor - r.gamesAgainst)})${r.rank <= t.qualifiers ? ' ✅' : ''}`).join('\n'));
  return `🎾 *${t.name}* 🏆\n📊 _Classement_\n\n${blocks.join('\n\n')}\n\n✅ = qualifié pour les play-offs\n🔗 ${shareUrl()}`;
}
function nextText() {
  const { tournament: t, matches } = cur.data;
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Africa/Tunis' });
  const todo = matches.filter((m) => !m.winner && m.team1 && m.team2);
  const dated = todo.filter((m) => m.date && m.date >= today).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 12);
  const late = todo.filter((m) => m.late);
  const fmt = (m) => `🔹 ${[m.time && `🕒 ${m.time}`, m.court && `📍 ${m.court}`].filter(Boolean).join(' · ')}${m.time || m.court ? '\n    ' : ''}*${teamName(m.team1)}* 🆚 *${teamName(m.team2)}*`;
  const days = [...new Set(dated.map((m) => m.date))].map((d) => `📅 *${fmtDate(d)}*\n${dated.filter((m) => m.date === d).map(fmt).join('\n')}`);
  const lateTxt = late.length ? `🚨 *En retard*\n${late.map((m) => `🔸 ${teamName(m.team1)} 🆚 ${teamName(m.team2)}${m.date ? ` _(prévu ${fmtDate(m.date)})_` : ''}`).join('\n')}` : '';
  const body = [...days, lateTxt].filter(Boolean).join('\n\n') || 'Aucun match daté à venir.';
  return `🎾 *${t.name}* 🏆\n📆 _Prochains matchs_\n\n${body}\n\n🔗 ${shareUrl()}`;
}
function rankImage() {
  const { standings, tournament: t } = cur.data;
  const W = 1080, rowH = 68, pad = 40;
  const rows = standings.reduce((n, g) => n + g.rows.length + (t.groups_count > 1 ? 1 : 0), 0);
  const H = 190 + 70 + rows * rowH + 90;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); const font = 'system-ui, "Segoe UI", Roboto, sans-serif';
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#0f6b3a'; x.fillRect(0, 0, W, 150);
  x.fillStyle = '#fff'; x.font = `700 46px ${font}`; x.fillText(t.name.slice(0, 34), pad, 72);
  x.font = `400 28px ${font}`; x.fillText(`Classement · ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Africa/Tunis' })}`, pad, 116);
  let y = 190;
  const cols = [[W - pad - 300, 'J'], [W - pad - 220, 'V'], [W - pad - 130, 'Diff'], [W - pad, 'Pts']];
  x.fillStyle = '#6b7280'; x.font = `600 24px ${font}`; x.textAlign = 'left'; x.fillText('#  Équipe', pad, y + 30);
  x.textAlign = 'right'; cols.forEach(([cx, l]) => x.fillText(l, cx, y + 30)); y += 50;
  for (const g of standings) {
    if (t.groups_count > 1) { x.textAlign = 'left'; x.fillStyle = '#0f6b3a'; x.font = `700 28px ${font}`; x.fillText(`Poule ${groupLetter(g.group)}`, pad, y + 40); y += rowH; }
    for (const r of g.rows) {
      if (r.rank <= t.qualifiers) { x.fillStyle = '#e8f5ec'; x.fillRect(0, y, W, rowH); x.fillStyle = '#0f6b3a'; x.fillRect(0, y, 10, rowH); }
      x.fillStyle = '#111827'; x.textAlign = 'left'; x.font = `600 30px ${font}`; x.fillText(String(r.rank), pad, y + 44);
      let name = teamName(r.id); x.font = `500 30px ${font}`;
      while (x.measureText(name).width > 500 && name.length > 3) name = name.slice(0, -2) + '…';
      x.fillText(name, pad + 60, y + 44);
      x.textAlign = 'right'; x.font = `400 30px ${font}`;
      x.fillText(r.played, cols[0][0], y + 44); x.fillText(r.won, cols[1][0], y + 44); x.fillText(String(signed(r.gamesFor - r.gamesAgainst)), cols[2][0], y + 44);
      x.font = `700 32px ${font}`; x.fillText(r.points, cols[3][0], y + 44);
      x.fillStyle = '#e5e7eb'; x.fillRect(0, y + rowH - 1, W, 1); y += rowH;
    }
  }
  x.textAlign = 'left'; x.fillStyle = '#6b7280'; x.font = `400 24px ${font}`;
  x.fillText('Zone verte : qualifiés pour les play-offs', pad, y + 44); x.fillText(shareUrl().replace(/^https?:\/\//, ''), pad, y + 78);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
async function shareExport(kind) {
  const { standings } = cur.data;
  try {
    if (kind === 'img') {
      if (!standings.length) throw new Error('Pas encore de classement');
      const file = new File([await rankImage()], `classement-${cur.slug}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('Image téléchargée : joignez-la dans WhatsApp');
      return;
    }
    const isRank = kind.startsWith('rank');
    if (isRank && !standings.length) throw new Error('Pas encore de classement');
    const text = isRank ? rankText() : nextText();
    if (kind.endsWith('copy')) { await navigator.clipboard.writeText(text); toast('Texte copié : collez-le dans WhatsApp'); return; }
    // Partage natif (téléphone) : conserve les emojis ; sinon lien WhatsApp
    if (navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ text }); return; }
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}

// Tableau
function bracketPanel() {
  const ko = cur.data.matches.filter((m) => m.stage === 'ko');
  if (!ko.length) return '<div class="empty">Les play-offs seront disponibles à la fin du championnat.</div>';
  const cols = Array.from({ length: cur.data.koRounds }, (_, i) => i + 1);
  const final = ko.find((m) => m.round === cur.data.koRounds && m.pos === 0);
  return `${final?.winner ? `<div class="card" style="text-align:center;background:var(--accent);color:var(--accent-ink)">🏆 <strong>${esc(teamName(final.winner))}</strong></div>` : ''}
    <div class="bracket">${cols.map((r) => `<div class="col"><h3>${esc(cur.data.roundNames[r])}</h3>${ko.filter((m) => m.round === r).sort((a, b) => a.pos - b.pos).map(matchCard).join('')}</div>`).join('')}</div>`;
}

function renderTeamPage() {
  const d = cur.data, t = d.tournament;
  const team = d.teams.find((x) => x.id === cur.team);
  if (!team) { app.innerHTML = `<div class="empty">Paire introuvable.<p><a href="#/t/${esc(cur.slug)}">Retour au tournoi</a></p></div>`; return; }
  document.title = `${team.name} · ${t.name}`;
  const row = d.standings.flatMap((g) => g.rows).find((r) => r.id === team.id);
  const mine = d.matches.filter((m) => m.team1 === team.id || m.team2 === team.id);
  const played = mine.filter((m) => m.winner).sort((a, b) => (b.stage === a.stage ? b.round - a.round : a.stage === 'ko' ? -1 : 1));
  const upcoming = mine.filter((m) => !m.winner && (m.team1 && m.team2)).sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || a.round - b.round);
  const form = [...played].reverse().slice(-5).map((m) => (m.winner === team.id ? 'V' : 'D'));
  const section = (title, list) => list.length ? `<h2>${title}</h2>${list.map(matchCard).join('')}` : '';
  const ko = mine.filter((m) => m.stage === 'ko');
  app.innerHTML = `
    <div class="hero tall"><a href="#/t/${esc(cur.slug)}" class="back">← ${esc(t.name)}</a></div>
    <div class="card overlap pairhead">
      <div class="faces">${avatar(team, 1, 92)}${avatar(team, 2, 92)}</div>
      <h1>${esc(team.name)}</h1>
      ${playersLine(team) ? `<div class="muted">${esc(playersLine(team))}</div>` : ''}
      <div class="row" style="margin-top:10px;justify-content:center">
        ${row ? `<span class="badge ${row.rank <= t.qualifiers ? 'live' : ''}">${row.rank}${row.rank === 1 ? 'er' : 'e'} du classement${row.rank <= t.qualifiers ? ' · zone de qualification' : ''}</span>` : ''}
        ${team.penalty ? `<span class="badge" style="background:var(--danger);color:#fff">Pénalité −${team.penalty} pt${team.penalty > 1 ? 's' : ''}</span>` : ''}
        ${team.reports ? `<span class="badge">${team.reports} report${team.reports > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="row" style="margin-top:14px;justify-content:center">
        <button class="ghost small" id="notif" style="color:inherit" data-off="🔔 Suivre cette paire" data-on="🔔 Notifications ✓">🔔 Suivre cette paire</button>
        <button class="ghost small" id="share" style="color:inherit">Copier le lien</button>
      </div>
      <div style="margin-top:10px">${icsLinks(team.id)}</div>
    </div>
    ${row ? `<div class="stats4">${[[row.points, 'Points'], [row.played, 'Joués'], [`${row.won}-${row.lost}`, 'V-D'], [signed(row.gamesFor - row.gamesAgainst), 'Diff. jeux']].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      <div class="card row between"><div><strong>Forme</strong><div class="muted">Sets ${row.setsFor}-${row.setsAgainst} · Jeux ${row.gamesFor}-${row.gamesAgainst}</div></div>
        <div class="row" style="gap:6px">${form.map((f) => `<span class="dot ${f === 'V' ? 'v' : 'd'}" aria-label="${f === 'V' ? 'Victoire' : 'Défaite'}">${f}</span>`).join('')}</div></div>` : ''}
    ${(() => { const f = isAdmin() && cur.fc?.teams?.find((x) => x.id === team.id); if (!f) return ''; const ko = t.phase === 'knockout' || t.phase === 'finished'; return `<h2>Ses chances</h2><div class="stats4" style="grid-template-columns:repeat(3,minmax(0,1fr))">${[...(ko ? [['final', 'Finale']] : [['qualify', 'Qualification']]), ['podium', 'Podium'], ['champion', 'Victoire']].map(([k, l]) => `<div><b>${pct(f[k])}</b><span>${l}</span></div>`).join('')}</div>`; })()}
    ${team.changes?.length ? `<h2>Changements de partenaire</h2>${team.changes.map((c) => `<div class="card muted">J${c.round || '—'} · ${esc([c.old_p1, c.old_p2].filter(Boolean).join(' & '))} → <strong>${esc([c.new_p1, c.new_p2].filter(Boolean).join(' & '))}</strong>${c.penalty ? ` · −${c.penalty} pts` : ' · sans pénalité'}${c.reason ? ` · ${esc(c.reason)}` : ''}</div>`).join('')}` : ''}
    ${isAdmin() && t.phase === 'groups' ? '<div class="row" style="margin-top:12px"><button class="small" id="partner">Changer de partenaire</button></div>' : ''}
    ${section('Phase finale', ko)}
    ${section('Prochains matchs', upcoming.filter((m) => m.stage === 'group'))}
    ${section('Résultats', played.filter((m) => m.stage === 'group'))}
    ${!mine.length ? '<div class="empty">Aucun match pour le moment.</div>' : ''}
    ${navHtml('groups')}`;
  $('#share').onclick = async () => {
    const url = `${location.origin}/#/t/${cur.slug}/team/${team.id}`;
    try { await navigator.clipboard.writeText(url); toast('Lien copié'); } catch { prompt('Lien de la paire', url); }
  };
  $('#notif').onclick = () => pushDialog(team.id);
  updateNotifButton();
  $('#partner')?.addEventListener('click', () => partnerDialog(team));
  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { cur.tab = b.dataset.tab; location.hash = `#/t/${cur.slug}`; }));
  bindPanel();
}

const dt = (n) => `${Number(n.toFixed(3))} DT`;
function payPanel() {
  const p = cur.pay;
  if (!p) return '<div class="empty">Paiements indisponibles.</div>';
  const { totals: tt } = p;
  const pct = tt.due ? Math.min(100, Math.round((tt.paid / tt.due) * 100)) : 0;
  const status = (x) => (x.paid >= x.due ? ['Payé', 'var(--ok)'] : x.paid > 0 ? ['Partiel', '#d98e04'] : ['Impayé', 'var(--danger)']);
  return `<div class="card">
      <div class="row between"><strong>${dt(tt.paid)} encaissés sur ${dt(tt.due)}</strong><span class="muted">${tt.complete}/${tt.players} joueurs à jour</span></div>
      <div style="height:10px;border-radius:99px;background:var(--line);margin:10px 0;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>
      <div class="row between"><span class="muted">Reste à encaisser : <strong>${dt(tt.remaining)}</strong> · ${dt(p.fee)} par joueur</span><button class="ghost small" id="csv" style="color:inherit">Exporter CSV</button></div>
    </div>
    ${p.teams.map((x) => `<div class="card"><strong>${esc(x.name)}</strong>
      ${x.players.map((pl) => { const [label, color] = status(pl); return `<div class="row between" style="padding:8px 0;border-top:1px solid var(--line);margin-top:8px">
        <div class="grow"><div>${esc(pl.name)}</div><div class="muted">${dt(pl.paid)} / ${dt(pl.due)}</div></div>
        <span class="badge" style="background:${color};color:#fff">${label}</span>
        <button class="small" data-pay="${x.id}:${pl.n}">${pl.paid >= pl.due ? 'Détail' : 'Encaisser'}</button></div>`; }).join('')}</div>`).join('') || '<div class="empty">Aucune équipe.</div>'}`;
}

// Statistiques de la saison (calculées côté navigateur ; les forfaits comptent pour les séries mais pas pour les jeux/sets)
function computeStats() {
  const { teams, matches } = cur.data;
  const by = new Map(teams.map((t) => [t.id, { id: t.id, played: 0, won: 0, sets: 0, setsLost: 0, gf: 0, ga: 0, comebacks: 0, form: [], best: 0, run: 0 }]));
  const records = [];
  const order = [...matches].filter((m) => m.winner && m.team1 && m.team2).sort((a, b) => (a.stage === b.stage ? a.round - b.round || a.pos - b.pos : a.stage === 'group' ? -1 : 1));
  for (const m of order) {
    const real = m.sets && !m.forfeit;
    for (const [id, i] of [[m.team1, 0], [m.team2, 1]]) {
      const x = by.get(id); if (!x) continue;
      const win = m.winner === id;
      x.form.push(win);
      x.run = win ? x.run + 1 : 0; x.best = Math.max(x.best, x.run);
      if (!real) continue;
      x.played++; if (win) x.won++;
      x.sets += m.sets.filter((s) => s[i] > s[1 - i]).length; x.setsLost += m.sets.filter((s) => s[i] < s[1 - i]).length;
      x.gf += m.sets.reduce((n, s) => n + s[i], 0); x.ga += m.sets.reduce((n, s) => n + s[1 - i], 0);
      if (win && m.sets[0][i] < m.sets[0][1 - i]) x.comebacks++;
    }
    if (real) {
      const g1 = m.sets.reduce((n, s) => n + s[0], 0), g2 = m.sets.reduce((n, s) => n + s[1], 0);
      records.push({ m, total: g1 + g2, gap: Math.abs(g1 - g2), sets: m.sets.length });
    }
  }
  return { teams: [...by.values()], records, done: order.length };
}

// Live : une carte par partie en cours, score recalculé par le serveur à partir des points du score keeper.
function livePanel() {
  const ms = liveMatches().sort((a, b) => b.live.updated_at - a.live.updated_at);
  if (!ms.length) return '<div class="empty">Aucune partie en direct pour le moment.<p class="muted">Les parties comptées avec le score keeper apparaissent ici.</p></div>';
  const { tournament: t } = cur.data;
  const row = (m, i) => {
    const l = m.live, id = i ? m.team2 : m.team1;
    return `<div class="lrow"><span class="ln">${teamLink(id)}</span>${l.sets.map((x) => `<span class="ls ${x[i] > x[1 - i] ? 'w' : ''}">${x[i]}</span>`).join('')}<span class="ls cur">${l.games[i]}</span><span class="lp">${esc(l.pts[i])}</span></div>`;
  };
  const label = (m) => (m.stage === 'group' ? (t.groups_count > 1 ? `Poule ${groupLetter(m.grp)} · J${m.round}` : `Journée ${m.round}`) : m.pos === 1 && m.round === cur.data.koRounds ? cur.data.thirdName : cur.data.roundNames[m.round]);
  return `<p class="muted" style="margin:4px 2px 10px">${ms.length} partie${ms.length > 1 ? 's' : ''} en direct · mise à jour automatique</p>`
    + ms.map((m) => `<div class="card livecard"><div class="row between"><span class="muted"><i class="livedot"></i> En direct · ${esc([label(m), m.court].filter(Boolean).join(' · '))}</span>${m.live.tb ? '<span class="badge">Tie-break</span>' : ''}</div>${row(m, 0)}${row(m, 1)}</div>`).join('');
}

function statsPanel() {
  const d = cur.data;
  if (d.tournament.phase === 'setup') return '<div class="empty">Les statistiques apparaîtront dès les premiers matchs.</div>';
  const { teams, records, done } = computeStats();
  if (!done) return '<div class="empty">Aucun match joué pour le moment.</div>';
  const all = d.matches.filter((m) => m.team1 && m.team2);
  const forfeits = d.matches.filter((m) => m.forfeit).length;
  const totalGames = records.reduce((n, r) => n + r.total, 0);
  const threeSets = records.filter((r) => r.sets === 3).length;
  const kpi = (v, l) => `<div class="card" style="text-align:center;margin:0"><div style="font-size:1.4rem;font-weight:700">${v}</div><div class="muted">${l}</div></div>`;
  const list = (title, sub, rows) => rows.length ? `<div class="card"><h3 style="margin:0">${title}</h3>${sub ? `<div class="muted" style="margin-bottom:6px">${sub}</div>` : ''}${rows.map(([id, val], i) =>
    `<div class="row between" style="padding:5px 0;border-top:1px solid var(--line)"><span>${i + 1}. ${teamLink(id)}</span><strong>${val}</strong></div>`).join('')}</div>` : '';
  const top = (arr, f, fmt, n = 5) => arr.map((t) => [t, f(t)]).filter(([, v]) => v !== null).sort((a, b) => b[1] - a[1] || teamName(a[0].id).localeCompare(teamName(b[0].id))).slice(0, n).map(([t, v]) => [t.id, fmt(v, t)]);
  const played = teams.filter((t) => t.played);
  const avg = (v) => (Math.round(v * 10) / 10).toString().replace('.', ',');
  const cur_ = (t) => { let n = 0; for (let i = t.form.length - 1; i >= 0 && t.form[i]; i--) n++; return n; };
  const matchLine = (r) => { const m = r.m; return `${teamLink(m.team1)} <strong>${m.sets.map((s) => s.join('-')).join(' ')}</strong> ${teamLink(m.team2)}`; };
  const rec = (title, r, sub) => r ? `<div class="card"><h3 style="margin:0">${title}</h3><div class="muted">${sub}</div><div style="margin-top:4px">${matchLine(r)}</div></div>` : '';
  const widest = [...records].sort((a, b) => b.gap - a.gap)[0];
  const longest = [...records].sort((a, b) => b.total - a.total)[0];
  const tight = [...records].filter((r) => r.sets === 3).sort((a, b) => a.gap - b.gap)[0];
  return `
    <div class="grid2" style="margin-top:12px">${kpi(`${done}/${all.length}`, 'matchs joués')}${kpi(totalGames, 'jeux disputés')}${kpi(avg(totalGames / (records.length || 1)), 'jeux par match')}${kpi(`${records.length ? Math.round(100 * threeSets / records.length) : 0} %`, 'matchs en 3 sets')}</div>
    ${list('Meilleure attaque', 'Jeux marqués par match', top(played, (t) => t.gf / t.played, (v) => avg(v)))}
    ${list('Meilleure défense', 'Jeux encaissés par match (moins = mieux)', top(played, (t) => -t.ga / t.played, (v) => avg(-v)))}
    ${list('Sets gagnés', '', top(played, (t) => t.sets, (v, t) => `${v} <span class="muted">(${t.setsLost} perdus)</span>`))}
    ${list('Série de victoires en cours', 'Victoires consécutives jusqu\'ici', top(teams, (t) => (cur_(t) >= 2 ? cur_(t) : null), (v) => v))}
    ${list('Plus longue série', 'Record de victoires d\'affilée', top(teams, (t) => (t.best >= 2 ? t.best : null), (v) => v))}
    ${list('Remontées', 'Matchs gagnés après avoir perdu le 1er set', top(teams, (t) => (t.comebacks ? t.comebacks : null), (v) => v))}
    ${rec('Plus large victoire', widest, `${widest ? widest.gap : 0} jeux d'écart`)}
    ${rec('Match le plus accroché', tight, tight ? `3 sets, ${tight.gap} jeu${tight.gap > 1 ? 'x' : ''} d'écart` : '')}
    ${rec('Match le plus long', longest, `${longest ? longest.total : 0} jeux au total`)}
    <p class="muted">Calculé à partir des scores saisis${forfeits ? ` ; les ${forfeits} forfait${forfeits > 1 ? 's' : ''} sont exclus des jeux et des sets mais comptent dans les séries` : ''}.</p>`;
}

// Historique des modifications (organisateurs)
// Tableau de bord (organisateurs) : ce qui demande une action, sur une seule page.
const todayTn = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Tunis' });
function dashPanel() {
  const { tournament: t, matches, teams } = cur.data;
  const today = todayTn();
  const dayDiff = (d) => Math.round((new Date(`${today}T12:00:00Z`) - new Date(`${d}T12:00:00Z`)) / 864e5);
  const vs = (m) => `${teamLink(m.team1)} – ${teamLink(m.team2)}`;
  const ready = matches.filter((m) => m.team1 && m.team2);
  const done = ready.filter((m) => m.winner).length;
  const pct = ready.length ? Math.round((done / ready.length) * 100) : 0;
  const group = matches.filter((m) => m.stage === 'group');
  const round = group.reduce((r, m) => (m.winner || (m.date && m.date <= today) ? Math.max(r, m.round) : r), 0);
  const nextDate = ready.filter((m) => !m.winner && m.date && m.date >= today).map((m) => m.date).sort()[0];

  const proposed = ready.filter((m) => !m.winner && m.live?.status === 'submitted');
  const ff = group.filter((m) => m.late === 'forfeit');
  const late = group.filter((m) => m.late === 'late');
  const noDate = t.phase === 'groups' ? group.filter((m) => !m.winner && !m.date && m.round <= round + 1) : [];
  const todayMs = ready.filter((m) => !m.winner && m.date === today).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const owing = (cur.pay?.teams || []).map((x) => ({ name: x.name, id: x.id, rest: x.players.reduce((n, p) => n + Math.max(0, p.due - p.paid), 0) })).filter((x) => x.rest > 0).sort((a, b) => b.rest - a.rest);
  const f = cur.followers;
  const unfollowed = f ? teams.filter((x) => !f.perTeam[x.id]) : [];

  const more = (n, shown) => (n > shown ? `<div class="muted">… et ${n - shown} autre${n - shown > 1 ? 's' : ''}</div>` : '');
  const card = (title, items, { tone, goto, gotoLabel, lines }) => `<div class="card">
    <div class="row between"><strong>${title}</strong><span class="badge" style="${tone ? `background:${tone};color:#fff` : ''}">${items.length}</span></div>
    <div style="margin-top:6px">${items.slice(0, 8).map(lines).map((l) => `<div style="padding:3px 0;border-top:1px solid var(--line)">${l}</div>`).join('')}${more(items.length, 8)}</div>
    ${goto ? `<button class="ghost small" data-goto="${goto}" style="color:inherit;margin-top:8px">${gotoLabel}</button>` : ''}</div>`;

  const sections = [
    ff.length && card('⚠ Forfaits à appliquer', ff, { tone: 'var(--danger)', goto: 'matches:late', gotoLabel: 'Voir et appliquer', lines: (m) => `${vs(m)} <span class="muted">· prévu ${fmtDate(m.date)}, journée suivante commencée</span>` }),
    late.length && card('⏰ Matchs en retard', late, { tone: '#d98e04', goto: 'matches:late', gotoLabel: 'Voir les matchs en retard', lines: (m) => `${vs(m)} <span class="muted">· depuis ${dayDiff(m.date)} j${m.deadline ? `, limite ${fmtDate(m.deadline)}` : ''}</span>` }),
    proposed.length && card('📲 Scores à valider', proposed, { tone: 'var(--ok)', goto: 'matches:all', gotoLabel: 'Ouvrir les matchs', lines: (m) => `${vs(m)} <span class="muted">· ${esc(m.live.sets.map((x) => x.join('-')).join(' '))}</span> <button class="small primary" data-livevalid="${m.id}">Valider</button>` }),
    noDate.length && card('📅 Matchs à planifier (journée en cours et suivante)', noDate, { goto: 'matches:todo', gotoLabel: 'Voir les matchs à jouer', lines: (m) => `${vs(m)} <span class="muted">· J${m.round}</span>` }),
    owing.length && card('💰 Paiements en attente', owing, { goto: 'pay', gotoLabel: 'Ouvrir les paiements', lines: (x) => `<a class="tlink" href="#/t/${esc(cur.slug)}/team/${x.id}">${esc(x.name)}</a> <span class="muted">· reste ${dt(x.rest)}</span>` }),
    f && unfollowed.length && card('🔕 Paires sans abonné dédié', unfollowed, { lines: (x) => teamLink(x.id) }),
  ].filter(Boolean);

  return `<div class="card">
      <div class="row between"><strong>${done}/${ready.length} matchs joués</strong><span class="muted">${PHASES[t.phase]}${round ? ` · journée ${round}` : ''}</span></div>
      <div style="height:10px;border-radius:99px;background:var(--line);margin:10px 0;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>
      <div class="muted">${nextDate ? `Prochain match : ${fmtDate(nextDate)}.` : 'Aucun match daté à venir.'}${cur.pay ? ` Encaissé : ${dt(cur.pay.totals.paid)} sur ${dt(cur.pay.totals.due)}.` : ''}${f ? ` Notifications : ${f.devices} appareil${f.devices > 1 ? 's' : ''} (${f.wide} sur tout le tournoi).` : ''}</div>
    </div>
    ${todayMs.length ? card('🎾 Matchs d\'aujourd\'hui', todayMs, { lines: (m) => `${vs(m)} <span class="muted">· ${[m.time, m.court].filter(Boolean).join(' · ') || 'horaire à confirmer'}</span>` }) : ''}
    ${sections.length ? `<h2>À traiter</h2>${sections.join('')}` : '<div class="card" style="text-align:center">✅ Rien à traiter pour le moment.</div>'}
    ${cur.log?.length ? `<h2>Dernières modifications</h2>${cur.log.slice(0, 5).map((e) => `<div class="card" style="margin:6px 0;padding:10px 12px"><div class="muted">${esc(e.username)}</div><div>${esc(e.detail)}</div></div>`).join('')}<button class="ghost small" data-goto="log" style="color:inherit">Tout l'historique</button>` : ''}`;
}
// Gestion du tournoi (organisateurs) : réglages, messages à tous, édition suivante.
function managePanel() {
  const { tournament: t } = cur.data;
  const n = cur.followers?.devices;
  const item = (title, text, action) => `<div class="card"><strong>${title}</strong><p class="muted" style="margin:4px 0 12px">${text}</p>${action}</div>`;
  const next = t.next
    ? `<a class="tlink" href="#/t/${esc(t.next.slug)}"><strong>Ouvrir « ${esc(t.next.name)} » →</strong></a>`
    : t.phase === 'setup' ? '<span class="muted">Disponible une fois le tournoi lancé.</span>' : '<button id="nextEd">Créer l\'édition suivante</button>';
  return `
    ${item('⚙ Réglages du tournoi', 'Nom, date, lieu, poules, qualifiés, points, frais d\'inscription et règlement.', '<button id="settings">Modifier les réglages</button>')}
    ${item('📣 Notifier tout le monde', `Envoyer un message prédéfini à tous les abonnés du tournoi${n === undefined ? '' : ` (${n} appareil${n > 1 ? 's' : ''} aujourd'hui)`}. Les messages se configurent dans la fenêtre d'envoi.`, '<button id="broadcast">Choisir un message</button>')}
    ${item('➡ Édition suivante', 'Crée un nouveau tournoi avec les mêmes réglages et les paires que vous choisissez. Les photos sont reprises.', next)}`;
}
// Prévisions : chances de chaque paire, calculées côté serveur par simulation (lib/forecast.js).
async function loadForecast() {
  const slug = cur.slug;
  try { const fc = await api(`/api/t/${slug}/forecast`); if (cur && cur.slug === slug) { cur.fc = fc; cur.fcErr = null; } }
  catch (e) { if (cur && cur.slug === slug) cur.fcErr = e.message; }
}
const pct = (v) => (v <= 0 ? '0%' : v >= 1 ? '100%' : v < 0.005 ? '<1%' : v > 0.995 ? '>99%' : `${Math.round(v * 100)}%`);
function chancesPanel() {
  const fc = cur.fc, { tournament: t } = cur.data;
  if (!fc) return cur.fcErr ? `<div class="empty">Prévisions indisponibles : ${esc(cur.fcErr)}</div>` : '<div class="empty">Chargement des prévisions…</div>';
  if (fc.status === 'setup') return '<div class="empty">Les prévisions apparaîtront une fois le championnat lancé et les premiers résultats saisis.</div>';
  const ko = t.phase === 'knockout' || t.phase === 'finished';
  const metrics = [['champion', 'Victoire finale'], ['podium', 'Podium'], ['final', 'Finale'], ...(ko ? [] : [['qualify', 'Qualification'], ['first', '1er de poule']])];
  const m = metrics.some(([k]) => k === cur.fcMetric) ? cur.fcMetric : 'champion';
  const rows = [...fc.teams].sort((a, b) => b[m] - a[m] || b.champion - a.champion || a.avgRank - b.avgRank);
  const low = !ko && fc.groupsTotal && fc.groupsPlayed / fc.groupsTotal < 0.25;
  const others = (x) => metrics.filter(([k]) => k !== m).map(([k, l]) => `${l} ${pct(x[k])}`).join(' · ');
  return `
    ${t.phase === 'finished' ? '<div class="card" style="text-align:center">🏆 Tournoi terminé : résultats définitifs.</div>' : `<div class="card"><strong>Qui va gagner ?</strong>
      <p class="muted" style="margin:4px 0 0">Estimation par simulation de ${fc.sims.toLocaleString('fr-FR')} tournois, à partir des sets déjà joués et des matchs restants. Les chances bougent après chaque résultat.</p></div>`}
    ${low ? `<div class="card" style="background:var(--tint)"><strong>Estimation peu fiable</strong><div class="muted">Seulement ${fc.groupsPlayed} match${fc.groupsPlayed > 1 ? 's' : ''} joué${fc.groupsPlayed > 1 ? 's' : ''} sur ${fc.groupsTotal} : les chances évolueront beaucoup.</div></div>` : ''}
    <div class="chips">${metrics.map(([k, l]) => `<button data-fcm="${k}" aria-selected="${m === k}">${l}</button>`).join('')}</div>
    ${rows.map((x, i) => `<div class="card" style="margin:8px 0">
      <div class="row between" style="flex-wrap:nowrap"><div class="row" style="flex-wrap:nowrap;min-width:0"><span class="muted" style="width:1.4em">${i + 1}</span>${avatars(x.id, 30)}<strong style="min-width:0">${teamLink(x.id)}</strong></div>
        <span class="pct">${pct(x[m])}</span></div>
      <div class="bar" role="img" aria-label="${pct(x[m])}"><i style="width:${Math.max(x[m] * 100, x[m] > 0 ? 2 : 0)}%"></i></div>
      <div class="muted" style="font-size:.8rem">${others(x)}</div></div>`).join('')}
    <p class="muted">Méthode : le niveau de chaque paire est estimé sur ses sets gagnés et perdus (les forfaits sont ignorés), prudemment tant qu'il y a peu de matchs. Les matchs restants sont tirés au sort selon ces niveaux, puis le classement et le tableau final suivent les vraies règles du tournoi. C'est une estimation, pas une certitude.</p>`;
}
function logPanel() {
  if (!cur.log) return '<div class="empty">Chargement…</div>';
  if (!cur.log.length) return '<div class="empty">Aucune modification enregistrée pour le moment.</div>';
  const fmt = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Tunis' });
  return `<p class="muted">Les modifications faites depuis la mise en place de l'historique. Visible des organisateurs uniquement.</p>` +
    cur.log.map((e) => `<div class="card" style="margin:6px 0;padding:10px 12px"><div class="muted">${esc(fmt(e.created_at))} · <strong>${esc(e.username)}</strong></div><div>${esc(e.detail)}</div></div>`).join('');
}

function payDialog(teamId, n) {
  const x = cur.pay.teams.find((t) => t.id === teamId);
  const pl = x.players.find((q) => q.n === n);
  const rest = Math.max(0, pl.due - pl.paid);
  const labels = { especes: 'Espèces', virement: 'Virement', autre: 'Autre' };
  openDialog(`<h3>${esc(pl.name)}</h3>
    <p class="muted">${esc(x.name)} · payé ${dt(pl.paid)} sur ${dt(pl.due)}</p>
    <div class="grid2"><div><label>Montant (DT)</label><input name="amount" type="number" inputmode="decimal" step="0.001" min="0.001" value="${rest || ''}"></div>
    <div><label>Date</label><input name="paid_on" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></div>
    <div class="grid2"><div><label>Mode</label><select name="method">${Object.entries(labels).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div><label>Note</label><input name="note" maxlength="200"></div></div>
    ${pl.payments.length ? `<h3 style="margin-top:16px">Paiements enregistrés</h3>${pl.payments.map((p) => `<div class="row between" style="padding:4px 0">
      <span>${dt(p.amount)} <span class="muted">· ${esc(fmtDate(p.paid_on))}${p.method ? ` · ${labels[p.method]}` : ''}${p.note ? ` · ${esc(p.note)}` : ''} · ${esc(p.username || '')}</span></span>
      <button type="button" class="danger small" data-delpay="${p.id}">✕</button></div>`).join('')}` : ''}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Fermer</button><button value="save" class="primary">Enregistrer le paiement</button></div>`,
    async (f) => {
      if (!(Number(f.amount) > 0)) throw new Error('Saisissez un montant');
      await api(`/api/teams/${teamId}/payments`, 'POST', { ...f, player: n });
      await load(); toast('Paiement enregistré');
    });
  dlg.querySelectorAll('[data-delpay]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Supprimer ce paiement ?')) return;
    try { await api(`/api/payments/${b.dataset.delpay}`, 'DELETE'); dlg.close(); await load(); toast('Paiement supprimé'); } catch (e) { $('#derr').textContent = e.message; }
  }));
}

function infoPanel() {
  const d = cur.data.tournament.description;
  return d ? `<div class="card" style="white-space:pre-wrap">${esc(d)}</div>` : '<div class="empty">Aucune description.</div>';
}

// --- Interactions des panneaux -----------------------------------------------------
function bindPanel() {
  const { tournament: t } = cur.data;
  const p = $('#panel') || app;
  p.querySelectorAll('[data-fcm]').forEach((b) => (b.onclick = () => { cur.fcMetric = b.dataset.fcm; renderTournament(); }));
  p.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => { const [tab, filter] = b.dataset.goto.split(':'); cur.tab = tab; if (filter) cur.filter = filter; renderTournament(); }));
  p.querySelectorAll('[data-fteam]').forEach((el) => (el.onchange = () => { cur.fTeam = el.value; renderTournament(); }));
  p.querySelectorAll('[data-fround]').forEach((el) => (el.onchange = () => { cur.fRound = el.value; renderTournament(); }));
  p.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { cur.filter = b.dataset.filter; renderTournament(); }));
  p.querySelectorAll('[data-share]').forEach((b) => (b.onclick = () => shareExport(b.dataset.share)));
  const ff = p.querySelector('#applyFf');
  if (ff) ff.onclick = async () => {
    if (!confirm('Appliquer le double forfait (défaite 6-0 / 6-0 pour les deux paires) à tous ces matchs ?')) return;
    try { const r = await api(`/api/tournaments/${cur.data.tournament.id}/apply-forfeits`, 'POST'); await load(); toast(`${r.count} forfait(s) appliqué(s)`); } catch (e) { toast(e.message); }
  };
  p.querySelectorAll('[data-match]').forEach((b) => (b.onclick = () => scoreDialog(cur.data.matches.find((m) => m.id == b.dataset.match))));
  p.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => confirm('Supprimer cette équipe ?') && act(() => api(`/api/teams/${b.dataset.del}`, 'DELETE'))));
  p.querySelectorAll('[data-grp]').forEach((s) => (s.onchange = () => act(() => api(`/api/teams/${s.dataset.grp}`, 'PUT', { grp: s.value === '' ? null : Number(s.value) }))));
  $('#addTeam')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    act(() => api(`/api/tournaments/${t.id}/teams`, 'POST', f));
  });
  p.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => teamDialog(cur.data.teams.find((x) => x.id == b.dataset.edit))));
  $('#schedule')?.addEventListener('click', scheduleDialog);
  p.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => { const [t, n] = b.dataset.pay.split(':').map(Number); payDialog(t, n); }));
  $('#csv')?.addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/tournaments/${t.id}/payments.csv`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export impossible');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `paiements-${t.slug}.csv` });
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast(e.message); }
  });
  $('#draw')?.addEventListener('click', () => act(() => api(`/api/tournaments/${t.id}/draw`, 'POST'), 'Tirage effectué'));
  $('#start')?.addEventListener('click', () => confirm('Lancer les poules ? Les équipes et les poules seront figées.') &&
    act(async () => { await api(`/api/tournaments/${t.id}/start`, 'POST'); cur.tab = 'matches'; }, 'Poules lancées'));
  $('#ko')?.addEventListener('click', () => confirm('Générer les play-offs ? Les résultats du championnat seront figés.') &&
    act(async () => { await api(`/api/tournaments/${t.id}/knockout`, 'POST'); cur.tab = 'bracket'; }, 'Tableau généré'));
}

function teamDialog(x) {
  openDialog(`<h3>Modifier l'équipe</h3>
    <label>Nom de la paire (facultatif : vide = les deux joueurs)</label><input name="name" maxlength="80" value="${x.name === [x.p1, x.p2].filter(Boolean).join(' & ') ? '' : esc(x.name)}" placeholder="${esc([x.p1, x.p2].filter(Boolean).join(' & '))}">
    <div class="grid2"><div><label>Joueur 1</label><input name="p1" maxlength="40" value="${esc(x.p1)}"></div><div><label>Joueur 2</label><input name="p2" maxlength="40" value="${esc(x.p2)}"></div></div>
    <label>Photos des joueurs</label><div id="photos" class="row" style="gap:18px;align-items:flex-start">${photoControls(x)}</div>
    <label>Pénalité de points (ex. changement de partenaire : 2)</label><input type="number" inputmode="numeric" name="penalty" min="0" max="99" value="${x.penalty || 0}">
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Enregistrer</button></div>`,
    async (f) => { await api(`/api/teams/${x.id}`, 'PUT', f); await load(); toast('Équipe modifiée'); });
  // Les photos s'envoient tout de suite, sans attendre « Enregistrer ».
  const box = $('#photos');
  const refresh = async () => { cur.data = await api(`/api/t/${cur.slug}`); const fresh = cur.data.teams.find((t) => t.id === x.id); Object.assign(x, fresh); box.innerHTML = photoControls(x); bindPhotos(); };
  const bindPhotos = () => {
    box.querySelectorAll('input[type=file]').forEach((i) => (i.onchange = async () => {
      if (!i.files[0]) return;
      try { await uploadPhoto(x.id, Number(i.dataset.n), i.files[0]); await refresh(); toast('Photo enregistrée'); } catch (e) { $('#derr').textContent = e.message; }
    }));
    box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      try { await api(`/api/teams/${x.id}/photo/${b.dataset.rm}`, 'DELETE'); await refresh(); } catch (e) { $('#derr').textContent = e.message; }
    }));
  };
  bindPhotos();
}
function photoControls(x) {
  return [1, 2].filter((n) => (n === 1 ? x.p1 : x.p2)).map((n) => `
    <div style="text-align:center">
      ${avatar(x, n, 72)}
      <div class="muted" style="margin:4px 0">${esc(n === 1 ? x.p1 : x.p2)}</div>
      <label class="ghost small btnlike">${x[`photo${n}`] ? 'Changer' : 'Ajouter une photo'}<input type="file" accept="image/*" data-n="${n}" hidden></label>
      ${x[`photo${n}`] ? `<button type="button" class="ghost small" data-rm="${n}" style="color:inherit">Retirer</button>` : ''}
    </div>`).join('');
}

function partnerDialog(x) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Tunis' });
  const round = cur.data.matches.reduce((r, m) => (m.stage === 'group' && (m.winner || (m.date && m.date <= today)) ? Math.max(r, m.round) : r), 0);
  openDialog(`<h3>Changer de partenaire</h3>
    <p class="muted">Autorisé en cas de force majeure, pendant le championnat. Pénalité de 2 points à partir de la journée 4 (journée en cours : ${round || 'aucune'}).</p>
    <label>Joueur remplacé</label><select name="player"><option value="1">${esc(x.p1 || 'Joueur 1')}</option><option value="2">${esc(x.p2 || 'Joueur 2')}</option></select>
    <label>Nouveau partenaire</label><input name="name" required maxlength="40">
    <label>Pénalité (points)</label><input type="number" inputmode="numeric" name="penalty" min="0" max="99" value="${round >= 4 ? 2 : 0}">
    <label>Motif</label><input name="reason" maxlength="200" placeholder="Blessure, déménagement…">
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Valider</button></div>`,
    async (f) => { await api(`/api/teams/${x.id}/partner-change`, 'POST', f); await load(); toast('Partenaire changé'); });
}

function scheduleDialog() {
  const t = cur.data.tournament;
  const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  openDialog(`<h3>Planifier le calendrier</h3>
    <p class="muted">Une journée par jour de jeu. Les matchs sont répartis sur les terrains puis les horaires. Les matchs déjà joués ne changent pas.</p>
    <label>Premier jour</label><input type="date" name="start" required value="${esc(t.date)}">
    <label>Jours de jeu</label><div class="row">${[2, 5, 1, 3, 4, 6, 0].map((d) => `<label style="display:flex;gap:4px;margin:0;color:var(--ink)"><input type="checkbox" name="d${d}" style="width:auto;min-height:0" ${d === 2 || d === 5 ? 'checked' : ''}>${dayNames[d]}</label>`).join('')}</div>
    <div class="grid2"><div><label>Horaires (séparés par une virgule)</label><input name="times" value="20:00, 21:30"></div>
    <div><label>Terrains</label><input type="number" inputmode="numeric" name="courts" min="1" max="20" value="3"></div></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Planifier</button></div>`,
    async (f) => {
      const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => f[`d${d}`]);
      const times = f.times.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await api(`/api/tournaments/${t.id}/schedule`, 'POST', { start: f.start, days, times, courts: Number(f.courts) });
      await load(); toast(`${r.days} journées planifiées`);
    });
}

async function postponeDialog(m) {
  let history = [];
  try { history = await api(`/api/matches/${m.id}/postponements`); } catch {}
  const max = m.deadline ? new Date(new Date(`${m.deadline}T12:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10) : '';
  openDialog(`<h3>Reporter le match</h3>
    <p><strong>${esc(teamName(m.team1))}</strong> – <strong>${esc(teamName(m.team2))}</strong><br>
    <span class="muted">Actuellement : ${m.date ? esc(fmtDate(m.date)) : 'sans date'}${m.time ? ` à ${esc(m.time)}` : ''}</span></p>
    <p class="muted">Les deux paires doivent être d'accord, avoir réservé le terrain et communiquer la date dans le groupe WhatsApp. ${m.deadline
      ? `Le match doit être joué <strong>au plus tard le ${esc(fmtDate(max))}</strong> (la journée suivante commence le ${esc(fmtDate(m.deadline))}) ; sinon : défaite 6-0 / 6-0 pour les deux paires.`
      : 'Aucune journée suivante planifiée : pas de limite calculée.'}</p>
    <div class="grid2"><div><label>Nouvelle date</label><input type="date" name="date" required ${max ? `max="${max}"` : ''}></div>
    <div><label>Horaire</label><input type="time" name="time" value="${esc(m.time)}"></div></div>
    <label>Terrain</label><input name="court" maxlength="30" value="${esc(m.court)}">
    <label>Motif (visible des organisateurs)</label><input name="reason" maxlength="200" placeholder="Accord des deux paires, blessure, …">
    ${history.length ? `<h3 style="margin-top:16px">Historique</h3>${history.map((h) => `<div class="muted">${esc(h.from_date ? fmtDate(h.from_date) : '—')} → <strong>${esc(fmtDate(h.to_date))}</strong>${h.reason ? ` · ${esc(h.reason)}` : ''} · ${esc(h.username || '')}</div>`).join('')}` : ''}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Reporter</button></div>`,
    async (f) => {
      const send = (force) => api(`/api/matches/${m.id}/postpone`, 'POST', { ...f, force });
      try { await send(false); }
      catch (e) {
        if (!e.data?.needsForce) throw e;
        if (!confirm(`${e.message}\n\nConfirmer quand même (exception) ?`)) throw new Error('Report annulé');
        await send(true);
      }
      await load(); toast('Match reporté');
    });
}

// --- Notifications push ------------------------------------------------------
const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (b) => Uint8Array.from(atob(b.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

// Ce navigateur est-il abonné à ce tournoi ? true / false, ou null si les notifications ne sont pas possibles ici.
async function pushState() {
  if (!PUSH_OK) return null;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return false;
    return (await api(`/api/t/${cur.slug}/push/status`, 'POST', { endpoint: sub.endpoint })).subscribed;
  } catch { return null; }
}
// Bouton 🔔 : mis en avant tant que la personne n'est pas abonnée, coche une fois abonnée.
async function updateNotifButton() {
  if (!$('#notif') || !cur) return;
  const slug = cur.slug;
  const bell = $('#bell');
  bell.hidden = false;
  bell.onclick = () => pushDialog(cur.team);
  if (cur.pushOn === undefined) cur.pushOn = await pushState();
  const b = $('#notif');
  if (!b || !cur || cur.slug !== slug || cur.pushOn === null) return;
  const nudge = cur.pushOn === false && Notification.permission !== 'denied';
  bell.classList.toggle('nudge', nudge);
  bell.title = nudge ? 'Activer les notifications de ce tournoi' : cur.pushOn ? 'Notifications activées' : 'Notifications';
  b.textContent = cur.pushOn ? b.dataset.on : b.dataset.off;
  b.className = `${nudge ? 'primary' : 'ghost'} small`;
  b.style.color = nudge ? '' : 'inherit';
  b.title = nudge ? 'Vous ne recevez pas encore les notifications de ce tournoi' : '';
}

async function pushDialog(teamId = null) {
  const t = cur.data.tournament;
  if (!PUSH_OK) {
    openDialog(`<h2>Notifications</h2>
      <p>Ce navigateur ne permet pas les notifications.</p>
      <p class="muted">Sur iPhone : ouvrez le site dans Safari, touchez Partager puis « Sur l'écran d'accueil », et rouvrez l'application depuis l'icône.</p>
      <div class="row"><button value="cancel" formnovalidate>Fermer</button></div>`, async () => {});
    return;
  }
  let sub = null, st = null;
  try {
    sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (sub) st = await api(`/api/t/${cur.slug}/push/status`, 'POST', { endpoint: sub.endpoint });
  } catch {}
  const on = !!(st && st.subscribed);
  const sel = on ? st.team_id : teamId;
  openDialog(`<h2>Notifications</h2>
    <p class="muted">Résultats, matchs reportés, rappels (la veille à 18h et 2 h avant), retards et phase finale.</p>
    ${Notification.permission === 'denied' ? '<p class="err">Les notifications sont bloquées pour ce site dans le navigateur : autorisez-les dans ses réglages.</p>' : ''}
    <label>Je veux être prévenu pour
      <select name="team">
        <option value="">Tout le tournoi</option>
        ${cur.data.teams.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)} uniquement</option>`).join('')}
      </select>
    </label>
    <div class="row" style="margin-top:12px">
      <button value="on">${on ? 'Mettre à jour' : 'Activer'}</button>
      ${on ? '<button value="test" class="ghost" style="color:inherit">Tester</button><button value="off" class="ghost" style="color:inherit">Désactiver</button>' : ''}
      <button value="cancel" class="ghost" style="color:inherit" formnovalidate>Fermer</button>
    </div>`, async (data, action) => {
    if (action === 'on') {
      // La permission doit être demandée directement dans le geste de l'utilisateur.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notifications refusées dans le navigateur');
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api('/api/push/key');
      const s = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await api(`/api/t/${cur.slug}/push`, 'POST', { subscription: s.toJSON(), team_id: data.team ? Number(data.team) : null });
      toast('Notifications activées');
      cur.pushOn = undefined; updateNotifButton();
    } else if (action === 'off') {
      const r = await api(`/api/t/${cur.slug}/push`, 'DELETE', { endpoint: sub.endpoint });
      if (!r.remaining) await sub.unsubscribe().catch(() => {});
      toast('Notifications désactivées');
      cur.pushOn = undefined; updateNotifButton();
    } else if (action === 'test') {
      await api(`/api/t/${cur.slug}/push/test`, 'POST', { endpoint: sub.endpoint });
      throw new Error('Notification de test envoyée.'); // garde la fenêtre ouverte
    }
  });
}

// Messages prédéfinis envoyés à tous les abonnés du tournoi.
async function broadcastDialog() {
  const t = cur.data.tournament;
  let b;
  try { b = await api(`/api/tournaments/${t.id}/broadcasts`); } catch (e) { return toast(e.message); }
  const n = b.subscribers;
  openDialog(`<h3>Notifier tout le monde</h3>
    <p class="muted">${n ? `Reçu par les ${n} appareil${n > 1 ? 's' : ''} abonné${n > 1 ? 's' : ''} au tournoi, y compris ceux qui ne suivent qu'une paire.` : 'Aucun appareil abonné pour le moment : personne ne recevra le message.'}</p>
    ${b.templates.map((x, i) => `<label class="card" style="display:block;cursor:pointer">
      <input type="radio" name="template" value="${x.id}" ${i === 0 ? 'checked' : ''} style="width:auto;min-height:0;margin-right:8px"><strong>${esc(x.label)}</strong>
      <div class="muted" data-prev="${x.id}">${esc(x.text)}</div>
      ${x.params.includes('round') ? `<div style="margin-top:6px">Journée <input type="number" inputmode="numeric" name="round" min="1" max="99" value="${b.round}" style="width:90px;display:inline-block"></div>` : ''}</label>`).join('')}
    ${b.templates.length ? '' : '<div class="empty">Aucun message prédéfini : configurez-en.</div>'}
    <div class="row between" style="margin-top:16px"><button type="button" id="bcCfg" class="ghost" style="color:inherit">⚙ Configurer</button>
      <span class="row"><button value="cancel" class="ghost">Annuler</button><button value="send" class="primary" ${b.templates.length ? '' : 'disabled'}>Envoyer</button></span></div>`,
    async (f) => {
      const tpl = b.templates.find((x) => String(x.id) === f.template);
      if (!confirm(`Envoyer « ${tpl.label} » à ${n} appareil${n > 1 ? 's' : ''} ?`)) throw new Error('Envoi annulé');
      const r = await api(`/api/tournaments/${t.id}/broadcast`, 'POST', { template: f.template, round: f.round });
      toast(`Envoyé à ${r.sent} appareil${r.sent > 1 ? 's' : ''}`);
    });
  $('#bcCfg').onclick = () => { dlg.close(); templatesDialog(); };
  // L'aperçu suit le numéro de journée saisi.
  b.templates.filter((x) => x.params.includes('round')).forEach((x) => {
    const box = dlg.querySelector(`[data-prev="${x.id}"]`), input = box?.parentElement.querySelector('input[name="round"]');
    if (input) input.oninput = () => { box.textContent = x.text.replace(new RegExp(`journée ${b.round}\\b`), `journée ${input.value || '?'}`); };
  });
}

// Configuration des messages prédéfinis : titre + texte, variables {journee} et {frais}.
async function templatesDialog() {
  let list;
  try { list = await api('/api/broadcast-templates'); } catch (e) { return toast(e.message); }
  const row = (x = { label: '', text: '' }) => `<div class="card" data-row>
    <div class="row between"><input data-label maxlength="60" placeholder="Titre (ex. Matchs suspendus)" value="${esc(x.label)}" aria-label="Titre"><button type="button" class="danger small" data-delrow aria-label="Supprimer ce message">✕</button></div>
    <textarea data-text maxlength="300" rows="3" placeholder="Texte de la notification" aria-label="Texte" style="margin-top:8px">${esc(x.text)}</textarea></div>`;
  openDialog(`<h3>Messages prédéfinis</h3>
    <p class="muted">Variables : <strong>{journee}</strong> (numéro de journée, modifiable à l'envoi) et <strong>{frais}</strong> (frais d'inscription par joueur, en DT). Valable pour tous les tournois.</p>
    <div id="tplRows">${list.map(row).join('')}</div>
    <div class="row" style="margin-top:8px"><button type="button" id="tplAdd" class="ghost" style="color:inherit">+ Ajouter un message</button><button type="button" id="tplReset" class="ghost" style="color:inherit">Rétablir les messages d'origine</button></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Enregistrer</button></div>`,
    async () => {
      const templates = [...dlg.querySelectorAll('[data-row]')].map((r) => ({ label: r.querySelector('[data-label]').value, text: r.querySelector('[data-text]').value }))
        .filter((x) => x.label.trim() || x.text.trim());
      await api('/api/broadcast-templates', 'PUT', { templates });
      toast('Messages enregistrés');
      setTimeout(broadcastDialog, 50);
    });
  const rows = $('#tplRows');
  const bind = () => rows.querySelectorAll('[data-delrow]').forEach((b) => (b.onclick = () => b.closest('[data-row]').remove()));
  bind();
  $('#tplAdd').onclick = () => { rows.insertAdjacentHTML('beforeend', row()); bind(); rows.lastElementChild.querySelector('input').focus(); };
  $('#tplReset').onclick = async () => {
    if (!confirm('Remplacer tous vos messages par ceux d\'origine ?')) return;
    try { await api('/api/broadcast-templates/reset', 'POST'); toast('Messages rétablis'); dlg.close(); templatesDialog(); } catch (e) { toast(e.message); }
  };
}

function scoreDialog(m) {
  const sets = m.sets || [];
  const row = (i) => `<span class="lab">Set ${i + 1}</span>
    <input name="a${i}" type="number" inputmode="numeric" min="0" max="99" value="${sets[i]?.[0] ?? ''}" aria-label="Set ${i + 1} ${esc(teamName(m.team1))}">
    <input name="b${i}" type="number" inputmode="numeric" min="0" max="99" value="${sets[i]?.[1] ?? ''}" aria-label="Set ${i + 1} ${esc(teamName(m.team2))}">`;
  openDialog(`
    <h3>Score du match</h3>
    <div class="sets"><span></span><strong>${esc(teamName(m.team1))}</strong><strong>${esc(teamName(m.team2))}</strong>${[0, 1, 2].map(row).join('')}</div>
    <div class="grid2"><div><label>Date</label><input type="date" name="date" value="${esc(m.date)}"></div>
    <div><label>Horaire</label><input name="time" maxlength="30" value="${esc(m.time)}" placeholder="20:00"></div></div>
    <label>Terrain</label><input name="court" maxlength="30" value="${esc(m.court)}" placeholder="Terrain 1">
    <label>Forfait (défaite 6-0 6-0)</label>
    <div class="row"><button value="ff1" class="danger small">${esc(teamName(m.team1))}</button><button value="ff2" class="danger small">${esc(teamName(m.team2))}</button>${m.stage === 'group' ? '<button value="ffb" class="danger small">Les deux</button>' : ''}</div>
    <div class="row between" style="margin-top:16px">
      ${m.winner ? '<button value="clear" class="danger small">Effacer le score</button>' : m.stage === 'group' && cur.data.tournament.phase === 'groups' ? '<button value="postpone" class="small">↻ Reporter</button>' : '<span></span>'}
      <span class="row"><button value="cancel" class="ghost">Annuler</button><button value="save" class="primary">Enregistrer</button></span>
    </div>`, async (f, action) => {
    if (action === 'postpone') { setTimeout(() => postponeDialog(m), 0); return; }
    const body = { court: f.court, time: f.time, date: f.date };
    if (action === 'clear') body.sets = null;
    else if (action.startsWith('ff')) body.forfeit = { ff1: 'team2', ff2: 'team1', ffb: 'both' }[action];
    else {
      const s = [0, 1, 2].filter((i) => f[`a${i}`] !== '' || f[`b${i}`] !== '').map((i) => [Number(f[`a${i}`]), Number(f[`b${i}`])]);
      if (s.length) body.sets = s;
      else if (m.winner) throw new Error('Saisissez un score ou utilisez « Effacer le score »');
    }
    await api(`/api/matches/${m.id}`, 'PUT', body);
    await load();
    toast('Enregistré');
  });
}

// --- Score keeper (page plein écran, téléphone sur support) ------------------------------
// Les points sont envoyés au serveur à chaque tap (liste 1/2) ; le score affiché est recalculé en les rejouant (KeeperEngine).
let keeper = null;
const keeperKey = (token) => `keeper:${token}`;

function keeperStop() {
  document.body.classList.remove('keeping');
  if (!keeper) return;
  clearInterval(keeper.poll); clearTimeout(keeper.timer);
  document.removeEventListener('visibilitychange', keeper.onVis);
  keeper.wake?.release?.().catch(() => {});
  try { screen.orientation?.unlock?.(); } catch {}
  keeper = null;
}

async function renderKeeper(token) {
  const info = await api(`/api/live/${token}`);
  let local = null;
  try { local = JSON.parse(localStorage.getItem(keeperKey(token))); } catch {}
  try { localStorage.setItem(`keeperMatch:${info.match.id}`, token); } catch {}
  keeper = { token, info, points: info.points, status: info.status, dirty: false, seq: 0, last: 0, sync: 'ok', closed: null };
  // Des points comptés hors connexion et pas encore envoyés priment sur la version du serveur.
  if (local?.dirty && Array.isArray(local.points)) { keeper.points = local.points; keeper.dirty = true; }
  document.body.classList.add('keeping');
  try { keeper.stay = localStorage.getItem('keeperPortrait') === '1'; } catch {}
  // Verrouillage en paysage : accepté seulement par certains navigateurs (Android, appli installée) ; sinon l'invite « Tournez le téléphone » s'affiche en portrait.
  try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {}
  keeperDraw();
  if (keeper.dirty) keeperSync();
  keeper.poll = setInterval(keeperPoll, 4000);
  const wake = async () => { try { if (keeper && document.visibilityState === 'visible') keeper.wake = await navigator.wakeLock?.request('screen'); } catch {} };
  keeper.onVis = wake;
  document.addEventListener('visibilitychange', wake);
  wake();
}

const SYNC_LABEL = { ok: '● Enregistré', busy: '● Envoi…', off: '● Hors ligne : les points sont gardés' };

function keeperDraw() {
  const k = keeper;
  if (!k) return;
  const { match } = k.info;
  const names = [match.team1.name, match.team2.name];
  if (k.closed) {
    app.innerHTML = `<div class="keeper"><div class="kdone"><h2>${esc(k.closed)}</h2><a class="btn primary" href="#/t/${esc(k.info.slug)}">Retour au tournoi</a></div></div>`;
    return;
  }
  const r = KeeperEngine.replay(k.points);
  const labels = KeeperEngine.pointLabels(r);
  const press = KeeperEngine.pressure(k.points);
  const label = match.stage === 'group' ? `Journée ${match.round}` : 'Phase finale';
  const state = r.winner ? '' : r.tb ? 'Tie-break' : r.decisive ? 'Point décisif' : '';
  const ball = (i) => (press[i] ? `<span class="kball">Balle de ${press[i]}</span>` : '');
  const row = (i) => `<div class="krow ${r.winner === i + 1 ? 'win' : ''}">
      <span class="kn">${esc(names[i])}${ball(i)}</span>
      ${r.sets.map((x) => `<span class="ks ${x[i] > x[1 - i] ? 'w' : ''}">${x[i]}</span>`).join('')}
      <span class="ks cur">${r.winner ? '' : r.games[i]}</span>
      <span class="kp">${r.winner ? r.won[i] : labels[i]}</span></div>`;
  const setsText = r.sets.map((x) => x.join('-')).join(' ');
  let bottom;
  if (r.winner) {
    const sent = k.status === 'submitted';
    bottom = `<div class="kdone"><div class="ktrophy">🏆</div><h2>${esc(names[r.winner - 1])} gagne</h2><div class="kfinal">${esc(setsText)}</div>
      ${sent ? '<p>Résultat envoyé ✓<br><span class="muted">Un organisateur doit le valider avant qu\'il compte au classement.</span></p>'
             : '<button class="primary kbig" id="ksubmit">Envoyer le résultat</button>'}
      <button class="ghost" id="kundo2">↶ Corriger : annuler le dernier point</button></div>`;
  } else {
    bottom = `<div class="kpads">
      ${[0, 1].map((i) => `<button class="kpad p${i + 1}" data-w="${i + 1}" aria-label="Point pour ${esc(names[i])}"><span class="kname">${esc(names[i])}</span><span class="kplus">+1</span></button>`).join('')}</div>`;
  }
  app.innerHTML = `<div class="keeper ${k.stay ? 'stay' : ''}">
    <div class="kbar">
      <a class="kicon" href="#/t/${esc(k.info.slug)}" aria-label="Quitter le score keeper">←</a>
      <div class="kmeta"><strong>${esc(label)}</strong>${match.court ? ` · ${esc(match.court)}` : ''}<div class="ksync ${k.sync}">${SYNC_LABEL[k.sync]}</div></div>
      <button class="kicon" id="kundo" aria-label="Annuler le dernier point" ${k.points.length ? '' : 'disabled'}>↶</button>
      <button class="kicon" id="kmenu" aria-label="Menu">⋯</button>
    </div>
    <div class="kboard">${row(0)}${row(1)}</div>
    <div class="kstate">${state || '&nbsp;'}</div>
    ${bottom}
    <div class="krotate"><div class="kphone" aria-hidden="true">📱</div><h2>Tournez le téléphone en mode paysage</h2><p>Le score keeper se lit et se touche mieux à l'horizontale.</p><button class="ghost" id="kstay">Rester en portrait</button></div></div>`;
  $('#kstay')?.addEventListener('click', () => { k.stay = true; try { localStorage.setItem('keeperPortrait', '1'); } catch {} keeperDraw(); });
  app.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => keeperPoint(Number(b.dataset.w))));
  $('#kundo')?.addEventListener('click', keeperUndo);
  $('#kundo2')?.addEventListener('click', keeperUndo);
  $('#kmenu')?.addEventListener('click', keeperMenu);
  $('#ksubmit')?.addEventListener('click', async () => {
    try { await keeperSync(true); keeperDraw(); } catch (e) { toast(e.message); }
  });
}

function keeperPoint(w) {
  const k = keeper, now = Date.now();
  if (!k || now - k.last < 300 || KeeperEngine.replay(k.points).winner) return; // double tap involontaire
  k.last = now;
  k.points.push(w);
  navigator.vibrate?.(25);
  keeperChanged();
}

function keeperUndo() {
  if (!keeper?.points.length) return;
  keeper.points.pop();
  keeper.status = 'live';
  keeperChanged();
  toast('Point annulé');
}

function keeperChanged() {
  const k = keeper;
  k.dirty = true; k.seq++;
  try { localStorage.setItem(keeperKey(k.token), JSON.stringify({ points: k.points, dirty: true })); } catch {}
  keeperDraw();
  clearTimeout(k.timer);
  k.timer = setTimeout(() => keeperSync().catch(() => {}), 200);
}

// Envoie la liste des points au serveur ; en cas d'échec réseau, les points restent en local et on réessaie.
async function keeperSync(submit = false) {
  const k = keeper;
  if (!k) return;
  const seq = k.seq;
  k.sync = 'busy'; keeperSyncLabel();
  try {
    const r = await api(`/api/live/${k.token}`, 'PUT', { points: k.points, ...(submit ? { submit: true } : {}) });
    if (keeper !== k) return;
    k.status = r.status;
    if (k.seq === seq) { k.dirty = false; try { localStorage.removeItem(keeperKey(k.token)); } catch {} }
    k.sync = 'ok'; keeperSyncLabel();
  } catch (e) {
    if (keeper !== k) return;
    if (e.data?.error && /résultat|existe plus/.test(e.data.error)) { k.closed = e.message; keeperDraw(); return; }
    k.sync = 'off'; keeperSyncLabel();
    clearTimeout(k.timer);
    k.timer = setTimeout(() => keeperSync().catch(() => {}), 5000);
    if (submit) throw e;
  }
}

function keeperSyncLabel() {
  const el = $('.ksync');
  if (!el || !keeper) return;
  el.className = `ksync ${keeper.sync}`;
  el.textContent = SYNC_LABEL[keeper.sync];
}

// Un autre téléphone peut compter le même match : on reprend sa version tant qu'on n'a rien d'en attente.
async function keeperPoll() {
  const k = keeper;
  if (!k || k.dirty || k.closed || document.visibilityState !== 'visible') return;
  try {
    const info = await api(`/api/live/${k.token}`);
    if (keeper !== k || k.dirty) return;
    if (JSON.stringify(info.points) !== JSON.stringify(k.points) || info.status !== k.status) {
      k.points = info.points; k.status = info.status; keeperDraw();
    }
  } catch (e) {
    if (keeper === k && /existe plus/.test(e.message)) { k.closed = e.message; keeperDraw(); }
  }
}

function keeperMenu() {
  const k = keeper;
  const code = k.info.code;
  openDialog(`<h3>Score keeper</h3>
    <p class="muted">Pour compter depuis un autre téléphone, donnez-lui ce code (valable jusqu'à la saisie du résultat).</p>
    <input id="kurl" class="kcode" readonly value="${esc(fmtCode(code))}" onfocus="this.select()">
    <div class="row" style="margin-top:8px">${navigator.share ? '<button value="share">Partager</button>' : ''}<button value="copy" class="primary">Copier le code</button></div>
    <div class="row" style="margin-top:16px"><button value="reset" class="danger small">Recommencer à zéro</button><button value="close" class="danger small">Fermer le score keeper</button></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Retour</button></div>`,
  async (f, action) => {
    if (action === 'share') {
      try { await navigator.share({ title: 'Score keeper', text: codeMessage(code) }); } catch {}
    } else if (action === 'copy') {
      await copyOrShare(codeMessage(code), 'copy', $('#kurl'), 'Code copié');
    } else if (action === 'reset') {
      if (!confirm('Remettre le score à zéro ?')) throw new Error('Annulé');
      k.points = []; k.status = 'live'; keeperChanged();
    } else if (action === 'close') {
      if (!confirm('Fermer le score keeper ? Les points comptés seront perdus.')) throw new Error('Annulé');
      await api(`/api/live/${k.token}`, 'DELETE');
      try { localStorage.removeItem(keeperKey(k.token)); localStorage.removeItem(`keeperMatch:${k.info.match.id}`); } catch {}
      location.hash = `#/t/${k.info.slug}`;
    }
  });
}

// --- Authentification ----------------------------------------------------------------
function loginDialog() {
  openDialog(`<h3>Accès organisateur</h3>
    <label>Identifiant</label><input name="username" required autocomplete="username" autocapitalize="none" value="admin">
    <label>Mot de passe</label><input type="password" name="password" required autocomplete="current-password" autofocus>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button value="cancel" class="ghost">Annuler</button><button value="ok" class="primary">Connexion</button></div>`,
    async (f) => { const r = await api('/api/login', 'POST', f); setToken(r.token, r.user); toast('Connecté'); render(); });
}

async function accountDialog() {
  let users = [], backups = [];
  if (me?.owner) { try { users = await api('/api/users'); backups = await api('/api/backups'); } catch {} }
  const refresh = () => { dlg.close(); accountDialog(); };
  openDialog(`<h3>Mon compte · ${esc(me?.username)}</h3>
    <label>Mot de passe actuel</label><input type="password" name="current" autocomplete="current-password">
    <label>Nouveau mot de passe (6 caractères min.)</label><input type="password" name="new" autocomplete="new-password">
    <div class="row" style="margin-top:12px;justify-content:space-between">
      <button value="logout" class="danger small">Déconnexion</button>
      <span class="row"><button value="cancel" class="ghost">Fermer</button><button value="pw" class="primary">Changer</button></span>
    </div>
    ${me?.owner ? `<h3 style="margin-top:22px">Organisateurs</h3>
      ${users.map((u) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(u.username)} ${u.owner ? '<span class="badge">propriétaire</span>' : ''}</span>
        ${u.owner ? '' : `<span class="row"><button type="button" class="ghost small" data-reset="${u.id}" data-name="${esc(u.username)}" style="color:inherit">Mot de passe</button><button type="button" class="danger small" data-rm="${u.id}" data-name="${esc(u.username)}">Supprimer</button></span>`}</div>`).join('')}
      <div class="grid2" style="margin-top:10px"><input name="nu" placeholder="Identifiant" autocapitalize="none" autocomplete="off"><input name="np" type="text" placeholder="Mot de passe" autocomplete="off"></div>
      <button value="add" class="primary" style="width:100%;margin-top:8px">Ajouter un organisateur</button>
      <h3 style="margin-top:22px">Sauvegardes</h3>
      <p class="muted" style="margin:0 0 6px">Une sauvegarde par jour, les 14 dernières sont conservées. Fichiers confidentiels (mots de passe hachés, paiements).</p>
      ${backups.slice(0, 5).map((b) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span>${esc(b.name.replace(/^padel-|\.db$/g, ''))} · ${Math.round(b.size / 1024)} Ko</span><button type="button" class="ghost small" data-dl="${esc(b.name)}" style="color:inherit">Télécharger</button></div>`).join('') || '<p class="muted">Aucune sauvegarde.</p>'}
      <button type="button" class="ghost" data-newbk style="width:100%;margin-top:8px;color:inherit">Sauvegarder maintenant</button>` : ''}`,
    async (f, action) => {
      if (action === 'logout') { setToken(null); toast('Déconnecté'); render(); return; }
      if (action === 'add') {
        await api('/api/users', 'POST', { username: f.nu, password: f.np });
        toast(`Organisateur « ${f.nu} » ajouté`); setTimeout(refresh, 0); return;
      }
      if (!f.new) throw new Error('Saisissez un nouveau mot de passe');
      await api('/api/me/password', 'PUT', { current: f.current, new: f.new });
      toast('Mot de passe modifié');
    });
  dlg.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!confirm(`Supprimer l'organisateur « ${b.dataset.name} » ?`)) return;
    try { await api(`/api/users/${b.dataset.rm}`, 'DELETE'); toast('Organisateur supprimé'); refresh(); } catch (e) { $('#derr').textContent = e.message; }
  }));
  dlg.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => {
    try {
      const r = await fetch(`/api/backups/${encodeURIComponent(b.dataset.dl)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('Téléchargement impossible');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob()); a.download = b.dataset.dl; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { $('#derr').textContent = e.message; }
  }));
  dlg.querySelector('[data-newbk]')?.addEventListener('click', async () => {
    try { await api('/api/backups', 'POST'); toast('Sauvegarde créée'); refresh(); } catch (e) { $('#derr').textContent = e.message; }
  });
  dlg.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = async () => {
    const pw = prompt(`Nouveau mot de passe pour « ${b.dataset.name} » (6 caractères min.)`);
    if (!pw) return;
    try { await api(`/api/users/${b.dataset.reset}/password`, 'PUT', { password: pw }); toast('Mot de passe réinitialisé'); } catch (e) { $('#derr').textContent = e.message; }
  }));
}

// --- Invitation à installer l'appli (PWA) ---------------------------------------
// Android / Chrome : le navigateur propose l'installation (beforeinstallprompt). iPhone : pas d'événement, on explique le geste.
// Rien si l'appli est déjà installée (ouverte en mode « application »), et le message se retire 14 jours quand on le ferme.
let installEvt = null;
const isStandalone = () => !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installDismissed = () => { try { return Date.now() - Number(localStorage.getItem('installDismissed') || 0) < 14 * 864e5; } catch { return false; } };

function installBanner() {
  const bar = $('#install');
  if (!bar) return;
  if (isStandalone() || installDismissed() || (!installEvt && !isIos())) { bar.hidden = true; return; }
  bar.innerHTML = `
    <svg width="34" height="34" viewBox="0 0 28 28" aria-hidden="true" style="flex:none"><circle cx="14" cy="14" r="13" fill="#0b2a5b"/><path d="M4 6c5 3 5 13 0 16M24 6c-5 3-5 13 0 16" stroke="#d4f04a" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
    <div class="grow"><strong>Installez Padel sur votre téléphone</strong><div style="font-size:.85rem">Accès direct depuis l'écran d'accueil et notifications des matchs.</div></div>
    <button id="installGo" class="small">${installEvt ? 'Installer' : 'Comment ?'}</button>
    <button id="installNo" class="ghost small" aria-label="Plus tard" style="color:inherit;padding:0 10px">✕</button>`;
  bar.hidden = false;
  $('#installGo').onclick = async () => {
    if (installEvt) {
      installEvt.prompt();
      const r = await installEvt.userChoice.catch(() => null);
      installEvt = null;
      if (r && r.outcome === 'accepted') toast('Installation en cours…');
      installBanner();
    } else installHelp();
  };
  $('#installNo').onclick = () => { try { localStorage.setItem('installDismissed', String(Date.now())); } catch {} bar.hidden = true; };
}
function installHelp() {
  const safari = !/crios|fxios|edgios|opios/i.test(navigator.userAgent || '');
  openDialog(`<h3>Installer Padel sur iPhone</h3>
    ${safari ? '' : '<p class="err" style="min-height:0">Ouvrez d\'abord ce site dans Safari : les autres navigateurs ne permettent pas l\'installation.</p>'}
    <ol style="padding-left:1.2em;line-height:1.7">
      <li>Touchez le bouton <strong>Partager</strong> (le carré avec une flèche) dans la barre de Safari.</li>
      <li>Choisissez <strong>« Sur l'écran d'accueil »</strong>.</li>
      <li>Touchez <strong>Ajouter</strong>, puis ouvrez Padel depuis sa nouvelle icône.</li>
    </ol>
    <p class="muted">Les notifications ne fonctionnent sur iPhone qu'une fois l'appli installée.</p>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button value="cancel" class="primary">Compris</button></div>`, async () => {});
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; installBanner(); });
window.addEventListener('appinstalled', () => { installEvt = null; installBanner(); toast('Padel est installé'); });
installBanner();

$('#auth').addEventListener('click', () => (isAdmin() ? accountDialog() : loginDialog()));

window.addEventListener('hashchange', render);
setInterval(() => { if (cur && !dlg.open && !document.hidden) load().catch(() => {}); }, 20000);
setInterval(() => { if (cur && cur.tab === 'live' && !cur.team && !dlg.open && !document.hidden) load().catch(() => {}); }, 5000);
setToken(token);
render();
