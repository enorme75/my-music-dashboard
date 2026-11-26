const test = require("node:test");
const assert = require("node:assert/strict");

const { candidateTitles, hasMusicalTitleSuffix, isDisambiguation, looksMusical, titleMatchesName } = require("../src/services/wikipedia");

test("looksMusical accepts artist intros", () => {
  assert.equal(looksMusical("Nicholas Rodney Drake was an English musician and singer-songwriter."), true);
  assert.equal(looksMusical("Phoenix are an indie pop band from Versailles, France."), true);
  assert.equal(looksMusical("Spectrum were an English space rock band formed in 1972."), true);
});

test("looksMusical rejects generic homonym articles", () => {
  assert.equal(looksMusical("A spectrum (pl.: spectra or spectrums) is a set of related ideas, objects, or properties whose features overlap."), false);
  // "band" alone is not a musical hint (electromagnetic "band of wavelengths")
  assert.equal(looksMusical("The visible spectrum is the band of the electromagnetic spectrum that is visible to the human eye."), false);
  assert.equal(looksMusical("Phoenix most commonly refers to: Phoenix (mythology), an immortal bird..."), false);
  assert.equal(looksMusical(""), false);
});

test("isDisambiguation detects may-refer-to pages", () => {
  assert.equal(isDisambiguation("Spectrum (disambiguation)", ""), true);
  assert.equal(isDisambiguation("Phoenix", "Phoenix may refer to: ..."), true);
  assert.equal(isDisambiguation("Phoenix", "Phoenix most commonly refers to: ..."), true);
  assert.equal(isDisambiguation("Spectrum (band)", "Spectrum were an English space rock band."), false);
});

test("hasMusicalTitleSuffix detects suffixed article titles", () => {
  assert.equal(hasMusicalTitleSuffix("Spectrum (band)"), true);
  assert.equal(hasMusicalTitleSuffix("Phoenix (French band)"), false); // not a plain suffix
  assert.equal(hasMusicalTitleSuffix("Nick Drake"), false);
});

test("titleMatchesName is strict about the leading name", () => {
  assert.equal(titleMatchesName("Nick Drake", "Nick Drake"), true);
  assert.equal(titleMatchesName("Spectrum (band)", "Spectrum"), true);
  // "River Phoenix" must NOT match an artist named "Phoenix"
  assert.equal(titleMatchesName("River Phoenix", "Phoenix"), false);
  assert.equal(titleMatchesName("Phoenix (French band)", "Phoenix"), true);
});

test("candidateTitles derives country hints from the MB disambiguation", () => {
  assert.deepEqual(
    candidateTitles("Spectrum", "UK space rock/psychedelic band").slice(0, 3),
    ["Spectrum (UK band)", "Spectrum (UK group)", "Spectrum (UK musician)"]
  );
  assert.ok(candidateTitles("Phoenix", "French indie band").includes("Phoenix (band)"));
  assert.ok(candidateTitles("Nick Drake", null).includes("Nick Drake (band)"));
});
