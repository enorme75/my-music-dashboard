import { fetchJSON } from "./api.js";
import { t, getLocale } from "./i18n.js";
import { formatTimestampDate } from "./dates.js";
import { escapeAttribute, escapeHTML, installImageFallbacks, safeImageUrl } from "./dom.js";
import { playButtonHtml } from "./player.js";
import { openTextOverlay } from "./lightbox.js";

let currentArtist = null;
let loadId = 0;
let activeRequest = null;

export function getCurrentArtist() {
  return currentArtist;
}

export function showArtist(name) {
  if (!name) return;
  location.hash = `artist/${encodeURIComponent(name)}`;
}

function showLoadingState() {
  const name = document.getElementById("artist-name");
  if (name) name.textContent = "…";

  for (const id of ["artist-stats", "artist-members", "artist-bio", "artist-top-tracks", "artist-albums"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = "";
  }

  const loadingBio = document.getElementById("artist-bio");
  if (loadingBio) loadingBio.classList.remove("clamped");
  const loadingBioMore = document.getElementById("artist-bio-more");
  if (loadingBioMore) loadingBioMore.hidden = true;

  const image = document.getElementById("artist-image");
  if (image) image.src = "/images/artist-placeholder.png";
}

function renderArtistStats(data) {
  const element = document.getElementById("artist-stats");
  if (!element) return;

  element.innerHTML = [
    `<span class="artist-stat"><strong>${Number(data.plays || 0).toLocaleString()}</strong> ${escapeHTML(t("common.playsUnit"))}</span>`,
    `<span class="artist-stat"><strong>${Number(data.uniqueAlbums || 0).toLocaleString()}</strong> ${escapeHTML(t("artist.albumsStat", { count: "" }).trim())}</span>`,
    `<span class="artist-stat"><strong>${Number(data.uniqueTracks || 0).toLocaleString()}</strong> ${escapeHTML(t("artist.tracksStat", { count: "" }).trim())}</span>`,
    `<span class="artist-stat">${escapeHTML(t("artist.firstListen"))} : <strong>${escapeHTML(formatTimestampDate((data.firstPlay || 0) * 1000))}</strong></span>`,
    `<span class="artist-stat">${escapeHTML(t("artist.lastListen"))} : <strong>${escapeHTML(formatTimestampDate((data.lastPlay || 0) * 1000))}</strong></span>`
  ].join("");
}

function renderTopTracks(data) {
  const container = document.getElementById("artist-top-tracks");
  if (!container) return;

  container.innerHTML = (data.topTracks || []).map((row, index) => `
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

function renderAlbums(data) {
  const container = document.getElementById("artist-albums");
  if (!container) return;

  container.innerHTML = (data.albums || []).map(album => `
    <div class="artist-album" data-album-artist="${escapeAttribute(data.artist)}" data-album-name="${escapeAttribute(album.album)}">
      <a class="music-link" title="${escapeAttribute(t("album.viewPage"))}">
        <img
          src="${escapeAttribute(safeImageUrl(album.image))}
          alt="${escapeAttribute(album.album)}"
          loading="lazy"
          decoding="async"
          data-fallback="/images/cover-placeholder.svg"
        >
        <strong>${escapeHTML(album.album)}</strong>
      </a>
      <small>
        ${album.year ? `<span class="artist-album-year">${escapeHTML(String(album.year))}</span> · ` : ""}
        ${Number(album.plays || 0).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}
      </small>
    </div>
  `).join("");

  installImageFallbacks(container);
}

function renderArtist(data) {
  const image = document.getElementById("artist-image");
  if (image) {
    image.src = safeImageUrl(data.image) || "/images/artist-placeholder.png";
    image.alt = data.artist;
    installImageFallbacks(image.parentElement);
  }

  const name = document.getElementById("artist-name");
  if (name) name.textContent = data.artist;

  renderArtistStats(data);

  const members = document.getElementById("artist-members");
  if (members) {
    const list = data.members || [];
    members.textContent = "";
    if (list.length) {
      members.innerHTML = [
        `<span class="artist-members-label">${escapeHTML(t("artist.members"))}</span>`,
        ...list.map(member => `<span class="artist-stat${member.active ? "" : " artist-member-inactive"}">${escapeHTML(member.name)}</span>`)
      ].join("");
    }
  }

  const listenbrainzLink = document.getElementById("artist-listenbrainz");
  if (listenbrainzLink) {
    if (data.listenbrainzUrl) {
      listenbrainzLink.href = data.listenbrainzUrl;
      listenbrainzLink.classList.remove("d-none");
    } else {
      listenbrainzLink.classList.add("d-none");
    }
  }

  const discogsLink = document.getElementById("artist-discogs");
  if (discogsLink) {
    if (data.discogsUrl) {
      discogsLink.href = data.discogsUrl;
      discogsLink.classList.remove("d-none");
    } else {
      discogsLink.classList.add("d-none");
    }
  }

  const bio = document.getElementById("artist-bio");
  const bioMore = document.getElementById("artist-bio-more");
  if (bio) {
    const bioText = data.bio || "";
    bio.textContent = bioText || t("artist.noBio");
    bio.classList.toggle("clamped", Boolean(bioText));
    if (bioMore) {
      bioMore.hidden = !bioText;
      bioMore.onclick = bioText
        ? () => openTextOverlay(data.artist || currentArtist || "", bioText)
        : null;
      if (bioText) {
        requestAnimationFrame(() => {
          if (bio.scrollHeight <= bio.clientHeight + 1) {
            bio.classList.remove("clamped");
            bioMore.hidden = true;
          }
        });
      }
    }
  }

  renderTopTracks(data);
  renderAlbums(data);
}

// The API answers instantly with a DB-only page (enriching: true) and fills
// the metadata caches in the background: poll until the enriched page lands.
const ENRICH_POLL_MS = 2500;
const ENRICH_POLL_MAX = 24;

function scheduleEnrichPoll(name, request, attempt) {
  if (request !== loadId || currentArtist !== name || attempt >= ENRICH_POLL_MAX) return;
  setTimeout(async () => {
    if (request !== loadId || currentArtist !== name) return;
    try {
      const lang = getLocale().slice(0, 2);
      const data = await fetchJSON(
        `/api/artist/${encodeURIComponent(name)}?lang=${lang}`,
        { cache: "no-store" }
      );
      if (request !== loadId || currentArtist !== name) return;
      renderArtist(data);
      if (data.enriching) scheduleEnrichPoll(name, request, attempt + 1);
    } catch {
      // best-effort polling: the page is already rendered
    }
  }, ENRICH_POLL_MS);
}

export async function loadArtist(name) {
  if (!name) return;
  if (name === currentArtist && activeRequest) return;

  currentArtist = name;
  const request = ++loadId;
  activeRequest = request;
  showLoadingState();

  try {
    const lang = getLocale().slice(0, 2);
    const data = await fetchJSON(
      `/api/artist/${encodeURIComponent(name)}?lang=${lang}`,
      { cache: "no-store" }
    );

    if (request !== loadId || currentArtist !== name) return;
    renderArtist(data);
    if (data.enriching) scheduleEnrichPoll(name, request, 0);
  } catch (error) {
    console.error("Error loading artist page:", error);
  } finally {
    if (activeRequest === request) activeRequest = null;
  }
}
