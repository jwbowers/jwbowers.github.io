// Pure logic for the live Dutch -> English page. Nothing here touches the
// browser, the microphone or the network, so node can test all of it
// (core.test.js). The page inlines this file at build time.
//
// The chain this file serves:
//   recognizer transcript --segmenter--> pieces of Dutch
//   pieces --batcher--> one Claude call at a time --> English lines
//   English lines --speech queue--> AirPods

(function (root) {
  "use strict";

  const splitWords = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);

  // ---- segmenter -------------------------------------------------------
  // The recognizer gives the whole transcript of its current session on
  // every update, and keeps revising words near the end. We track how many
  // words of the session we have already sent, and send the rest only when
  // the recognizer marks it final, when the speaker pauses, or when an
  // unpaused run gets long enough that waiting would leave you behind.
  function createSegmenter(opts) {
    const o = Object.assign({ silenceMs: 800, maxWords: 22, keepTail: 3 }, opts);
    let words = [];
    let committed = 0; // words of this session already sent
    let lastText = "";
    let lastChange = 0;
    let firstSeen = null; // when the oldest unsent word appeared

    function commitUpTo(n, now) {
      if (n <= committed) return [];
      const text = words.slice(committed, n).join(" ");
      const piece = { text, startedAt: firstSeen == null ? now : firstSeen };
      committed = n;
      // Held-back tail words were heard just now, as far as we can tell.
      firstSeen = words.length > committed ? now : null;
      return [piece];
    }

    function update(text, now, isFinal) {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (t !== lastText) {
        lastText = t;
        lastChange = now;
      }
      words = splitWords(t);
      // A transcript can shrink when the recognizer merges words; then there
      // is nothing new to send until it grows past what we already sent.
      if (words.length > committed && firstSeen == null) firstSeen = now;
      if (isFinal) return commitUpTo(words.length, now);
      if (words.length - committed >= o.maxWords) {
        return commitUpTo(words.length - o.keepTail, now);
      }
      return [];
    }

    function tick(now) {
      if (words.length > committed && now - lastChange >= o.silenceMs) {
        return commitUpTo(words.length, now);
      }
      return [];
    }

    // Called when the recognizer session ends. Its last unsent words would
    // otherwise be lost, because the next session's transcript starts empty.
    function reset(now) {
      const out = commitUpTo(words.length, now);
      words = [];
      committed = 0;
      lastText = "";
      firstSeen = null;
      return out;
    }

    return { update, tick, reset };
  }

  // ---- reply handling ----------------------------------------------------
  function cleanReply(s) {
    let t = String(s || "").trim();
    t = t.replace(/^(english|translation)\s*:\s*/i, "");
    // Quick models sometimes wrap a one-line answer in quotes.
    if (/^["'].*["']$/s.test(t) && t.length >= 2) t = t.slice(1, -1).trim();
    return t;
  }
  const isWait = (s) => /^\W*wait\W*$/i.test(String(s || "").trim());

  // ---- batcher -----------------------------------------------------------
  // At most one translation call is out at a time. Pieces that arrive while
  // it runs wait and go out together in the next call, so a slow answer
  // makes the next call longer rather than queueing calls behind it.
  function createBatcher(opts) {
    const o = Object.assign({ maxCarryWords: 40, flushAfterMs: 4000, maxBatchWords: 80 }, opts);
    let queue = [];
    let carry = null; // Dutch held back after WAIT or a failed call
    let inFlight = false;
    let failures = 0;

    function add(piece) {
      if (piece && piece.text) queue.push(piece);
    }

    function next(now) {
      if (inFlight) return null;
      if (!queue.length) {
        // Speech stopped after a WAIT: send what is held, and require an
        // answer, so the end of a story does not wait for the next story.
        if (carry && carry.fromWait && now - carry.heldAt >= o.flushAfterMs) {
          const b = { text: carry.text, startedAt: carry.startedAt, force: true, sentAt: now };
          carry = null;
          inFlight = true;
          return b;
        }
        return null;
      }
      const parts = carry ? [carry, ...queue] : queue;
      let w = splitWords(parts.map((p) => p.text).join(" "));
      // After an outage, translating everything missed would leave the
      // audio that far behind the stage; keep only the newest speech.
      if (w.length > o.maxBatchWords) w = w.slice(w.length - o.maxBatchWords);
      const text = w.join(" ");
      const startedAt = Math.min(...parts.map((p) => p.startedAt));
      const force = Boolean(carry) && splitWords(text).length >= o.maxCarryWords;
      queue = [];
      carry = null;
      inFlight = true;
      return { text, startedAt, force, sentAt: now };
    }

    function done(batch, reply) {
      inFlight = false;
      failures = 0;
      if (isWait(reply)) {
        // A must-answer batch that still says WAIT is dropped rather than
        // carried, because carrying it again would repeat the refusal.
        if (!batch.force) {
          carry = { text: batch.text, startedAt: batch.startedAt, heldAt: batch.sentAt, fromWait: true };
        }
        return null;
      }
      const en = cleanReply(reply);
      if (!en || en === "-") return null;
      return { nl: batch.text, en, startedAt: batch.startedAt };
    }

    function failed(batch, now) {
      inFlight = false;
      failures += 1;
      const prior = carry ? carry.text + " " : "";
      carry = { text: prior + batch.text, startedAt: batch.startedAt, heldAt: now, fromWait: false };
      return failures;
    }

    const busy = () => inFlight;
    const pending = () => queue.length + (carry ? 1 : 0);
    return { add, next, done, failed, busy, pending };
  }

  // ---- prompt ------------------------------------------------------------
  // The sample call is memoryless, so every call carries the instructions,
  // a little recent context (so pronouns and running jokes come out right),
  // and the new Dutch.
  function buildPrompt(args) {
    const { history = [], batchText, force = false, notes = "", budget = 2500 } = args;
    const ctx = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const size = h.nl.length + h.en.length;
      if (used + size > budget) break;
      used += size;
      ctx.unshift(h);
    }
    const lines = [
      "You are a live interpreter whispering into the earbud of an English speaker at a Dutch storytelling and stand-up comedy show in a small Amsterdam theater.",
      "The Dutch comes from automatic speech recognition of a performer heard through a theater microphone: expect misheard words, no punctuation, and stray words from audience noise. Use the context to guess what was meant.",
      "Translate only the NEW DUTCH below into natural spoken English: short, plain, in the performer's voice and tone, keeping names. Never explain or summarize beyond that.",
      "If a joke depends on wordplay that does not survive translation, translate the sense and add a note of at most eight words in square brackets, for example [pun: 'bal' also means testicle].",
      force
        ? "This piece must be translated now: do not answer WAIT. If it is an unfinished fragment, translate it as a fragment."
        : "If the new Dutch stops in the middle of a clause, so that the English cannot be formed until the rest arrives (Dutch often puts the verb last), reply with exactly WAIT and nothing else.",
      "If the new Dutch is only noise, laughter or filler, reply with exactly -",
      "Reply with the English only: no quotation marks, no preface.",
    ];
    if (notes.trim()) lines.push("", "Notes about this show from the audience member: " + notes.trim());
    if (ctx.length) {
      lines.push("", "RECENT CONTEXT (already translated; do not translate again):");
      for (const h of ctx) lines.push("Dutch: " + h.nl, "English: " + h.en);
    }
    lines.push("", "NEW DUTCH:", batchText);
    return lines.join("\n");
  }

  // ---- speech queue ------------------------------------------------------
  // Spoken English can take longer than the Dutch it translates. Capping
  // the number of unspoken lines keeps the audio near the stage at the cost
  // of skipping lines, which stay on screen.
  function createSpeechQueue(opts) {
    const o = Object.assign({ maxWaiting: 2 }, opts);
    const q = [];
    return {
      push(line) {
        q.push(line);
        const dropped = [];
        while (q.length > o.maxWaiting) dropped.push(q.shift());
        return dropped;
      },
      shift: () => q.shift(),
      clear() { q.length = 0; },
      get size() { return q.length; },
    };
  }

  function forSpeech(text, speakNotes) {
    if (speakNotes) return text;
    return String(text).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  }

  // ---- recognizer results -> session transcript ---------------------------
  // Chrome sends one result per stretch of speech; Safari on iPhone has been
  // reported to send later results that already contain the earlier ones.
  // When a result begins with everything joined so far, it replaces it.
  // The cost: two consecutive results that genuinely start with the same
  // words ("ja", "ja zeker") lose the repeat, which a translator survives.
  function joinResults(transcripts) {
    let acc = "";
    for (const raw of transcripts) {
      const t = String(raw || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (acc && t.toLowerCase().startsWith(acc.toLowerCase())) acc = t;
      else acc = acc ? acc + " " + t : t;
    }
    return acc;
  }

  // ---- the API call --------------------------------------------------------
  const MODEL = "claude-haiku-5-5";
  function buildApiRequest({ key, prompt, model = MODEL, maxTokens = 300 }) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          // Required for any call made from a web page rather than a server.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // Speed over depth: a line that arrives after the next joke is lost.
          thinking: { type: "disabled" },
          output_config: { effort: "low" },
          messages: [{ role: "user", content: prompt }],
        }),
      },
    };
  }

  function parseApiResponse(json) {
    const blocks = (json && Array.isArray(json.content)) ? json.content : [];
    return blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
  }

  const backoffMs = (failures) => Math.min(15000, 1000 * Math.pow(2, Math.max(1, failures)));

  // ---- sharing the key -------------------------------------------------------
  // The key rides in the fragment (after #), which browsers never send to
  // the server, so GitHub's logs never see it.
  const setupLink = (base, key) => base.split("#")[0] + "#k=" + encodeURIComponent(key);
  function keyFromHash(hash) {
    const m = /^#k=(.+)$/.exec(String(hash || ""));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const api = {
    createSegmenter, createBatcher, buildPrompt, createSpeechQueue, forSpeech,
    joinResults, buildApiRequest, parseApiResponse, backoffMs, setupLink, keyFromHash,
    median, cleanReply, isWait, splitWords, MODEL,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== "undefined" ? window : globalThis);
