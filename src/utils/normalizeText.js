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

// Score a normalized candidate against a normalized expected value:
// 3 = exact, 2 = same words (one side's words are all whole words of the
// other side, so "nick drake" matches "nick becky drake" but NOT
// "nicked drake" nor "runddans"), 0 = no match.
function scoreMatch(actual, expected) {
  if (!actual || !expected) return 0;
  if (actual === expected) return 3;

  const actualTokens = actual.split(" ").filter(Boolean);
  const expectedTokens = expected.split(" ").filter(Boolean);
  if (!actualTokens.length || !expectedTokens.length) return 0;

  const actualSet = new Set(actualTokens);
  const expectedSet = new Set(expectedTokens);

  if (expectedTokens.every(token => actualSet.has(token))) return 2;
  if (actualTokens.every(token => expectedSet.has(token))) return 2;
  return 0;
}

module.exports = { normalize, isReasonableMatch, scoreMatch };
