import { fetchJSON } from "./api.js";
import { t } from "./i18n.js";
import { escapeAttribute, escapeHTML } from "./dom.js";
import { showToast } from "./toast.js";

const QUEUE_STORAGE_KEY = "ma.queueId";
const AVAILABILITY_DEBOUNCE_MS = 400;

let statusLoaded = false;
let configured = false;
let requestedKeys = new Set();
let availabilityTimer = null;
let observer = null;

export function playButtonHtml(artist, track, { large = false } = {}) {
  if (!artist || !track) return "";
  const label = t("player.play");
  return `
    <button
      type="button"
      class="play-btn${large ? " play-btn-lg" : ""}"
      data-play-artist="${escapeAttribute(artist)}"
      data-play-track="${escapeAttribute(track)}"
      title="${escapeAttribute(label)}"
      aria-label="${escapeAttribute(label)}"
    >
      <i class="mdi mdi-play"></i>
    </button>
  `;
}

export function playAlbumButtonHtml(artist, album, { large = false, withLabel = false } = {}) {
  if (!artist || !album) return "";
  const label = t("player.playAlbum");
  return `
    <button
      type="button"
      class="play-btn play-album-btn${large ? " play-btn-lg" : ""}${withLabel ? " with-label" : ""}"
      data-play-album-artist="${escapeAttribute(artist)}"
      data-play-album-name="${escapeAttribute(album)}"
      title="${escapeAttribute(label)}"
      aria-label="${escapeAttribute(label)}"
    >
      <i class="mdi mdi-play"></i>
      ${withLabel ? `<span class="play-btn-label">${escapeHTML(label)}</span>` : ""}
    </button>
  `;
}

function availabilityKey(artist, track) {
  return `${artist} ${track}`;
}

function albumAvailabilityKey(artist, album) {
  return `album:${artist} ${album}`;
}

export function getSelectedQueueId() {
  const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
  if (saved) return saved;
  return document.getElementById("ma-player-select")?.value || "";
}

function setButtonState(button, state) {
  const icon = button.querySelector(".mdi");
  button.classList.remove("is-loading", "is-playing");
  if (icon) icon.className = "mdi";

  if (state === "loading") {
    button.classList.add("is-loading");
    if (icon) icon.classList.add("mdi-loading", "mdi-spin");
  } else if (state === "playing") {
    button.classList.add("is-playing");
    if (icon) icon.classList.add("mdi-check");
    setTimeout(() => {
      button.classList.remove("is-playing");
      if (icon && button.contains(icon)) icon.classList.add("mdi-play");
    }, 2000);
  } else if (icon) {
    icon.classList.add("mdi-play");
  }
}

function markUnavailable(button, labelKey = "player.notInLibrary") {
  button.dataset.avail = "0";
  button.classList.add("is-disabled");
  button.disabled = true;
  button.title = t(labelKey);
  button.setAttribute("aria-label", t(labelKey));
}

function hideAllPlayButtons() {
  document.querySelectorAll(".play-btn").forEach(button => button.classList.add("d-none"));
}

function playTargetFromButton(button) {
  if (button.classList.contains("play-album-btn")) {
    const artist = button.dataset.playAlbumArtist;
    const album = button.dataset.playAlbumName;
    if (!artist || !album) return null;
    return {
      kind: "album",
      artist,
      album,
      endpoint: "/api/play/album",
      payload: { artist, album },
      missingLabelKey: "player.albumNotInLibrary",
      sourceOf: data => data.album?.source
    };
  }

  const artist = button.dataset.playArtist;
  const track = button.dataset.playTrack;
  if (!artist || !track) return null;
  return {
    kind: "track",
    artist,
    track,
    endpoint: "/api/play",
    payload: { artist, track },
    missingLabelKey: "player.notInLibrary",
    sourceOf: data => data.track?.source
  };
}

async function onPlayClick(event) {
  const button = event.target.closest(".play-btn");
  if (!button || button.disabled || button.classList.contains("is-loading")) return;

  event.preventDefault();
  event.stopPropagation();

  const target = playTargetFromButton(button);
  if (!target) return;

  const queueId = getSelectedQueueId();
  if (!queueId) {
    showToast(t("player.queueRequired"), "error");
    return;
  }

  setButtonState(button, "loading");
  try {
    const data = await fetchJSON(target.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target.payload, queue_id: queueId })
    });
    setButtonState(button, "playing");
    const playerName = data.player_name || data.queue_id;
    const source = target.sourceOf(data);
    showToast(
      source && source !== "library"
        ? t("player.viaProvider", { player: playerName, provider: source })
        : t("player.nowPlayingOn", { player: playerName }),
      "success"
    );
  } catch (error) {
    if (error.status === 404 || error.data?.code === "not_found") {
      markUnavailable(button, target.missingLabelKey);
      showToast(t(target.missingLabelKey), "info");
    } else if (error.status === 503 || error.data?.code === "not_configured") {
      showToast(t("player.notConfigured"), "error");
    } else if (error.status === 400 || error.data?.code === "queue_required") {
      showToast(t("player.queueRequired"), "error");
    } else {
      console.error("Music Assistant play failed:", error);
      showToast(t("player.error"), "error");
    }
  } finally {
    if (button.classList.contains("is-loading")) setButtonState(button, "idle");
  }
}

async function refreshTrackAvailability(buttons) {
  const fresh = buttons.filter(button =>
    !requestedKeys.has(availabilityKey(button.dataset.playArtist, button.dataset.playTrack))
  );
  if (!fresh.length) return;

  const tracks = fresh.map(button => ({
    artist: button.dataset.playArtist,
    track: button.dataset.playTrack
  }));

  try {
    const data = await fetchJSON("/api/play/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks })
    });

    if (!data.configured) {
      hideAllPlayButtons();
      return;
    }

    const results = data.results || {};
    buttons.forEach(button => {
      const key = availabilityKey(button.dataset.playArtist, button.dataset.playTrack);
      if (results[key] === false) markUnavailable(button);
      else button.dataset.avail = "1";
    });
    fresh.forEach(button => requestedKeys.add(availabilityKey(button.dataset.playArtist, button.dataset.playTrack)));
  } catch (error) {
    // Availability is best-effort: keep buttons clickable, the play endpoint
    // will answer 404 with a proper toast if the track is really missing.
    console.warn("Music Assistant availability check failed:", error);
  }
}

async function refreshAlbumAvailability(buttons) {
  const fresh = buttons.filter(button =>
    !requestedKeys.has(albumAvailabilityKey(button.dataset.playAlbumArtist, button.dataset.playAlbumName))
  );
  if (!fresh.length) return;

  const albums = fresh.map(button => ({
    artist: button.dataset.playAlbumArtist,
    album: button.dataset.playAlbumName
  }));

  try {
    const data = await fetchJSON("/api/play/album/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ albums })
    });

    if (!data.configured) {
      hideAllPlayButtons();
      return;
    }

    const results = data.results || {};
    buttons.forEach(button => {
      const key = albumAvailabilityKey(button.dataset.playAlbumArtist, button.dataset.playAlbumName);
      if (results[key] === false) markUnavailable(button, "player.albumNotInLibrary");
      else button.dataset.avail = "1";
    });
    fresh.forEach(button => requestedKeys.add(albumAvailabilityKey(button.dataset.playAlbumArtist, button.dataset.playAlbumName)));
  } catch (error) {
    console.warn("Music Assistant album availability check failed:", error);
  }
}

async function refreshAvailability() {
  if (!statusLoaded) return;

  const trackButtons = [...document.querySelectorAll(".play-btn:not(.play-album-btn):not([data-avail])")];
  const albumButtons = [...document.querySelectorAll(".play-album-btn:not([data-avail])")];
  if (!trackButtons.length && !albumButtons.length) return;

  if (!configured) {
    hideAllPlayButtons();
    return;
  }

  await Promise.all([
    refreshTrackAvailability(trackButtons),
    refreshAlbumAvailability(albumButtons)
  ]);
}

function scheduleAvailability() {
  clearTimeout(availabilityTimer);
  availabilityTimer = setTimeout(refreshAvailability, AVAILABILITY_DEBOUNCE_MS);
}

async function loadPlayers() {
  const wrapper = document.getElementById("ma-player-wrapper");
  const select = document.getElementById("ma-player-select");

  try {
    const data = await fetchJSON("/api/player/status", { cache: "no-store" });
    configured = Boolean(data.configured);
    const players = Array.isArray(data.players) ? data.players : [];

    if (wrapper && select) {
      if (!configured || !players.length) {
        wrapper.classList.add("d-none");
      } else {
        wrapper.classList.remove("d-none");
        select.innerHTML = players.map(player =>
          `<option value="${escapeAttribute(player.queue_id)}">${escapeHTML(player.name)}</option>`
        ).join("");

        const saved = localStorage.getItem(QUEUE_STORAGE_KEY);
        if (saved && players.some(player => player.queue_id === saved)) {
          select.value = saved;
        } else if (data.defaultQueueId && players.some(player => player.queue_id === data.defaultQueueId)) {
          select.value = data.defaultQueueId;
        }
      }
    }
  } catch (error) {
    configured = false;
    wrapper?.classList.add("d-none");
    console.warn("Music Assistant status unavailable:", error);
  } finally {
    statusLoaded = true;
    if (select) {
      select.onchange = () => {
        if (select.value) localStorage.setItem(QUEUE_STORAGE_KEY, select.value);
      };
    }
    refreshAvailability();
  }
}

export function initPlayer() {
  loadPlayers();
  document.addEventListener("click", onPlayClick);

  observer = new MutationObserver(scheduleAvailability);
  observer.observe(document.body, { childList: true, subtree: true });
}
