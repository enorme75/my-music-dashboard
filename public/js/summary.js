import { t } from "./i18n.js";
import { escapeHTML } from "./dom.js";

export const DEFAULT_SUMMARY_IDS = {
  plays: "plays",
  artistsCount: "artists-count",
  avg: "avg",
  avgLabel: "avg-label",
  hours: "hours",
  playsTrend: "plays-trend",
  avgTrend: "avg-trend",
  hoursTrend: "hours-trend"
};

// elementId -> "year" | "filter", so a locale change re-renders every
// registered label (stats page and home page each have their own).
const avgLabelScopes = new Map();

function applyAvgLabel(elementId, scope) {
  const element = document.getElementById(elementId);
  if (!element) return;

  if (scope === "year") {
    element.removeAttribute("data-i18n");
    element.innerHTML = `
      <span>${escapeHTML(t("dashboard.dailyAverageYearMain"))}</span><br>
      <small class="avg-label-detail">${escapeHTML(t("dashboard.dailyAverageYearDetail"))}</small>
    `;
    return;
  }

  element.dataset.i18n = "dashboard.dailyAverage";
  element.textContent = t("dashboard.dailyAverage");
}

window.addEventListener("localechange", () => {
  for (const [elementId, scope] of avgLabelScopes) applyAvgLabel(elementId, scope);
});

function renderTrend(elementId, metric, label, note) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const resolvedLabel = metric?.labelKey
    ? t(`comparison.${metric.labelKey}`)
    : metric?.label || label;

  element.className = "metric-trend";

  if (!metric || !resolvedLabel) {
    element.innerHTML = `<i class="mdi mdi-history"></i> ${note || t("dashboard.allHistory")}`;
    return;
  }

  const direction = metric.direction || "same";
  const icon = direction === "up"
    ? "mdi-arrow-up"
    : direction === "down"
      ? "mdi-arrow-down"
      : "mdi-minus";
  const value = metric.percent === null
    ? t("dashboard.new")
    : `${Math.abs(Number(metric.percent) || 0).toLocaleString(undefined, {
        maximumFractionDigits: 1
      })}%`;

  element.classList.add(direction);
  element.innerHTML = `<i class="mdi ${icon}"></i> ${value} vs ${resolvedLabel}`;
}

export function renderSummary(data = {}, ids = DEFAULT_SUMMARY_IDS) {
  const avgScope = data.avgPerDayScope === "year" ? "year" : "filter";
  avgLabelScopes.set(ids.avgLabel, avgScope);
  applyAvgLabel(ids.avgLabel, avgScope);

  document.getElementById(ids.hours).textContent = Number(data.totalMinutes || 0).toLocaleString();
  document.getElementById(ids.plays).textContent = Number(data.totalPlays || 0).toLocaleString();
  document.getElementById(ids.artistsCount).textContent = Number(data.totalArtists || 0).toLocaleString();
  document.getElementById(ids.avg).textContent = Number(data.avgPerDay || 0).toLocaleString(undefined, {
    maximumFractionDigits: 1
  });

  const comparisonLabel = data.comparison?.labelKey
    ? t(`comparison.${data.comparison.labelKey}`)
    : data.comparison?.label;
  const comparisonNote = data.comparisonNoteKey
    ? t(`comparison.${data.comparisonNoteKey}`)
    : data.comparisonNote;

  renderTrend(
    ids.hoursTrend,
    data.comparison?.totalMinutes,
    comparisonLabel,
    comparisonNote
  );
  renderTrend(
    ids.playsTrend,
    data.comparison?.totalPlays,
    comparisonLabel,
    comparisonNote
  );
  renderTrend(
    ids.avgTrend,
    data.comparison?.avgPerDay,
    comparisonLabel,
    comparisonNote
  );
}
