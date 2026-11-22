import { fetchJSON } from "./api.js";
import { t } from "./i18n.js";
import { scrobbleItemHTML, bindScrobbleDelete } from "./scrobbles.js";
import { renderAlbums } from "./albums.js";
import { renderTopArtists } from "./artists.js";
import { renderTopSongs } from "./topSongs.js";
import { renderSummary } from "./summary.js";
import { formatTimestampDate } from "./dates.js";
import { installImageFallback, safeImageUrl } from "./dom.js";
import { showToast } from "./toast.js";

const HOME_SCROBBLE_LIMIT = 20;
const RANGE_BY_PILL = {
  day: "day",
  week: "week",
  month: "month",
  year: "year"
};
const DEFAULT_PILL = "day";

const HOME_SUMMARY_IDS = {
  plays: "home-plays",
  artistsCount: "home-artists-count",
  avg: "home-avg",
  avgLabel: "home-avg-label",
  hours: "home-hours",
  playsTrend: "home-plays-trend",
  avgTrend: "home-avg-trend",
  hoursTrend: "home-hours-trend"
};

const MODULES = {
  albums: {
    elementId: "home-albums-module",
    render: data => renderAlbums(data.topAlbums, "home-albums-grid")
  },
  artists:
  {
    elementId: "home-artists-module",
    render: data => renderTopArtists(data.topArtists, {
      podiumId: "home-artists-podium",
      restId: "home-artists"
    })
  },
  songs: {
    elementId: "home-songs-module",
    render: data => renderTopSongs(data.topTracks, {
      podiumId: "home-songs-podium",
      listId: "home-songs"
    })
  }
};

const activePills = { albums: DEFAULT_PILL, artists: DEFAULT_PILL, songs: DEFAULT_PILL };
const loadCounters = { albums: 0, artists: 0, songs: 0 };
const abortControllers = {};

let homeLoadCounter = 0;
let homeAbortController = null;

export function isHomeVisible() {
  return !document.getElementById("home-view")?.classList.contains("d-none");
}

function moduleQuery(module) {
  const params = new URLSearchParams();
  const range = RANGE_BY_PILL[activePills[module]];
  if (range) params.append("range", range);
  params.set("tzOffset", String(new Date().getTimezoneOffset()));
  return `?${params.toString()}`;
}

function renderHomeHeader(stats = {}) {
  const avatar = document.getElementById("home-avatar");
  if (avatar) {
    avatar.src = safeImageUrl(stats.avatar);
    installImageFallback(avatar);
  }

  document.getElementById("home-username").textContent =
    stats.username || t("account.user");

  const memberSince = document.getElementById("home-member-since");
  memberSince.textContent = stats.joinedDate
    ? t("home.memberSince", { date: formatTimestampDate(stats.joinedDate * 1000) })
    : "";

  const format = value => Number(value || 0).toLocaleString();
  const totals = document.getElementById("home-totals");
  if (totals) {
    totals.textContent = t("home.totalsLine", {
      scrobbles: format(stats.totalScrobbles),
      artists: format(stats.uniqueArtists),
      albums: format(stats.uniqueAlbums),
      tracks: format(stats.uniqueTracks)
    });
  }
}

async function loadHomeHeader(signal) {
  const stats = await fetchJSON("/api/user-stats", { cache: "no-store", signal });
  renderHomeHeader(stats);
}

async function loadHomeToday(signal) {
  const params = new URLSearchParams();
  params.set("range", "day");
  params.set("tzOffset", String(new Date().getTimezoneOffset()));

  const data = await fetchJSON(`/api/dashboard?${params.toString()}`, {
    cache: "no-store",
    signal
  });
  renderSummary(data.summary || {}, HOME_SUMMARY_IDS);
}

async function loadHomeScrobbles(signal) {
  const data = await fetchJSON(
    `/api/recent-scrobbles?page=1&limit=${HOME_SCROBBLE_LIMIT}`,
    { cache: "no-store", signal }
  );

  const list = document.getElementById("home-scrobbles-list");
  list.innerHTML = (data.tracks || [])
    .map(scrobble => scrobbleItemHTML(scrobble, { compact: true }))
    .join("");
}

export function loadHomeModule(module) {
  const config = MODULES[module];
  if (!config) return;

  const loadId = ++loadCounters[module];
  abortControllers[module]?.abort();
  abortControllers[module] = new AbortController();

  const element = document.getElementById(config.elementId);
  element?.classList.add("is-loading");

  fetchJSON(`/api/dashboard${moduleQuery(module)}`, {
    cache: "no-store",
    signal: abortControllers[module].signal
  })
    .then(data => {
      if (loadId !== loadCounters[module]) return;
      config.render(data);
    })
    .catch(error => {
      if (error.name === "AbortError" || loadId !== loadCounters[module]) return;
      console.error(`Error loading home "${module}":`, error);
      showToast(error.message || t("home.topsError"), "error");
    })
    .finally(() => {
      if (loadId !== loadCounters[module]) return;
      element?.classList.remove("is-loading");
    });
}

function setActivePills() {
  document.querySelectorAll("[data-module]").forEach(group => {
    const module = group.dataset.module;
    group.querySelectorAll("[data-home-range]").forEach(pill => {
      pill.classList.toggle("active", pill.dataset.homeRange === activePills[module]);
    });
  });
}

export function loadHome() {
  const loadId = ++homeLoadCounter;
  homeAbortController?.abort();
  homeAbortController = new AbortController();

  const loading = document.getElementById("home-loading");
  loading.style.display = "flex";

  const jobs = [
    loadHomeHeader(homeAbortController.signal).catch(error => {
      if (error.name === "AbortError" || loadId !== homeLoadCounter) return;
      console.error("Error loading home header:", error);
      showToast(error.message || t("home.loadError"), "error");
    }),
    loadHomeToday(homeAbortController.signal).catch(error => {
      if (error.name === "AbortError" || loadId !== homeLoadCounter) return;
      console.error("Error loading home today stats:", error);
      showToast(error.message || t("home.loadError"), "error");
    }),
    loadHomeScrobbles(homeAbortController.signal).catch(error => {
      if (error.name === "AbortError" || loadId !== homeLoadCounter) return;
      console.error("Error loading home scrobbles:", error);
      showToast(error.message || t("home.loadError"), "error");
    })
  ];

  if (loadId === homeLoadCounter) {
    for (const module of Object.keys(MODULES)) loadHomeModule(module);
  }

  Promise.allSettled(jobs).then(() => {
    if (loadId === homeLoadCounter) loading.style.display = "none";
  });
}

function initHome() {
  document.querySelectorAll("[data-module]").forEach(group => {
    group.querySelectorAll("[data-home-range]").forEach(pill => {
      pill.addEventListener("click", () => {
        const module = group.dataset.module;
        if (pill.dataset.homeRange === activePills[module]) return;
        activePills[module] = pill.dataset.homeRange;
        setActivePills();
        loadHomeModule(module);
      });
    });
  });

  bindScrobbleDelete(document.getElementById("home-scrobbles-list"));
  setActivePills();
}

initHome();
