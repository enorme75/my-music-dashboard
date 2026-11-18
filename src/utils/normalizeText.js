function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(remaster(?:ed)?|deluxe|edition|version|explicit|clean|live)\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLocaleLowerCase();
}

function isReasonableMatch(actual, expected) {
  if (!actual || !expected) return false;
  return actual === expected || actual.includes(expected) || expected.includes(actual);
}

module.exports = { normalize, isReasonableMatch };
