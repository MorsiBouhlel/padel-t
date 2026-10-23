# Idées d'améliorations

Liste des fonctionnalités à ajouter, classées par utilité pour le bon déroulement des tournois.
Cocher `[x]` quand c'est fait.

## À faire en premier

- [x] **1. Alertes de retard et de forfait automatiques** — repérer les matchs dont la date est dépassée sans score, les lister pour l'organisateur (« 3 matchs en retard »). Applique la règle : match non joué avant la journée suivante = 6-0 / 6-0 pour les deux paires.
- [x] **2. Report de match guidé** — bouton « Reporter » : nouvelle date + limite de jeu (jour de la journée suivante) affichée, historique des reports par paire.
- [x] **3. Historique des modifications** — journal : qui a changé quel score ou quelle date, et quand (avant → après). Onglet « Historique », organisateurs seulement.
- [x] **4. Changement de partenaire** — bouton dédié : pénalité de 2 points automatique à partir de la journée 4, refus pendant les play-offs, trace de l'ancien duo.
- [x] **5. HTTPS avec un nom de domaine** — les mots de passe des organisateurs circulent en clair en HTTP. Prérequis pour les points 8 et 9.

## Utile pour les joueurs

- [x] **6. Une page par paire** — matchs passés et à venir, rang, points, lien partageable.
- [x] **7. Calendrier à ajouter à l'agenda** — `.ics` du tournoi ou d'une paire, abonnement `webcal://` (mise à jour auto) ou téléchargement.
- [x] **8. Installation sur téléphone (PWA)** — l'application s'ouvre depuis l'écran d'accueil.
- [x] **9. Notifications** — notifications push (PWA, HTTPS) : bouton « 🔔 Notifications » (tout le tournoi ou une paire) et « Suivre cette paire ». Événements : résultat saisi, match reporté, rappels (veille 18h, 2 h avant), match en retard / forfait à appliquer / forfait appliqué, play-offs lancés.

## Pour l'organisateur

- [x] **10. Sauvegarde automatique de la base** — une copie par jour (`/data/backups`, 14 conservées), téléchargement et « Sauvegarder maintenant » dans Mon compte (propriétaire).
- [x] **11. Export du classement et du calendrier** pour WhatsApp — texte riche (emojis, gras ; partage natif du téléphone, sinon api.whatsapp.com, bouton Copier) du classement et des prochains matchs, image PNG du classement (partage natif, sinon téléchargement). Pas de PDF.
- [x] **12. Statistiques de la saison** — onglet « Stats » : attaque/défense, sets gagnés, séries, remontées, records de matchs.
- [x] **13. Suivi des paiements** — qui a payé les 150 DT par joueur.
- [x] **14. Archive de tournois** — bouton « Édition suivante » (paires reprises, dernière décochée), liens entre éditions, section « Archives » à l'accueil.

## Priorités recommandées

1 (alertes de retard), 4 (changement de partenaire) et 5 (HTTPS).

## Rappels techniques

- Application : `/home/nextrack/admin/padel`, en Docker (`docker compose up -d --build`).
- Accès public : **https://pt.algoris.tn** via le Caddy du projet `nextrack` (`/home/nextrack/nextrack/Caddyfile`, bloc `pt.algoris.tn`, conteneur `nextrack-caddy-1`). L'application est sur le réseau Docker partagé `edge`. Le port 3020 n'écoute plus qu'en local (127.0.0.1).
- Recharger Caddy après modification du Caddyfile : `docker exec nextrack-caddy-1 caddy reload --config /etc/caddy/Caddyfile`.
- Mot de passe du propriétaire : `ADMIN_PASSWORD=... docker compose up -d` le réinitialise.
- Données du championnat importées depuis Score7 avec `scripts/import-score7.js` (ne pas relancer : doublon). Pour un autre import : `BASE_URL=http://127.0.0.1:3020 ADMIN_PASSWORD=... node scripts/import-score7.js`.
