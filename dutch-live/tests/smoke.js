// Drive the built page in jsdom with a fake recognizer, fake speech and a
// fake API, to check the wiring: Dutch heard -> pause -> call -> WAIT carry
// -> English line on screen -> spoken. Run: npm install && node tests/smoke.js (after node build.js)
const fs = require("fs");
const { JSDOM } = require("jsdom");
const html = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");

const calls = [];
const spoken = [];
let rec = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM(html, {
  url: "https://jwbowers.github.io/dutch-live/#k=sk-ant-FAKE_key-123",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(w) {
    w.webkitSpeechRecognition = class {
      start() { rec = this; setTimeout(() => this.onstart && this.onstart(), 0); }
      stop() { setTimeout(() => this.onend && this.onend(), 0); }
      abort() { setTimeout(() => this.onend && this.onend(), 0); }
    };
    w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    w.speechSynthesis = {
      speaking: false, pending: false,
      getVoices: () => [{ name: "Samantha", lang: "en-US", voiceURI: "sam", localService: true }],
      speak(u) { spoken.push(u.text); this.speaking = true; setTimeout(() => { this.speaking = false; u.onend && u.onend(); }, 30); },
      cancel() {}, addEventListener() {},
    };
    w.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      const dutch = body.messages[0].content.split("NEW DUTCH:\n")[1];
      const forced = /do not answer WAIT/.test(body.messages[0].content);
      const reply = (!forced && /mijn fiets$/.test(dutch)) ? "WAIT" : "EN[" + dutch + "]";
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: "text", text: reply }] }) };
    };
    w.navigator.clipboard = { writeText: async () => {} };
  },
});
const w = dom.window;
const $ = (id) => w.document.getElementById(id);
const results = (texts, finalLast) => {
  const arr = texts.map((t, i) => ({ 0: { transcript: t }, length: 1, isFinal: i < texts.length - 1 || Boolean(finalLast) }));
  return { results: Object.assign(arr, { length: arr.length }) };
};

(async () => {
  await sleep(100);
  const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

  check(JSON.parse(w.localStorage.getItem("tolk.v1")).key === "sk-ant-FAKE_key-123", "key from setup link is stored");
  check(!w.location.hash, "key is wiped from the address bar");

  $("startBtn").click();
  await sleep(50);
  check(rec && rec.lang === "nl-NL" && rec.continuous && rec.interimResults, "recognizer started in nl-NL, continuous, interim results");
  check(spoken[0] === "Listening.", "Start speaks a word inside the tap (unlocks audio)");

  // Speaker stops before the verb: expect a WAIT and no line yet.
  rec.onresult(results(["ik heb gisteren"]));
  rec.onresult(results(["ik heb gisteren mijn fiets"]));
  await sleep(1300);
  check(calls.length === 1 && calls[0].body.messages[0].content.endsWith("ik heb gisteren mijn fiets"), "pause sends the Dutch heard so far");
  check(calls[0].headers["anthropic-dangerous-direct-browser-access"] === "true", "call carries the browser-access header");
  check($("transcript").querySelectorAll(".line").length === 0, "WAIT reply puts nothing on screen");

  // The rest of the clause arrives: the next call must carry the held words first.
  rec.onresult(results(["ik heb gisteren mijn fiets in de gracht gegooid"]));
  await sleep(1300);
  const last = calls[calls.length - 1].body.messages[0].content.split("NEW DUTCH:\n")[1];
  check(last === "ik heb gisteren mijn fiets in de gracht gegooid", "held Dutch goes out with its ending: " + JSON.stringify(last));
  const lines = [...$("transcript").querySelectorAll(".line .en")].map((e) => e.textContent);
  check(lines.length === 1 && lines[0] === "EN[ik heb gisteren mijn fiets in de gracht gegooid]", "one English line on screen");
  await sleep(300);
  check(spoken.includes(lines[0]), "the English line was spoken");
  check(/delay \d+\.\d s/.test($("status").textContent), "status shows the delay: " + $("status").textContent);

  // Recognizer ends on its own: unfinished words are flushed and it restarts.
  rec.onresult(results(["ik heb gisteren mijn fiets in de gracht gegooid", "en toen zei hij"]));
  const old = rec;
  rec.onend();
  await sleep(400);
  check(rec !== old, "recognizer restarted after ending");
  const flushed = calls[calls.length - 1].body.messages[0].content.split("NEW DUTCH:\n")[1];
  check(flushed === "en toen zei hij", "words heard just before the restart were sent: " + JSON.stringify(flushed));
  check(/mic restarts 1/.test($("status").textContent), "restart is counted on screen");

  // Stop.
  $("startBtn").click();
  await sleep(1500);
  check($("startBtn").textContent === "Start listening", "Stop returns the button to Start");
  console.log("calls:", calls.length, "spoken:", JSON.stringify(spoken));
  w.close();
  process.exit();
})();
