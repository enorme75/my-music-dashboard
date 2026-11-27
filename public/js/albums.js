import { t } from "./i18n.js";
import { renderCover, initCoverUploads } from "./coverUploader.js";
import { showAlbum } from "./albumPage.js";
import { escapeAttribute, escapeHTML, safeImageUrl } from "./dom.js";

// One vertical list row (used by the #list/albums "voir tout" page, ISO the
// artists/tracks list rows). The whole row opens the album page
// (data-album-artist), the artist link opens the artist page.
export function albumRow(album, index) {
  return `
    <div class="top-row" data-album-artist="${escapeAttribute(album.artist)}" data-album-name="${escapeAttribute(album.album)}">
      <span class="rank">${index + 1}</span>
      <img
        src="${escapeAttribute(safeImageUrl(album.album_image, "/images/cover-placeholder.svg"))}"
        alt="${escapeAttribute(album.album)}"
        class="cover list-cover"
        loading="lazy"
        decoding="async"
        data-fallback="/images/cover-placeholder.svg"
      />
      <div class="meta">
        <strong>${escapeHTML(album.album)}</strong>
        <a
          class="music-link"
          href="${escapeAttribute(album.url || "#")}"
          target="_blank"
          rel="noopener noreferrer"
          title="${escapeAttribute(t("dashboard.openAlbumOnListenbrainz"))}"
        >
          <i class="mdi mdi-open-in-new"></i>
        </a>
        <a class="music-link song-artist" href="#artist/${encodeURIComponent(album.artist)}" title="${escapeAttribute(t("artist.viewPage"))}">${escapeHTML(album.artist)}</a>
        <small>${Number(album.plays).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}</small>
      </div>
    </div>
  `;
}

export function renderAlbums(albums = [], containerId = "albums-grid") {
  const grid = document.getElementById(containerId);
  const fragment = document.createDocumentFragment();

  grid.innerHTML = "";

  for (const album of albums) {
    const card = document.createElement("div");
    card.className = "album-card";
    card.innerHTML = `
      ${renderCover({
        image: album.album_image,
        artist: album.artist,
        album: album.album,
        size: "large"
      })}
      <a
        class="music-link album-title-link"
        data-album-artist="${escapeAttribute(album.artist)}"
        data-album-name="${escapeAttribute(album.album)}"
        title="${t("album.viewPage")}"
      >
        <strong>${escapeHTML(album.album)}</strong>
      </a>
      <a
        class="music-link album-artist-link"
        data-artist="${escapeAttribute(album.artist)}"
        title="${t("artist.viewPage")}"
      >${escapeHTML(album.artist)}</a>
      <small>${Number(album.plays).toLocaleString()} ${escapeHTML(t("common.playsUnit"))}</small>
    `;

    card.querySelector(".cover-wrapper")?.addEventListener("click", event => {
      if (event.target.matches("input, .cover-overlay, .cover-overlay *")) return;

      showAlbum(album.artist, album.album);
    });

    fragment.appendChild(card);
  }

  grid.appendChild(fragment);
  initCoverUploads();
}
