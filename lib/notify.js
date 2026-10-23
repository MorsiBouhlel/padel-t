// Notifications : textes des messages et rappels à envoyer (logique pure, testée dans test/notify.test.js).
const { parseTime } = require('./ics');

const setsText = (sets) => (sets || []).map((x) => `${x[0]}-${x[1]}`).join(' ');
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const whenText = (date, time) => (date ? `${fmtDate(date)}${time ? ` à ${time}` : ''}` : 'date à confirmer');

// Date et minutes écoulées depuis minuit, en Tunisie (UTC+1 toute l'année).
function nowTunis(d = new Date()) {
  const t = new Date(d.getTime() + 3600e3);
  return { date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

const dayBefore = (date) => new Date(new Date(`${date}T12:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10);

// Message d'un résultat saisi. `m` : { winner, sets, forfeit } ; n1, n2 : noms des paires (domicile, extérieur).
function resultMessage({ winner, sets, forfeit, team1, team2 }, n1, n2, corrected = false) {
  const head = corrected ? 'Résultat corrigé' : 'Résultat';
  if (forfeit === 'both' || winner === -1) return `Double forfait : ${n1} et ${n2}`;
  const [w, l] = winner === team1 ? [n1, n2] : [n2, n1];
  if (forfeit) return `Forfait : ${w} gagne contre ${l}`;
  // Score vu du vainqueur, pour qu'il se lise « 6-3 6-4 » et non « 3-6 4-6 ».
  const s = winner === team1 ? sets : (sets || []).map(([a, b]) => [b, a]);
  return `${head} : ${w} bat ${l} ${setsText(s)}`.trim();
}

// Rappels à envoyer maintenant. matches : état public (avec .late et .deadline), sent : Set des clés déjà envoyées.
// Retourne [{ key, match, text }]. Les clés contiennent la date et l'heure : un match reporté déclenche de nouveaux rappels.
function dueReminders(matches, now, sent, name) {
  const out = [];
  const add = (key, m, text) => { if (!sent.has(key)) out.push({ key, match: m, text }); };
  for (const m of matches) {
    if (m.winner || !m.team1 || !m.team2 || !m.date) continue;
    const vs = `${name(m.team1)} vs ${name(m.team2)}`;
    const id = `${m.id}:${m.date}:${m.time || ''}`;
    if (m.late === 'forfeit') {
      add(`forfeit:${m.id}:${m.deadline}`, m, `Match non joué à temps : ${vs}. Double forfait possible (6-0 / 6-0 pour les deux paires).`);
      continue;
    }
    if (m.late === 'late') {
      add(`late:${m.id}:${m.date}`, m, `Match en retard : ${vs}, prévu ${whenText(m.date, m.time)}.${m.deadline ? ` À jouer avant le ${fmtDate(m.deadline)}, sinon double forfait.` : ''}`);
      continue;
    }
    if (m.date < now.date) continue;
    if (dayBefore(m.date) === now.date && now.minutes >= 18 * 60) add(`eve:${id}`, m, `Demain${m.time ? ` à ${m.time}` : ''} : ${vs}${m.court ? ` (${m.court})` : ''}`);
    const hm = parseTime(m.time);
    if (m.date === now.date && hm) {
      const left = hm[0] * 60 + hm[1] - now.minutes;
      if (left > 0 && left <= 120) add(`soon:${id}`, m, `Dans ${left < 60 ? `${left} min` : `${Math.round(left / 6) / 10} h`.replace('.', ',')} (${m.time}) : ${vs}${m.court ? ` (${m.court})` : ''}`);
    }
  }
  return out;
}

// Messages prédéfinis par défaut (modifiables par les organisateurs, voir table broadcast_templates).
// Variables : {journee} (numéro de journée à annoncer), {frais} (frais d'inscription par joueur, en DT).
const DEFAULT_TEMPLATES = [
  { label: 'Nouvelle journée', text: 'La journée {journee} commence. Consultez le calendrier et jouez vos matchs avant le début de la journée suivante.' },
  { label: 'Calendrier mis à jour', text: 'Le calendrier a été mis à jour. Vérifiez la date, l\'heure et le terrain de vos prochains matchs.' },
  { label: 'Rappel : envoyer les scores', text: 'Rappel : après chaque match, envoyez le score aux organisateurs pour que le classement reste à jour.' },
  { label: 'Matchs en retard', text: 'Des matchs sont en retard. Jouez-les avant la journée suivante, sinon double forfait (défaite 6-0 / 6-0 pour les deux paires).' },
  { label: 'Rappel de paiement', text: 'Rappel : merci de régler votre inscription ({frais} DT par joueur) auprès des organisateurs.' },
  { label: 'Matchs suspendus', text: 'Les matchs prévus aujourd\'hui sont suspendus (terrain ou conditions indisponibles). Un nouveau créneau vous sera communiqué.' },
  { label: 'Play-offs bientôt', text: 'Le championnat touche à sa fin : jouez vos derniers matchs de poule, les play-offs approchent.' },
];

const fillTemplate = (text, ctx) => text.replace(/\{journee\}/g, ctx.round).replace(/\{frais\}/g, ctx.fee);
const templateParams = (text) => (/\{journee\}/.test(text) ? ['round'] : []);

module.exports = { DEFAULT_TEMPLATES, fillTemplate, templateParams, resultMessage, dueReminders, nowTunis, whenText, dayBefore };
