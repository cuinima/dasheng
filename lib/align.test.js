import { test } from "node:test";
import assert from "node:assert/strict";
import { align, tokenize, normalize, liveAlign, heardHasWord } from "./align.js";
import { PASSAGES } from "./passages.js";
import { mockCommits } from "./asr.js";
import { paceScore, wpm } from "./score.js";

test("tokenize keeps offsets so the page can re-insert punctuation", () => {
  const t = tokenize("Liberty, and");
  assert.deepEqual(t.map((w) => w.raw), ["Liberty", "and"]);
  assert.equal("Liberty, and".slice(t[0].end, t[1].start), ", ");
});

test("normalize folds case and apostrophes", () => {
  assert.equal(normalize("’Tis"), "tis");
});

test("a swapped word is one substitution, not a drop plus an insert", () => {
  const a = align("dedicated to the proposition that all", "dedicated to the proposal that all");
  assert.equal(a.substitutions.length, 1);
  assert.equal(a.substitutions[0].ref.raw, "proposition");
  assert.equal(a.substitutions[0].heard.raw, "proposal");
  assert.equal(a.missed.length, 0);
  assert.equal(a.matched.length, 5);
});

test("a skipped tail counts as missed, not substituted", () => {
  const a = align("one two three four", "one two");
  assert.deepEqual(a.missed.map((m) => m.ref.raw), ["three", "four"]);
  assert.equal(a.substitutions.length, 0);
});

test("mock ASR keeps the full sentence stream and does not drop the final word", () => {
  const text =
    "one two three four five six seven eight nine ten eleven twelve. Thirteen fourteen fifteen sixteen.";
  const { events, heard } = mockCommits(text);
  assert.ok(events.length > 0);
  assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t));
  assert.ok(heard.includes("twelve"));
  assert.ok(heard.includes("sixteen"), "最后一个词应保留，不应被故意吞掉");
});

test("heardHasWord ignores case and apostrophes", () => {
  assert.equal(heardHasWord("please say Liberty now", "Liberty"), true);
  assert.equal(heardHasWord("tis", "'Tis"), true);
  assert.equal(heardHasWord("four score", "equal"), false);
});

test("live align does not light later repeats while the prefix is still growing", () => {
  const passage = PASSAGES[0].text;
  const words = tokenize(passage);
  const spoken = words.map((w) => w.norm);
  const equalAt = words.findIndex((w) => w.norm === "equal");
  assert.ok(equalAt > 10);

  for (let n = 1; n < equalAt; n++) {
    const heard = spoken.slice(0, n).join(" ");
    const { marks, cursor } = liveAlign(passage, heard);
    assert.equal(cursor, n);
    assert.equal(marks[equalAt], null, `equal should stay unlit at prefix ${n}`);
    for (let i = 0; i < n; i++) assert.equal(marks[i], "ok");
    for (let i = n; i < marks.length; i++) assert.equal(marks[i], null);
  }
});

test("partial last-word prefixes do not steal later words or drop earlier oks", () => {
  const passage = PASSAGES[0].text;
  const words = tokenize(passage);
  const spoken = words.map((w) => w.norm);
  let previousOk = [];

  for (let n = 0; n < spoken.length; n++) {
    const committed = spoken.slice(0, n).join(" ");
    const next = spoken[n];
    for (let k = 1; k <= next.length; k++) {
      const partial = next.slice(0, k);
      const heard = committed ? `${committed} ${partial}` : partial;
      const { marks } = liveAlign(passage, heard);
      const okNow = marks.map((m, i) => (m === "ok" ? i : -1)).filter((i) => i >= 0);
      for (const i of previousOk) {
        assert.equal(marks[i], "ok", `${words[i].raw} lost ok on "${heard}"`);
      }
      const far = marks.findIndex((m, i) => m && i > n + 1);
      assert.equal(far, -1, `far word ${words[far]?.raw} lit on "${heard}"`);
      if (k === next.length) previousOk = okNow;
    }
  }
});

test("Gettysburg mock stream never un-lights a word or paints ahead of the cursor", () => {
  const passage = PASSAGES[0].text;
  const { events } = mockCommits(passage);
  let heard = "";
  let previous = [];
  for (const ev of events) {
    heard = heard ? `${heard} ${ev.text}` : ev.text;
    const { marks, cursor } = liveAlign(passage, heard);
    for (let i = 0; i < previous.length; i++) {
      if (previous[i] && previous[i] !== marks[i] && !(previous[i] === "doubt" && marks[i] === "ok")) {
        assert.fail(`${tokenize(passage)[i].raw} flickered ${previous[i]} -> ${marks[i]}`);
      }
    }
    marks.forEach((m, i) => {
      if (m) assert.ok(i <= cursor, "marked word is not ahead of cursor");
    });
    previous = marks;
  }
});

test("pace is arithmetic: 150 wpm is the peak", () => {
  assert.equal(wpm({ words: 150, durationMs: 60000 }), 150);
  assert.equal(paceScore({ words: 150, durationMs: 60000 }), 100);
  assert.ok(paceScore({ words: 75, durationMs: 60000 }) < 80);
  assert.ok(paceScore({ words: 150, durationMs: 60000, pauses: 4 }) < 90);
});
