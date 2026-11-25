# YourLastFM

YourLastFM is a self-hosted Node.js dashboard that synchronizes your ListenBrainz listens into SQLite, displays listening statistics, compares your taste with friends, builds custom group leaderboards, and generates shareable recap images.

## Features

- Incremental ListenBrainz synchronization with a configurable overlap window (windowed `listens` API, up to 1000 listens per request).
- Automatic first full sync when the database is empty.
- Cross-process sync lock, resumable sync windows, progress reporting, retries, and a daily integrity check against the ListenBrainz listen count.
- Dashboard with top artists, albums, tracks, daily activity, previous-period trends, a local-time Listening Clock, account statistics, and recent listens (with playing-now).
- Direct ListenBrainz links for artists, releases, and tracks (exact MBID pages when known, search fallback otherwise).
- MusicBrainz IDs, durations, and release data stored with each listen; Cover Art Archive covers with Deezer fallback.
- Persistent SQLite dashboard cache invalidated after syncs, imports, and manual cover changes.
- ListenBrainz followings list and comparison with common artists, albums, and tracks (ListenBrainz stats API), including resilient artwork fallbacks.
- Custom local leaderboard groups with public ListenBrainz users, exact date ranges (computed from raw listens), member standings, combined artist/album/track charts, and top-track drill-downs.
- Standard and Instagram Story recap images generated on the server.
- Automatic album/artist image lookup, persistent image cache, and manual album-cover uploads.
- CSV import and streaming CSV export.
- Persistent SQLite database and uploaded covers through the `data` volume.

## Requirements

- Docker and Docker Compose, or Node.js 22 with the native dependencies required by `canvas` and `better-sqlite3`.
- A ListenBrainz account. Reading listens is public, so only the username is required; the user token (https://listenbrainz.org/settings/) is optional and only used server-side to validate the configuration.

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

At minimum, configure:

```env
LISTENBRAINZ_USERNAME=your_listenbrainz_username
# optional, never exposed to the browser:
LISTENBRAINZ_USER_TOKEN=your_listenbrainz_user_token
```

To migrate an existing Last.fm database: keep the same `data/` directory. The `scrobbles` table is reused as-is and gains `artist_mbid` / `release_mbid` / `recording_mbid` columns (NULL for historical rows); new syncs from ListenBrainz backfill MBIDs and durations on matching rows.

## Run with Docker Compose

Use the published image:

```bash
docker compose pull
docker compose up -d
```

Or build the current source locally:

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:1533
```

The API starts immediately. Synchronization runs in a separate managed process, so a large initial history import does not keep the web interface offline. If a ListenBrainz page keeps failing after all retries, the original `from`/`to` window is persisted and retried on the next run instead of advancing past the missing page.

Useful commands:

```bash
# Follow both API and synchronization logs
docker compose logs -f

# Rebuild after updating the source
docker compose up -d --build

# Stop the application without deleting ./data
docker compose down
```

The Docker image rebuilds `canvas` from source during every platform build. This avoids ARM64 prebuilt-library incompatibilities on Raspberry Pi 5 and other systems using 16 KB or 64 KB memory pages.

Do not delete the local `data` directory unless you intentionally want to remove the SQLite database, uploaded covers, and downloaded share-image cache.

## Run without Docker

```bash
npm ci
npm start
```

Run the scheduler in another terminal:

```bash
npm run start:cron
```

Manual synchronization commands:

```bash
npm run sync
npm run sync:full
npm run sync:initial
```

## Configuration

The defaults are documented in `.env.example`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `LISTENBRAINZ_USERNAME` | ListenBrainz user whose listens are synchronized | required |
| `LISTENBRAINZ_USER_TOKEN` | Optional user token (validate-token); server-side only | empty |
| `LISTENBRAINZ_API_URL` | API base URL (override for a self-hosted instance) | `https://api.listenbrainz.org/1` |
| `LISTENBRAINZ_WEB_URL` | Web base URL used for links in the UI | `https://listenbrainz.org` |
| `PORT` | HTTP port | `1533` |
| `SYNC_CRON` | Incremental sync schedule | `*/5 * * * *` |
| `INTEGRITY_CRON` | ListenBrainz/local count check | `0 3 * * *` |
| `INTEGRITY_MISSING_THRESHOLD` | Missing listens required before the integrity check starts a full repair sync | `1` |
| `SYNC_OVERLAP_SECONDS` | Re-fetch window used to safely catch late listens | `86400` |
| `LISTENBRAINZ_REQUEST_DELAY_MS` | Delay between ListenBrainz listen batches | `1000` |
| `LISTENBRAINZ_REQUEST_TIMEOUT_MS` | ListenBrainz request timeout | `15000` |
| `LISTENBRAINZ_MAX_LISTENS_PER_REQUEST` | Batch size for the listens API (server caps at 1000) | `1000` |
| `MUSICBRAINZ_REQUEST_DELAY_MS` | Delay between MusicBrainz requests (1 req/s max) | `1100` |
| `ARTIST_BIO_LANG` | Language of artist bios (Wikipedia); English Wikipedia is richer, so `en` is the default | `en` |
| `ARTIST_GROUPING` | `main` (default) groups scrobbles by the main artist (featurings stripped, like Last.fm/ListenBrainz); groups are keyed by the MusicBrainz artist MBID when one is stored locally, else by main-artist name — no extra API calls. `raw` counts each full artist string as its own artist | `main` |
| `DASHBOARD_CACHE_TTL_MS` | Persistent dashboard cache lifetime in milliseconds; `0` disables time-based expiry | `300000` |
| `STATIC_ASSET_CACHE_SECONDS` | Browser cache lifetime for local JavaScript, CSS, and images | `300` |
| `LEADERBOARD_CACHE_TTL_MS` | Persistent lifetime for generated leaderboard results; `0` disables time-based expiry | `900000` |
| `LEADERBOARD_PROFILE_TTL_MS` | Lifetime of cached ListenBrainz user profiles | `86400000` |
| `LEADERBOARD_ALBUM_TTL_MS` | Lifetime of cached album track lists | `2592000000` |
| `LEADERBOARD_REQUEST_CONCURRENCY` | Concurrent ListenBrainz requests while building group charts | `4` |
| `LEADERBOARD_MAX_GROUPS` | Maximum local leaderboard groups | `50` |
| `LEADERBOARD_MAX_MEMBERS` | Maximum ListenBrainz users in one group | `20` |
| `LEADERBOARD_MAX_RANGE_DAYS` | Maximum inclusive leaderboard date range | `366` |
| `EXTERNAL_REQUEST_CONCURRENCY` | Concurrent metadata/image lookups | `4` |
| `FRIENDS_CACHE_TTL_MS` | In-memory cache lifetime for the ListenBrainz followings list | `300000` |
| `IMAGE_FAILURE_CACHE_MS` | Time before retrying an image lookup that returned nothing | `600000` |
| `METADATA_FAILURE_CACHE_MS` | Time before retrying missing track metadata | `600000` |
| `SHARE_IMAGE_CONCURRENCY` | Concurrent recap image loads | `4` |
| `SHARE_MAX_CONCURRENT` | Maximum simultaneous recap renders | `2` |
| `SHARE_IMAGE_MAX_BYTES` | Maximum downloaded image size | `10485760` |
| `CORS_ORIGIN` | Optional comma-separated external origins | empty |

## Dashboard caching

The browser loads the main Dashboard through a single `/api/dashboard` request. The generated response is stored in SQLite, so reopening the Dashboard or returning to a previously used filter does not repeat the expensive aggregation and artwork lookups.

The cache is invalidated automatically when:

- a synchronization completes;
- a CSV import adds scrobbles;
- a manual album cover is changed.

Rolling periods compare against the immediately preceding equivalent window. The Listening Clock uses the timezone offset reported by the browser.

## Custom leaderboards

Open **Leaderboards** from the sidebar, create a group, and add at least two public ListenBrainz usernames. The username configured in `LISTENBRAINZ_USERNAME` can be added with the **Add me** button.

Each group supports:

- 7, 30, 90, and 365-day presets;
- an inclusive custom date range;
- artist, album, and track rankings;
- member standings and per-item contribution counts;
- artist and album drill-downs for the group's most-played tracks;
- direct links to the corresponding ListenBrainz pages.

Groups and their caches are stored locally in `stats.db`; no separate account system or external YourLastFM service is involved. Because ListenBrainz statistics only expose fixed ranges, arbitrary date ranges are computed by aggregating the members' raw listens for the window; requests are concurrency-limited, retried, and cached. If one member temporarily fails, the remaining data is still displayed as a partial result. Use **Refresh** to bypass the current chart cache.

## Data and backups

Persistent files are stored under `./data`:

```text
data/
├── stats.db        # scrobbles, settings, groups, and API caches
├── covers/
└── image-cache/
```

A basic backup can be made while the application is stopped:

```bash
docker compose down
cp -a data data-backup
```

SQLite uses WAL mode. When making a live filesystem-level backup, include `stats.db`, `stats.db-wal`, and `stats.db-shm`, or use SQLite's backup tooling.

## Validation

```bash
npm run check
npm test
npm audit
```

## License

MIT. See [LICENSE](LICENSE).
