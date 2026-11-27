import { fetchJSON } from "./api.js";
import { t } from "./i18n.js";
import { escapeAttribute, escapeHTML, installImageFallbacks, safeImageUrl } from "./dom.js";
import { playButtonHtml } from "./player.js";
import { showToast } from "./toast.js";

// Full "top" list pages reached through the "Voir tout" links:
// hash #list/{albums|artists|tracks}?range=day|week|month|year|all
//                          or ?year=2026[&month=11]
//                          or ?artist=<name> (top tracks of an artist page)
const PAGE_SIZE = 25;
const RANGES = ["day", "week", "month", "year", "all"];
const TYPE_TITLE_KEY = {
  albums: "common.topAlbums",
  artists: "common.topArtists",
  tracks: "dashboard.topSongs"
};
const TYPE_UNIT_KEY = {
  albums: "list.unitAlbums",
  artists: "list.unitArtists",
  tracks: "list.unitTracks"
};
const TYPE_COL_KEY = {
  albums: "list.colAlbum",
  artists: "list.colArtist",
  tracks: "list.colTrack"
};

// ---------------------------------------------------------------------------
// Unified list rows: one grid for all three types (#, 40px thumbnail, meta,
// plays). The play count always lives in the right-hand column; the
// ListenBrainz link sits inline next to the title (always visible here, not
// hover-only like on the dashboard) and the play button (tracks only) stays
// on the title line. The dashboard's "Total" duration column is dropped on
// this page: the value is not reliable there.
// ---------------------------------------------------------------------------

function lbLink(url, title) {
  return `
    <a
      class="music-link lb-link"
      href="${escapeAttribute(url || "#")}"
      target="_blank"
      rel="noopener noreferrer"
      title="${escapeAttribute(title)}"
    >
      <i class="mdi mdi-open-in-new"></i>
    </a>
  `;
}

function playsCell(value) {
  return `<span class="list-plays">${Number(value).toLocaleString()}</span>`;
}

function artistSubLink(name) {
  return `<a class="list-sub" href="#artist/${encodeURIComponent(name)}" title="${escapeAttribute(t("artist.viewPage"))}">${escapeHTML(name)}</a>`;
}

function listArtistRow(artist, index) {
  return `
    <div class="list-row" data-artist="${escapeAttribute(artist.artist)}">
      <span class="rank">${index + 1}</span>
      <img
        src="${escapeAttribute(safeImageUrl(artist.image))}"
        alt="${escapeAttribute(artist.artist)}"
        class="list-thumb round"
        loading="lazy"
        decoding="async"
        data-fallback="/images/artist-placeholder.png"
      />
      <div class="list-meta">
        <div class="list-title-line">
          <strong class="list-title">${escapeHTML(artist.artist)}</strong>
          ${lbLink(artist.url, t("dashboard.openArtistOnListenbrainz"))}
        </div>
      </div>
      ${playsCell(artist.plays)}
    </div>
  `;
}

function listAlbumRow(album, index) {
  return `
    <div class="list-row" data-album-artist="${escapeAttribute(album.artist)}" data-album-name="${escapeAttribute(album.album)}">
      <span class="rank">${index + 1}</span>
      <img
        src="${escapeAttribute(safeImageUrl(album.album_image, "/images/cover-placeholder.svg"))}"
        alt="${escapeAttribute(album.album)}"
        class="list-thumb"
        loading="lazy"
        decoding="async"
        data-fallback="/images/cover-placeholder.svg"
      />
      <div class="list-meta">
        <div class="list-title-line">
          <strong class="list-title">${escapeHTML(album.album)}</strong>
          ${lbLink(album.url, t("dashboard.openAlbumOnListenbrainz"))}
        </div>
        ${artistSubLink(album.artist)}
      </div>
      ${playsCell(album.plays)}
    </div>
  `;
}

function listTrackRow(row, index) {
  const coverAttrs = row.album
    ? `data-album-artist="${escapeAttribute(row.artist)}" data-album-name="${escapeAttribute(row.album)}"`
    : "";
  return `
    <div class="list-row">
      <span class="rank">${index + 1}</span>
      <img
        src="${escapeAttribute(safeImageUrl(row.album_image, "/images/cover-placeholder.svg"))}"
        alt="${escapeAttribute(row.album || row.track)}"
        class="list-thumb"
        ${coverAttrs}
        loading="lazy"
        decoding="async"
        data-fallback="/images/cover-placeholder.svg"
      />
      <div class="list-meta">
        <div class="list-title-line">
          <strong
            class="list-title"
            data-track-artist="${escapeAttribute(row.artist)}"
            data-track-name="${escapeAttribute(row.track)}"
            title="${escapeAttribute(t("track.viewPage"))}"
          >${escapeHTML(row.track)}</strong>
          ${lbLink(row.url, t("dashboard.openTrackOnListenbrainz"))}
          ${playButtonHtml(row.artist, row.track)}
        </div>
        ${artistSubLink(row.artist)}
      </div>
      ${playsCell(row.plays)}
    </div>
  `;
}

const ROW_BUILDERS = {
  albums: listAlbumRow,
  artists: listArtistRow,
  tracks: listTrackRow
};
const MONTH_KEYS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec"
];

let current = null; // { type, params }
let items = [];
let total = 0;
let hasMore = false;
let loadCounter = 0;
let abortController = null;
let refreshTimer = null;
let refreshCount = 0;

export function parseListHash() {
  const match = /^#list\/(albums|artists|tracks)(?:\?(.*))?$/.exec(location.hash);
  if (!match) return null;
  const params = {};
  if (match[2]) {
    new URLSearchParams(match[2]).forEach((value, key) => {
      params[key] = value;
    });
  }
  return { type: match[1], params };
}

export function getCurrentList() {
  return current;
}

export function showTopList(type, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  location.hash = `#list/${type}${qs.toString() ? `?${qs.toString()}` : ""}`;
}

function rangeLabel(range) {
  if (!range || range === "all") return t("list.pillAll");
  const key = `home.pill${range.charAt(0).toUpperCase()}${range.slice(1)}`;
  return t(key);
}

function manualLabel(params) {
  const year = params.year || "";
  const month = Number(params.month || 0);
  if (month >= 1 && month <= 12) return `${t(`months.${MONTH_KEYS[month - 1]}`)} ${year}`;
  return String(year);
}

function filterLabel(params) {
  if (params.artist) return params.artist;
  if (params.year) return manualLabel(params);
  return rangeLabel(params.range);
}

function keepArtist(params) {
  return params.artist ? { artist: params.artist } : {};
}

function renderShell(type, params) {
  const title = document.getElementById("list-title");
  if (title) title.textContent = `${t(TYPE_TITLE_KEY[type])} — ${filterLabel(params)}`;

  const count = document.getElementById("list-count");
  if (count) count.textContent = "";

  const manual = Boolean(params.year);
  document.getElementById("list-range-filters").classList.toggle("d-none", manual);
  document.getElementById("list-manual-filters").classList.toggle("d-none", !manual);
  document.getElementById("list-month-group").classList.toggle("d-none", !(manual && params.month));

  document.querySelectorAll("[data-list-range]").forEach(pill => {
    pill.classList.toggle("active", (params.range || "all") === pill.dataset.listRange);
  });

  const yearSelect = document.getElementById("list-year");
  if (yearSelect && params.year) yearSelect.value = String(params.year);
  const monthSelect = document.getElementById("list-month");
  if (monthSelect && params.month) monthSelect.value = String(params.month);

  document.getElementById("list-empty")?.classList.add("d-none");
}

function renderHeader() {
  const header = document.getElementById("list-items-header");
  if (!header || !current) return;

  header.className = "list-header cols-list";
  header.innerHTML = `<span>#</span><span></span><span>${t(TYPE_COL_KEY[current.type])}</span><span class="num">${t("dashboard.playsHeader")}</span>`;
}

function renderItems() {
  const container = document.getElementById("list-items");
  if (!container || !current) return;

  renderHeader();

  container.className = "list-rows list-full";
  container.innerHTML = items.map((row, index) => ROW_BUILDERS[current.type](row, index)).join("");
  installImageFallbacks(container);
}

function renderPaging() {
  const more = document.getElementById("list-more");
  const count = document.getElementById("list-count");
  if (more) more.classList.toggle("d-none", !hasMore);
  if (count) {
    const unit = t(TYPE_UNIT_KEY[current.type]);
    const extra = current.params.artist ? ` · ${current.params.artist}` : "";
    count.textContent = total
      ? `${Number(total).toLocaleString()} ${unit}${extra}`
      : "";
  }
  document.getElementById("list-empty")?.classList.toggle("d-none", Boolean(items.length));
}

function buildQuery(offset, limit) {
  const { type, params } = current;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (["range", "year", "month", "artist"].includes(key) && value) qs.set(key, value);
  }
  qs.set("tzOffset", String(new Date().getTimezoneOffset()));
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  return `/api/top-list?type=${type}&${qs.toString()}`;
}

// The server enriches missing images/covers in the background; poll a few
// times in cachedOnly mode (instant, no network enrichment) to pick them up.
function scheduleCacheRefresh() {
  if (refreshTimer || refreshCount >= 5 || !current) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    refreshCount += 1;
    if (!current) return;
    try {
      const qs = new URLSearchParams(buildQuery(0, Math.max(items.length, PAGE_SIZE)).split("?")[1]);
      qs.set("cachedOnly", "1");
      const data = await fetchJSON(`/api/top-list?${qs.toString()}`, { cache: "no-store" });
      if (Array.isArray(data.items) && data.items.length) {
        items = data.items;
        renderItems();
      }
      if (data.enriching && refreshCount < 5) scheduleCacheRefresh();
    } catch {
      // best effort only
    }
  }, 3500);
}

async function loadListPage(offset, replace) {
  const loadId = ++loadCounter;
  abortController?.abort();
  abortController = new AbortController();

  try {
    const data = await fetchJSON(buildQuery(offset, PAGE_SIZE), {
      cache: "no-store",
      signal: abortController.signal
    });
    if (loadId !== loadCounter) return;

    if (replace) items = [];
    items = items.concat(data.items || []);
    total = Number(data.total || 0);
    hasMore = Boolean(data.hasMore);

    renderItems();
    renderPaging();
    if (data.enriching) scheduleCacheRefresh();
  } catch (error) {
    if (error.name === "AbortError" || loadId !== loadCounter) return;
    console.error("Error loading top list:", error);
    showToast(error.message || t("list.loadError"), "error");
  }
}

export async function loadList() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshCount = 0;
  const parsed = parseListHash() || { type: "artists", params: { range: "all" } };
  current = parsed;
  items = [];
  total = 0;
  hasMore = false;
  renderShell(parsed.type, parsed.params);
  await loadListPage(0, true);
}

function initListControls() {
  const yearSelect = document.getElementById("list-year");
  if (yearSelect) {
    const currentYear = new Date().getFullYear();
    for (let year = currentYear; year >= 2002; year--) {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      yearSelect.appendChild(option);
    }
    yearSelect.addEventListener("change", () => {
      if (!current) return;
      const params = { ...keepArtist(current.params), year: yearSelect.value };
      if (current.params.month) params.month = current.params.month;
      showTopList(current.type, params);
    });
  }

  document.getElementById("list-month")?.addEventListener("change", event => {
    if (!current) return;
    const month = event.target.value;
    const params = { ...keepArtist(current.params), year: document.getElementById("list-year").value };
    if (month) params.month = month;
    showTopList(current.type, params);
  });

  document.querySelectorAll("[data-list-range]").forEach(pill => {
    pill.addEventListener("click", () => {
      if (!current) return;
      const range = pill.dataset.listRange;
      if ((current.params.range || "all") === range) return;
      showTopList(current.type, { ...keepArtist(current.params), range });
    });
  });

  const more = document.getElementById("list-more");
  more?.addEventListener("click", () => {
    if (!current || !hasMore || more.disabled) return;
    // The server enriches each new row (Wikidata/Deezer lookups), which can
    // take a while on the NAS: lock the button so double-clicks don't abort
    // the in-flight request.
    more.disabled = true;
    more.innerHTML = `<i class="mdi mdi-loading mdi-spin"></i> ${t("common.loading")}`;
    loadListPage(items.length, false).finally(() => {
      more.disabled = false;
      more.innerHTML = `<span data-i18n="list.more">${t("list.more")}</span>`;
    });
  });
}

initListControls();
