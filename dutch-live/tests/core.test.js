// Tests for the logic that sits between the Dutch speech recognizer and the
// English the three of you hear. The point of the whole page is that what a
// performer says reaches your ear once, in order, and not too late. Each test
// below checks one way that could fail. Run with: node --test
//
// Times are in milliseconds and are made up; the code never reads a clock
// itself, so the tests can say exactly when each word "arrived".

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

// The recognizer reports the whole transcript of its current session each
// time it hears more, so a test feeds growing prefixes of a sentence.
function feedWords(seg, words, t0, step) {
  const out = [];
  for (let i = 1; i <= words.length; i++) {
    out.push(...seg.update(words.slice(0, i).join(" "), t0 + i * step));
  }
  return out;
}
const texts = (segs) => segs.map((s) => s.text);
const words = (s) => s.trim().split(/\s+/);

// ---- segmenter: recognizer transcript -> pieces to translate ----------

test("a sentence followed by a pause is sent once, in full", () => {
  const seg = C.createSegmenter({ silenceMs: 800, maxWords: 22, keepTail: 3 });
  const s = "ik heb gisteren mijn fiets in de gracht gegooid";
  const during = feedWords(seg, words(s), 0, 100);
  // Nothing goes out while the speaker is still talking ...
  assert.deepEqual(during, []);
  // ... nor before the pause has lasted silenceMs ...
  assert.deepEqual(seg.tick(900 + 700), []);
  // ... and then the whole sentence goes out exactly once.
  assert.deepEqual(texts(seg.tick(900 + 800)), [s]);
  assert.deepEqual(seg.tick(900 + 5000), []);
});

test("two sentences in one session become two pieces that add up to the transcript", () => {
  const seg = C.createSegmenter({ silenceMs: 800 });
  const s1 = "mijn moeder komt uit Friesland";
  const s2 = "en daar praten ze anders";
  feedWords(seg, words(s1), 0, 100);
  const a = seg.tick(2000);
  feedWords(seg, words(s1 + " " + s2), 2000, 100);
  const b = seg.tick(5000);
  assert.deepEqual(texts([...a, ...b]), [s1, s2]);
});

test("the recognizer's correction of words not yet sent is what gets sent", () => {
  const seg = C.createSegmenter({ silenceMs: 800 });
  seg.update("ik heb gister en", 100);
  seg.update("ik heb gisteren mijn fiets", 300);
  assert.deepEqual(texts(seg.tick(1200)), ["ik heb gisteren mijn fiets"]);
});

test("a final result from the recognizer is sent at once, without waiting for silence", () => {
  const seg = C.createSegmenter({ silenceMs: 800 });
  seg.update("dat was het", 100);
  assert.deepEqual(texts(seg.update("dat was het", 150, true)), ["dat was het"]);
  assert.deepEqual(seg.tick(5000), []);
});

test("a long run without a pause is cut at maxWords, holding back the last keepTail words", () => {
  // A fast comic may not pause for 30 words. Without a cut you would hear
  // nothing until the pause. The last few words are held back because the
  // recognizer is still most likely to revise them.
  const seg = C.createSegmenter({ silenceMs: 800, maxWords: 22, keepTail: 3 });
  const run = Array.from({ length: 30 }, (_, i) => "w" + (i + 1));
  const during = feedWords(seg, run, 0, 100);
  assert.equal(during.length, 1);
  assert.deepEqual(words(during[0].text), run.slice(0, 19));
  const after = seg.tick(3000 + 800);
  // Every word goes out exactly once, in order.
  assert.deepEqual(words([...during, ...after].map((s) => s.text).join(" ")), run);
});

test("a recognizer restart sends the unfinished words, and the next session starts from zero", () => {
  // iPhone speech recognition stops every so often and the page restarts it.
  // The new session's transcript starts empty, so counting must restart too.
  const seg = C.createSegmenter({ silenceMs: 800 });
  feedWords(seg, ["een", "twee", "drie"], 0, 100);
  const flushed = seg.reset(400);
  feedWords(seg, ["vier", "vijf"], 500, 100);
  const later = seg.tick(2000);
  assert.deepEqual(texts([...flushed, ...later]), ["een twee drie", "vier vijf"]);
});

test("words already sent are not sent again when the recognizer rewrites them", () => {
  const seg = C.createSegmenter({ silenceMs: 800 });
  seg.update("een twee drie", 100);
  assert.deepEqual(texts(seg.tick(1000)), ["een twee drie"]);
  seg.update("Een twee drie vier", 1100);
  assert.deepEqual(texts(seg.tick(2000)), ["vier"]);
});

test("each piece records when its first word was heard, so the page can show the delay", () => {
  const seg = C.createSegmenter({ silenceMs: 800 });
  seg.update("hallo", 1000);
  seg.update("hallo allemaal", 1300);
  const [p] = seg.tick(2200);
  assert.equal(p.startedAt, 1000);
});

// ---- batcher: pieces -> one translation call at a time ----------------

test("only one call is out at a time; pieces that arrive meanwhile go out together next, in order", () => {
  // Batching is what keeps the delay bounded: when Claude is slow, the next
  // call simply carries more Dutch instead of a queue of calls piling up.
  const b = C.createBatcher({ maxCarryWords: 40 });
  b.add({ text: "een", startedAt: 0 });
  const first = b.next(10);
  assert.equal(first.text, "een");
  b.add({ text: "twee", startedAt: 20 });
  b.add({ text: "drie", startedAt: 30 });
  assert.equal(b.next(40), null);
  b.done(first, "one");
  const second = b.next(50);
  assert.equal(second.text, "twee drie");
  assert.equal(second.startedAt, 20);
});

test("a WAIT reply carries the Dutch into the next call, ahead of the new words", () => {
  // Dutch often puts the verb at the end of the clause. When a piece stops
  // before the verb, the translator answers WAIT and sees the piece again,
  // completed, in the next call.
  const b = C.createBatcher({ maxCarryWords: 40 });
  b.add({ text: "ik heb gisteren mijn fiets", startedAt: 0 });
  const x = b.next(10);
  assert.equal(b.done(x, "WAIT"), null);
  b.add({ text: "in de gracht gegooid", startedAt: 500 });
  const y = b.next(600);
  assert.equal(y.text, "ik heb gisteren mijn fiets in de gracht gegooid");
  assert.equal(y.startedAt, 0);
  assert.equal(y.force, false);
});

test("carried Dutch that reaches maxCarryWords is marked so the translator must answer", () => {
  const b = C.createBatcher({ maxCarryWords: 6 });
  b.add({ text: "een twee drie vier", startedAt: 0 });
  b.done(b.next(1), "WAIT");
  b.add({ text: "vijf zes", startedAt: 100 });
  const y = b.next(200);
  assert.equal(y.force, true);
});

test("carried Dutch with no new speech after it goes out, marked must-answer, after flushAfterMs", () => {
  // Otherwise the end of a story could sit unsent until the next one starts.
  const b = C.createBatcher({ maxCarryWords: 40, flushAfterMs: 4000 });
  b.add({ text: "en toen zei hij", startedAt: 0 });
  b.done(b.next(10), "WAIT");
  assert.equal(b.next(3000), null);
  const y = b.next(4100);
  assert.equal(y.text, "en toen zei hij");
  assert.equal(y.force, true);
});

test("a failed call puts its Dutch back, so the next call still contains those words", () => {
  const b = C.createBatcher({ maxCarryWords: 40 });
  b.add({ text: "een twee", startedAt: 0 });
  const x = b.next(10);
  assert.equal(b.failed(x, 50), 1);
  b.add({ text: "drie", startedAt: 60 });
  assert.equal(b.next(70).text, "een twee drie");
});

test("a backlog built up while calls failed is cut to the newest maxBatchWords words", () => {
  // If the network drops for a minute, translating that whole minute when it
  // comes back would put the audio a minute behind the stage. Only the most
  // recent speech is worth hearing.
  const b = C.createBatcher({ maxBatchWords: 5 });
  b.add({ text: "een twee drie vier", startedAt: 0 });
  b.failed(b.next(1), 2);
  b.add({ text: "vijf zes zeven acht", startedAt: 3 });
  assert.equal(b.next(4).text, "vier vijf zes zeven acht");
});

test("a translation that is not WAIT comes back as the English line", () => {
  const b = C.createBatcher();
  b.add({ text: "goedenavond", startedAt: 0 });
  const x = b.next(1);
  assert.deepEqual(b.done(x, '"Good evening."'), { nl: "goedenavond", en: "Good evening.", startedAt: 0 });
});

// ---- prompt -----------------------------------------------------------

test("the prompt carries the new Dutch verbatim and the newest context, dropping the oldest first", () => {
  const history = [
    { nl: "oud oud oud", en: "old old old" },
    { nl: "midden", en: "middle" },
    { nl: "nieuw", en: "new" },
  ];
  const p = C.buildPrompt({ history, batchText: "en dan dit", force: false, notes: "", budget: 40 });
  assert.match(p, /en dan dit/);
  assert.match(p, /nieuw/);
  assert.match(p, /midden/);
  assert.doesNotMatch(p, /oud oud oud/);
});

test("a must-answer batch tells the translator that WAIT is not allowed", () => {
  const p1 = C.buildPrompt({ history: [], batchText: "x", force: false, notes: "" });
  const p2 = C.buildPrompt({ history: [], batchText: "x", force: true, notes: "" });
  assert.match(p1, /WAIT/);
  assert.match(p2, /do not answer WAIT/i);
});

// ---- audio queue: English lines -> AirPods -----------------------------

test("when English arrives faster than it can be spoken, the oldest unspoken lines are dropped", () => {
  // Spoken English can take longer than the Dutch it translates. Without a
  // cap the audio falls further behind the stage with every line; with the
  // cap you always hear something recent. Dropped lines stay on screen.
  const q = C.createSpeechQueue({ maxWaiting: 2 });
  const dropped = [];
  for (const l of ["a", "b", "c", "d", "e"]) dropped.push(...q.push(l));
  assert.deepEqual(dropped, ["a", "b", "c"]);
  assert.equal(q.shift(), "d");
  assert.equal(q.shift(), "e");
  assert.equal(q.shift(), undefined);
});

test("bracketed pun notes are left out of the audio when that setting is off", () => {
  const s = "That's what I call a cheesy story [pun: kaas means cheese] anyway";
  assert.equal(C.forSpeech(s, false), "That's what I call a cheesy story anyway");
  assert.equal(C.forSpeech(s, true), s);
});

// ---- recognizer results -> one session transcript -----------------------

test("separate recognizer results are joined into one transcript", () => {
  assert.equal(C.joinResults(["ik heb", "gisteren mijn fiets"]), "ik heb gisteren mijn fiets");
});

test("a result that repeats the earlier results inside it is not counted twice", () => {
  // Safari on iPhone has been reported to send, in continuous mode, later
  // results that contain the earlier ones. Joining them naively would send
  // every word to the translator twice.
  assert.equal(
    C.joinResults(["ik heb", "ik heb gisteren", "ik heb gisteren mijn fiets"]),
    "ik heb gisteren mijn fiets",
  );
});

// ---- the API call -----------------------------------------------------------

test("the request goes to the Messages API with the key, the browser-access header, and thinking off", () => {
  // Without anthropic-dangerous-direct-browser-access the API refuses calls
  // from a web page. Thinking off and low effort are there for speed: a
  // live translation that arrives after the next joke is useless.
  const r = C.buildApiRequest({ key: "sk-test", prompt: "NEW DUTCH:\nhallo" });
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers["x-api-key"], "sk-test");
  assert.equal(r.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(r.init.headers["anthropic-dangerous-direct-browser-access"], "true");
  const body = JSON.parse(r.init.body);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.messages, [{ role: "user", content: "NEW DUTCH:\nhallo" }]);
});

test("the English is read from the text blocks of the response and nothing else", () => {
  const json = { content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Good " }, { type: "text", text: "evening." }] };
  assert.equal(C.parseApiResponse(json), "Good evening.");
  assert.equal(C.parseApiResponse({}), "");
});

test("after repeated failures the wait before the next call doubles, up to 15 seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(C.backoffMs), [2000, 4000, 8000, 15000, 15000]);
});

// ---- sharing the key with a friend -------------------------------------

test("a setup link carries the key in the part of the address that never reaches the server", () => {
  // The fragment after # stays in the phone; GitHub never sees the key.
  const key = "sk-ant-api03-Ab_cd-EF==";
  const link = C.setupLink("https://jwbowers.github.io/dutch-live/", key);
  assert.ok(link.startsWith("https://jwbowers.github.io/dutch-live/#k="));
  assert.equal(C.keyFromHash(new URL(link).hash), key);
  assert.equal(C.keyFromHash("#something-else"), null);
});

test("the median delay of 1, 2, 3 and 10 seconds is 2.5 seconds", () => {
  assert.equal(C.median([1000, 2000, 3000, 10000]), 2500);
  assert.equal(C.median([]), null);
});
