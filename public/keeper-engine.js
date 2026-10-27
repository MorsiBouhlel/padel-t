'use strict';
// Moteur du score keeper, partagé par le navigateur et le serveur (le serveur rejoue la liste des points,
// il ne fait jamais confiance au score affiché par le téléphone).
// Règles : meilleur des 3 sets (3e set complet, pas de super tie-break), jeu décisif à 40-40 (point décisif),
// set à 6 jeux avec 2 d'écart, tie-break à 7 points (2 d'écart) à 6-6 dans chaque set.
(function (root) {
  const LABELS = ['0', '15', '30', '40'];

  // points : liste de 1 / 2 (paire qui marque, dans l'ordre). Les points joués après la victoire sont ignorés (used < points.length).
  function replay(points) {
    const sets = [];
    const won = [0, 0];
    let g = [0, 0], p = [0, 0], winner = 0, used = 0;
    for (const w of points) {
      if (winner) break;
      const i = w === 2 ? 1 : 0;
      p[i]++; used++;
      const tb = g[0] === 6 && g[1] === 6;
      const game = tb ? p[i] >= 7 && p[i] - p[1 - i] >= 2 : p[i] >= 4;
      if (!game) continue;
      g[i]++; p = [0, 0];
      if ((g[i] >= 6 && g[i] - g[1 - i] >= 2) || g[i] === 7) {
        sets.push(g); won[i]++; g = [0, 0];
        if (won[i] === 2) winner = i + 1;
      }
    }
    const tb = g[0] === 6 && g[1] === 6;
    return { sets, won, games: g, pts: p, tb, winner, used, decisive: !tb && p[0] === 3 && p[1] === 3 };
  }

  // Affichage des points du jeu en cours : 0 / 15 / 30 / 40, ou le nombre de points en tie-break.
  const pointLabels = (r) => (r.tb ? [String(r.pts[0]), String(r.pts[1])] : [LABELS[r.pts[0]], LABELS[r.pts[1]]]);

  // Balle de set / de match pour chaque paire : le prochain point lui ferait gagner le set ou le match.
  function pressure(points) {
    const r = replay(points);
    if (r.winner) return [null, null];
    return [1, 2].map((i) => {
      const n = replay([...points, i]);
      return n.winner ? 'match' : n.sets.length > r.sets.length ? 'set' : null;
    });
  }

  const api = { replay, pointLabels, pressure };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KeeperEngine = api;
})(typeof self !== 'undefined' ? self : this);
