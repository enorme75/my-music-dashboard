import { fetchJSON } from "./api.js";
import { t } from "./i18n.js";
import { renderAlbums } from "./albums.js";
import { artistRow } from "./artists.js";
import { songRow } from "./topSongs.js";
import { installImageFallbacks } from "./dom.js";
import { showToast } from "./toast.js";

// Full "top" list pages reached through the "Voir tout" links:
// hash #list/{albums|artists|tracks}?range=day|week|month|year|all
//                          or ?year=2026[&month=11]
//                          or ?artist=<name> (top tracks of an artist page)
const PAGE_SIZE = 50;
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

function renderItems() {
  const container = document.getElementById("list-items");
  const header = document.getElementById("list-items-header");
  if (!container) return;

  header?.classList.toggle("d-none", current.type !== "tracks");

  if (current.type === "albums") {
    container.className = "albums-scroll";
    renderAlbums(items, "list-items");
    return;
  }

  if (current.type === "artists") {
    container.className = "top-list top-rest";
    container.innerHTML = items.map((row, index) => artistRow(row, index)).join("");
  } else {
    container.className = "top-songs-list";
    container.innerHTML = items.map((row, index) => songRow(row, index)).join("");
  }
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

async function loadListPage(offset, replace) {
  const loadId = ++loadCounter;
  abortController?.abort();
  abortController = new AbortController();

  const { type, params } = current;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (["range", "year", "month", "artist"].includes(key) && value) qs.set(key, value);
  }
  qs.set("tzOffset", String(new Date().getTimezoneOffset()));
  qs.set("limit", String(PAGE_SIZE));
  qs.set("offset", String(offset));

  try {
    const data = await fetchJSON(`/api/top-list?type=${type}&${qs.toString()}`, {
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
  } catch (error) {
    if (error.name === "AbortError" || loadId !== loadCounter) return;
    console.error("Error loading top list:", error);
    showToast(error.message || t("list.loadError"), "error");
  }
}

export async function loadList() {
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

  document.getElementById("list-more")?.addEventListener("click", () => {
    if (!current || !hasMore) return;
    loadListPage(items.length, false);
  });
}

initListControls();
