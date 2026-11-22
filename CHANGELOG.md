# Changelog

All notable changes to YourLastFM are documented in this file.

## [2.0.0] - 2026-11-22 — migration de la source Last.fm vers ListenBrainz

### Changed (breaking)
- **Source de données : ListenBrainz au lieu de Last.fm.** Nouvelles variables d'env obligatoires : `LISTENBRAINZ_USERNAME` (requis) et `LISTENBRAINZ_USER_TOKEN` (optionnel, validation `validate-token`, jamais exposé au navigateur). `LASTFM_API_KEY` / `LASTFM_USERNAME` / `LASTFM_REQUEST_*` disparaissent au profit de `LISTENBRAINZ_REQUEST_DELAY_MS` (défaut 1000 ms), `LISTENBRAINZ_REQUEST_TIMEOUT_MS`, `LISTENBRAINZ_MAX_LISTENS_PER_REQUEST` (défaut 1000) et `LISTENBRAINZ_API_URL` / `LISTENBRAINZ_WEB_URL` (override d'instance).
- **Synchro** : `GET /1/user/{u}/listens` fenêtré (min_ts/max_ts, batchs de 1000, curseur max_ts) à la place de `user.getrecenttracks` paginé. Même mécanique de lock, checkpoint et fenêtre rejouée. Chaque listen stocke désormais `artist_mbid` / `release_mbid` / `recording_mbid` et la durée (backfill des lignes existantes sur conflit).
- **Intégrity check** : compare le count local à `GET /1/user/{u}/listen-count`.
- **Scrobbles récents live** : listens LB + `playing-now` (badge « en cours »), pagination émulée par curseur ; `delete_url` pointe vers la page `listenbrainz.org/user/{u}/listens/`. La suppression reste **locale** (`deleted_scrobbles`) — aucune purge distante via `delete-listen` (décision du 2026-11-22).
- **Liens externes** : `listenbrainz.org/artist|release|track/{mbid}` quand le MBID est connu, sinon recherche ListenBrainz. Champs renommés : `lastfmUrl` → `listenbrainzUrl` (page artiste), `lastfmTracklist` → `externalTracklist` (page album).
- **Métadonnées** : MusicBrainz (client throttlé 1 req/s + UA) pour MBID artiste, tracklists d'albums (release-group → recordings) et durées de morceaux (recording.length) ; pochettes via **Cover Art Archive** (`release_mbid` des listens, puis release-group MB), fallback Deezer inchangé ; bios artistes via **Wikipedia** (titre exact puis search, langue demandée) avec fallback annotation MB ; année d'album toujours via MB release-group.
- **Amis** : la liste « amis » devient les **followings** ListenBrainz (`/1/user/{u}/following`) avec listen-count ; la comparaison utilise les stats LB `all_time` (artists/recordings/releases). Les usernames de groupes de leaderboards sont à re-saisir en usernames LB.
- **Leaderboards** : les classements sur période arbitraire sont agrégés depuis les listens bruts des membres (les stats LB n'ont que des ranges fixes) ; profils via listen-count + page `listenbrainz.org/user/{u}/`.
- **Images** : le proxy `/api/image-proxy` autorise désormais `coverartarchive.org` et `*.archive.org` (redirections CAA) en plus des CDN legacy Last.fm/Deezer (pochettes historées encore servies). Le header `Authorization` est masqué dans les logs d'erreur.
- **Schéma SQLite** : colonnes `artist_mbid`, `release_mbid`, `recording_mbid` ajoutées à `scrobbles` (migration auto) ; `artist_info.lastfm_url` renommée en `listenbrainz_url` (cache vidé). Les données historiques restent intactes.
- Avatar ListenBrainz : aucun avatar côté LB → `null` (placeholder UI).
- Bios artistes en anglais par défaut (`ARTIST_BIO_LANG=en`, Wikipedia anglais plus riche), indépendamment de la langue de l'UI.

### Tests
- Nouveaux tests `listenbrainz.test.js` (normalizeListen, URLs CAA), `listenbrainzUrl.test.js`, `listenbrainzResponse.test.js`, `imageUrl.test.js` ; `leaderboard.test.js` adapté (agrégation depuis listens LB) ; `syncStatus.test.js` à jour. 79 tests OK, `npm run check` OK. Smoke test réel contre l'API LB (sync incrémental idempotent, recent-scrobbles, leaderboard, friends, image-proxy CAA→archive.org).

## [1.9.0] - 2026-11-22

### Added
- Bouton « ▶ Lire l'album » en en-tête de la page album : résout l'album dans Music Assistant (`music/item_by_name` avec `media_type: "album"`, puis `music/search` section albums), priorité bibliothèque locale puis providers externes playable (Deezer > Bandcamp), malus sur les éditions live/deluxe/remaster, puis lecture via `player_queues/clear` + `play_media` avec l'uri album. Nouveaux endpoints `POST /api/play/album` et `POST /api/play/album/availability` (bouton grisé avec tooltip si l'album est introuvable).
- Boutons ▶ (Music Assistant) sur chaque titre de la page album — y compris les pistes jamais écoutées —, sur chaque scrobble (accueil et page Scrobbles) et sur chaque morceau du top de la page artiste.
- Page album : la tracklist affichée est désormais toujours complète, dans l'ordre original — Discogs d'abord, sinon repli sur Last.fm (`album.getInfo`, nouveau champ `lastfmTracklist` de `/api/album`). Les titres jamais écoutés sont grisés (« — ») mais restent jouables ; les titres locaux hors tracklist externe sont conservés en fin de liste.
- Page d'accueil centrée sur la journée : les 4 cartes de résumé « Aujourd'hui » (avec comparaisons vs hier et moyenne/jour sur l'année en cours) remplacent les tuiles globales, conservées en petite ligne sous le pseudo ; les tops albums/artistes/morceaux ont des pilules Jour / Semaine / Mois / Année (Jour par défaut, indépendantes par module).

### Fixed
- Synchronisation bloquée « En cours » au redémarrage : un process de synchro tué laissait `sync_status` à `running: true` en base (bouton Sync désactivé, polling infini). `getSyncStatus()` remet désormais le statut à « interrompu » quand le lock fichier est absent ou périmé (> 2 h), et supprime le lock périmé.
- Un clic sur le bouton ▶ ou la poubelle d'une ligne de scrobble n'ouvre plus la page artiste.

### Tests
- 74 tests au total, dont les nouveaux tests album de `test/musicAssistant.test.js` (8) et `test/syncStatus.test.js` (4).

## [1.8.0] - 2026-11-18

### Added
- Bouton « Écouter » (▶) via Music Assistant (MA) sur les tops de l'accueil, la recherche, la page album et la page titre. Le morceau est recherché dans MA (`music/item_by_name`, puis `music/search`) avec priorité à la bibliothèque locale et fallback sur les providers externes playable (Deezer, Bandcamp) ; la lecture est lancée via `player_queues/play_media` après `player_queues/clear` (comportement « play now » : la queue du player choisi est vidée avant lecture).
- Sélecteur de player MA dans la sidebar (choix persisté en localStorage) ; player par défaut configurable par nom (`MA_DEFAULT_PLAYER`, ex. `Squeezelite-MacBook`) ou par `queue_id` (`MA_PLAYER_ID`).
- Nouveaux endpoints : `GET /api/player/status`, `POST /api/play`, `POST /api/play/availability` (boutons grisés avec tooltip quand le morceau est introuvable). Le token MA (`MA_TOKEN`) n'est jamais exposé au navigateur.
- Nouvelles variables d'env : `MA_API_URL`, `MA_TOKEN`, `MA_PLAYER_ID`, `MA_DEFAULT_PLAYER`, `MA_REQUEST_TIMEOUT_MS`, `MA_SEARCH_CACHE_TTL_MS`, `MA_PLAYERS_CACHE_TTL_MS` (voir `.env.example`).

### Changed
- Le handler d'erreurs API renvoie aussi `error.code` quand il est présent.

### Tests
- 62 tests au total, dont les nouveaux `test/musicAssistant.test.js` et `test/normalizeText.test.js`.

## [1.7.0] - 2026-11-07

### Added

- Nouvelle page d'accueil façon profil Last.fm : en-tête avatar et pseudo, tuiles globales (scrobbles, artistes, albums, morceaux), derniers scrobbles en liste compacte avec suppression locale et bouton "Voir tout", et tops albums / artistes / morceaux filtrables (7 jours, 30 jours, 365 jours, tout) — chaque top a ses propres pilules de filtre, indépendantes.
- Trois pages Statistiques dédiées (Mois, Année, Tout) reprenant les modules du tableau de bord : cartes de résumé (dont une nouvelle carte "Artistes écoutés"), top albums / artistes / morceaux, graphique et horloge d'écoute ; sélecteurs année / mois selon la page.
- Sur les pages Statistiques, le module d'écoute est unifié avec pilules de granularité : jour / semaine (Mois), jour / semaine / mois (Année), mois / année (Tout) ; le changement de granularité se re-rend localement, sans nouvelle requête.
- Clic sur une barre du graphique (jour, semaine, mois ou année) : la page Scrobbles s'ouvre filtrée sur cette période, avec bandeau récapitulatif et total d'écoutes (nouvel endpoint `GET /api/scrobbles` sur la base locale), heure d'écoute affichée, suppression locale et pagination dédiées.
- Page Scrobbles : titres de jour localisés insérés entre les groupes ("Samedi 7 novembre 2026"), y compris à travers la pagination.
- Nouvelle plage de filtre "30 derniers jours" côté back (comparaison avec les 30 jours précédents).

### Changed

- Page Scrobbles : 50 scrobbles par page (au lieu de 20) ; accueil : 20 derniers scrobbles.
- Les semaines des graphiques s'affichent en bornes de dates ("26 oct. – 1 nov.", lundi-dimanche) au lieu du numéro de semaine ; le graphique Insights "Écoutes par semaine" bénéficie du même libellé.
- Sur la page "Tout", le graphique principal regroupe par mois (le regroupement par jour sur tout l'historique était illisible).

### Fixed

- Le libellé des semaines du graphique Insights n'affichait plus la clé brute SQLite ("2026-43") : le format combinait les clés ISO et SQLite sans distinction.

## [1.6.0] - 2026-11-05

### Added

- Le visuel d'en-tête des pages artiste et album s'ouvre en plein écran au clic (fermeture par Échap, clic ou bouton), avec la pochette en haute résolution lorsque la source le permet.
- Liens Discogs vers l'artiste ou l'album sur les fiches, avec logos officiels en pastilles (lookup via l'API publique Discogs, token optionnel `DISCOGS_TOKEN`, mise en cache locale).
- Page artiste : membres du groupe en chips (membres inactifs estompés).
- Page album : tracklist dans l'ordre original de l'album, rapprochée des écoutes locales (variantes de version regroupées et sommées), chips genres/styles et label.

### Changed

- Le titre d'un album du top du dashboard ouvre la page album au lieu de Last.fm.

## [1.5.0] - 2026-11-02

### Changed

- Le filtre "Jour" couvre desormais les ecoutes du jour depuis 00h00 heure locale du navigateur, au lieu des dernieres 24 heures glissantes, et repart de zero a minuit.
- Le dashboard s'ouvre par defaut sur le filtre "Jour".
- Sur le filtre "Jour", la carte "Moyenne par jour (annee en cours)" affiche la moyenne quotidienne depuis le 1er janvier, comparee a la meme periode l'annee precedente ; les autres filtres gardent la moyenne du filtre.
- Les libelles des pilules de filtre sont raccourcis ("Jour", "Semaine", "Mois", "Annee").
- Le graphique des ecoutes par jour regroupe par jour local pour le filtre "Jour".
- La cle de cache du dashboard inclut le jour courant pour basculer immediatement a minuit.

### Fixed

- Les trois cartes du resume gardent des dimensions identiques a toutes les tailles d'ecran.
- Les pilules de filtre ont toutes la meme largeur.

## [1.3.0] - 2026-08-02

### Added

- Local custom leaderboard groups made from public Last.fm usernames.
- Preset and custom date ranges for artist, album, and track rankings.
- Per-member scrobble standings and combined group charts.
- Artist and album drill-down views showing the group's most-played tracks.
- Persistent SQLite caches for user profiles, charts, results, and album track lists.
- Configurable group, member, date-range, cache, and request-concurrency limits.

### Changed

- Last.fm leaderboard requests now use an identifiable application user agent.
- Leaderboard requests are deduplicated, concurrency-limited, retried, and served from stale cache after temporary failures.
- Reopening the Leaderboards page reuses the current state instead of immediately repeating all group requests.

### Fixed

- Preserved partial leaderboard results when one group member temporarily fails.
- Prevented invalid saved ranking types and unavailable date presets from breaking the interface.
- Kept the group modal save label correct when switching between create and edit modes.

## [1.2.0] - 2026-08-02

### Added

- Previous-period trends for dashboard summary metrics.
- Listening Clock chart with browser-local hour aggregation.
- Direct Last.fm links for artists, albums, and tracks.
- Persistent SQLite dashboard response cache.
- Configurable static-asset caching.

### Changed

- Dashboard data now loads through one combined API request.
- Artwork and duration enrichment now shares a single concurrency-limited queue.
- Changing dashboard filters cancels obsolete requests.
- Docker Compose can use the published image while retaining local build support.

### Fixed

- Prevented older, slower dashboard responses from overwriting newer filter selections.
- Invalidated dashboard cache after sync, CSV imports, and manual cover uploads.
