let overlay = null;
let image = null;
let textPanel = null;
let textTitle = null;
let textBody = null;

function closeLightbox() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
  image.removeAttribute("src");
  image.hidden = false;
  textPanel.hidden = true;
}

function buildOverlay() {
  overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.hidden = true;
  overlay.addEventListener("click", closeLightbox);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "image-lightbox-close";
  closeButton.innerHTML = '<i class="mdi mdi-close"></i>';
  closeButton.addEventListener("click", closeLightbox);

  image = document.createElement("img");
  image.className = "image-lightbox-img";
  image.alt = "";

  textPanel = document.createElement("div");
  textPanel.className = "image-lightbox-text";
  textPanel.hidden = true;
  textPanel.addEventListener("click", event => event.stopPropagation());

  textTitle = document.createElement("h3");
  textTitle.className = "image-lightbox-text-title";

  textBody = document.createElement("div");
  textBody.className = "image-lightbox-text-body";

  textPanel.append(textTitle, textBody);
  overlay.append(image, textPanel, closeButton);
  document.body.appendChild(overlay);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeLightbox();
  });
}

const LASTFM_SIZE_PATH = /\/i\/u\/\d+x\d+\//;

function upgradedSource(src) {
  if (!LASTFM_SIZE_PATH.test(src)) return src;
  return src.replace(LASTFM_SIZE_PATH, "/i/u/");
}

function displaySource(src, fallback) {
  image.onload = () => {
    image.onerror = null;
  };
  image.onerror = () => {
    if (image.getAttribute("src") !== fallback) {
      image.src = fallback;
    } else {
      image.onerror = null;
    }
  };
  image.src = src;
}

function openLightbox(source) {
  const src = source?.currentSrc || source?.src;
  if (!src) return;
  if (!overlay) buildOverlay();

  displaySource(upgradedSource(src), src);
  image.alt = source?.alt || "";
  image.hidden = false;
  textPanel.hidden = true;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

export function openTextOverlay(title, text) {
  if (!overlay) buildOverlay();
  textTitle.textContent = title || "";
  textBody.textContent = text || "";
  image.hidden = true;
  textPanel.hidden = false;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

export function initLightbox() {
  for (const id of ["artist-image", "album-image"]) {
    document.getElementById(id)?.addEventListener("click", event => {
      openLightbox(event.currentTarget);
    });
  }
}
