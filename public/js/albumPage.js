import { fetchJSON } from "./api.js";
import { t } from "./i18n.js";
import { formatTimestampDate } from "./dates.js";
import { escapeAttribute, escapeHTML, installImageFallbacks, safeImageUrl } from "./dom.js";
import { playButtonHtml, playAlbumButtonHtml } from "./player.js";

let currentAlbum = null;
let loadId = 0;
let activeRequest = null;

export function getCurrentAlbum() {
  return currentAlbum;
}

export function showAlbum(artist, album) {
  if (!artist || !album) return;
  location.hash = `album/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`;
}

function showLoadingState() {
  const name = document.getElementById("album-name");
  if (name) name.textContent = "…";

  for (const id of ["album-stats", "album-tracks"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = "";
  }

  const playButton = document.getElementById("album-play-btn");
  if (playButton) playButton.innerHTML = "";

  const image = document.getElementById("album-image");
  if (image) image.src = "/images/cover-placeholder.svg";
}

function chipsFromData(data) {
  const genreChip = [...(data.genres || []), ...(data.styles || [])]
    .map(item => escapeHTML(item))
    .join(" · ");

  return [
    data.year ? `<span class="detail-stat"><strong>${escapeHTML(String(data.year))}</strong></span>` : "",
    genreChip ? `<span class="detail-stat">${genreChip}</span>` : "",
    data.label ? `<span class="detail-stat">${escapeHTML(data.label)}</span>` : "",
    `<span class="detail-stat"><strong>${Number(data.plays || 0).toLocaleString()}</strong> ${escapeHTML(t("common.playsUnit"))}</span>`,
    `<span class="detail-stat"><strong>${Number(data.uniqueTracks || 0).toLocaleString()}</strong> ${escapeHTML(t("album.tracksStat", { count: "" }).trim())}</span>`,
    `<span class="detail-stat">${escapeHTML(t("artist.firstListen"))} : <strong>${escapeHTML(formatTimestampDate((data.firstPlay || 0) * 1000))}</strong></span>`,
    `<span class="detail-stat">${escapeHTML(t("artist.lastListen"))} : <strong>${escapeHTML(formatTimestampDate((data.lastPlay || 0) * 1000))}</strong></span>`
  ].filter(Boolean);
}

function renderAlbumStats(data) {
  const element = document.getElementById("album-stats");
  if (!element) return;

  element.innerHTML = chipsFromData(data).join("");
}

function stripNameVariant(value) {
  return String(value || "").replace(/\s*\(.*\)\s*$/, "").trim();
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function buildLocalTrackIndex(tracks) {
  const index = new Map();

  for (const row of tracks || []) {
    const base = normalizeName(stripNameVariant(row.track));
    const entry = index.get(base) || { plays: 0, best: null };

    entry.plays += Number(row.plays || 0);
    if (!entry.best || Number(row.plays || 0) > Number(entry.best.plays || 0)) {
      entry.best = row;
    }

    index.set(base, entry);
  }

  return index;
}

function renderFullTracklist(data, tracklist) {
  const container = document.getElementById("album-tracks");
  if (!container) return;

  const localTracks = buildLocalTrackIndex(data.tracks);
  const matched = new Set();

  const rows = (tracklist || []).map((entry, index) => {
    const base = normalizeName(entry.title);
    const local = localTracks.get(base);
    if (local) matched.add(base);

    if (!local) {
      // Never played locally: dimmed, but still playable on Music Assistant.
      return `
        <div class="top-row top-row-external">
          <span class="rank">${index + 1}</span>
          <div class="meta">
            <strong>${escapeHTML(entry.title)}</strong>
            ${playButtonHtml(data.artist, entry.title)}
            <small>—</small>
          </div>
        </div>
      `;
    }

    return `
      <div class="top-row" data-track-artist="${escapeAttribute(data.artist)}" data-track-name="${escapeAttribute(local.best.track)}">
        <span class="rank">${index + 1}</span>
        <div class="meta">
          <strong title="${escapeAttribute(t("track.viewPage"))}">${escapeHTML(entry.title)}</strong>
          <a
            class="music-link"
            href="${escapeAttribute(local.best.url || "#")}"
            target="_blank"
            rel="noopener noreferrer"
            title="${escapeAttribute(t("dashboard.openTrackOnListenbrainz"))}"
          >
            <i class="mdi mdi-open-in-new"></i>
          </a>
          ${playButtonHtml(data.artist, local.best.track)}
          <small>${Number(local.plays || 0).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}</small>
        </div>
      </div>
    `;
  });

  // Local tracks that the external tracklist does not cover (bonus tracks,
  // alternate takes, wrong external match…): keep them visible at the end.
  for (const [base, entry] of localTracks) {
    if (matched.has(base)) continue;
    rows.push(`
      <div class="top-row" data-track-artist="${escapeAttribute(data.artist)}" data-track-name="${escapeAttribute(entry.best.track)}">
        <span class="rank">${rows.length + 1}</span>
        <div class="meta">
          <strong title="${escapeAttribute(t("track.viewPage"))}">${escapeHTML(entry.best.track)}</strong>
          <a
            class="music-link"
            href="${escapeAttribute(entry.best.url || "#")}"
            target="_blank"
            rel="noopener noreferrer"
            title="${escapeAttribute(t("dashboard.openTrackOnListenbrainz"))}"
          >
            <i class="mdi mdi-open-in-new"></i>
          </a>
          ${playButtonHtml(data.artist, entry.best.track)}
          <small>${Number(entry.plays || 0).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}</small>
        </div>
      </div>
    `);
  }

  container.innerHTML = rows.join("");
}

function renderTracks(data) {
  const container = document.getElementById("album-tracks");
  if (!container) return;

  // Full album tracklist (original order) when an external source provides
  // one: Discogs first, then MusicBrainz. Tracks never played locally are dimmed
  // but still get a play button.
  const fullTracklist = (Array.isArray(data.discogsTracklist) && data.discogsTracklist.length)
    ? data.discogsTracklist
    : (Array.isArray(data.externalTracklist) && data.externalTracklist.length)
      ? data.externalTracklist
      : null;

  if (fullTracklist) {
    renderFullTracklist(data, fullTracklist);
    return;
  }

  container.innerHTML = (data.tracks || []).map((row, index) => `
    <div class="top-row" data-track-artist="${escapeAttribute(data.artist)}" data-track-name="${escapeAttribute(row.track)}">
      <span class="rank">${index + 1}</span>
      <div class="meta">
        <strong title="${escapeAttribute(t("track.viewPage"))}">${escapeHTML(row.track)}</strong>
        <a
          class="music-link"
          href="${escapeAttribute(row.url || "#")}"
          target="_blank"
          rel="noopener noreferrer"
          title="${escapeAttribute(t("dashboard.openTrackOnListenbrainz"))}"
        >
          <i class="mdi mdi-open-in-new"></i>
        </a>
        ${playButtonHtml(data.artist, row.track)}
        <small>${Number(row.plays || 0).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}</small>
      </div>
    </div>
  `).join("");
}

function renderAlbumPage(data) {
  const image = document.getElementById("album-image");
  if (image) {
    image.src = safeImageUrl(data.image) || "/images/cover-placeholder.svg";
    image.alt = data.album;
    installImageFallbacks(image.parentElement);
  }

  const name = document.getElementById("album-name");
  if (name) name.textContent = data.album;

  const artistLink = document.getElementById("album-artist");
  if (artistLink) {
    artistLink.dataset.artist = data.artist;
    artistLink.title = t("artist.viewPage");
    artistLink.querySelector("strong").textContent = data.artist;
  }

  renderAlbumStats(data);

  const listenbrainzLink = document.getElementById("album-listenbrainz");
  if (listenbrainzLink) {
    if (data.url) {
      listenbrainzLink.href = data.url;
      listenbrainzLink.classList.remove("d-none");
    } else {
      listenbrainzLink.classList.add("d-none");
    }
  }

  const discogsLink = document.getElementById("album-discogs");
  if (discogsLink) {
    if (data.discogsUrl) {
      discogsLink.href = data.discogsUrl;
      discogsLink.classList.remove("d-none");
    } else {
      discogsLink.classList.add("d-none");
    }
  }

  const playButton = document.getElementById("album-play-btn");
  if (playButton) {
    playButton.innerHTML = playAlbumButtonHtml(data.artist, data.album, { large: true, withLabel: true });
  }

  renderTracks(data);
}

// The API answers instantly with a DB-only page (enriching: true) and fills
// the metadata caches in the background: poll until the enriched page lands.
const ENRICH_POLL_MS = 2500;
const ENRICH_POLL_MAX = 24;

function scheduleEnrichPoll(artist, album, key, request, attempt) {
  if (request !== loadId || currentAlbum !== key || attempt >= ENRICH_POLL_MAX) return;
  setTimeout(async () => {
    if (request !== loadId || currentAlbum !== key) return;
    try {
      const data = await fetchJSON(
        `/api/album/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`,
        { cache: "no-store" }
      );
      if (request !== loadId || currentAlbum !== key) return;
      renderAlbumPage(data);
      if (data.enriching) scheduleEnrichPoll(artist, album, key, request, attempt + 1);
    } catch {
      // best-effort polling: the page is already rendered
    }
  }, ENRICH_POLL_MS);
}

export async function loadAlbum(artist, album) {
  if (!artist || !album) return;
  const key = `${artist}\u0000${album}`;
  if (currentAlbum === key && activeRequest) return;

  currentAlbum = key;
  const request = ++loadId;
  activeRequest = request;
  showLoadingState();

  try {
    const data = await fetchJSON(
      `/api/album/${encodeURIComponent(artist)}/${encodeURIComponent(album)}`,
      { cache: "no-store" }
    );

    if (request !== loadId || currentAlbum !== key) return;
    renderAlbumPage(data);
    if (data.enriching) scheduleEnrichPoll(artist, album, key, request, 0);
  } catch (error) {
    console.error("Error loading album page:", error);
  } finally {
    if (activeRequest === request) activeRequest = null;
  }
}
