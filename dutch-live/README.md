# Tolk

A web page that listens to Dutch speech in a theater and speaks English into
your earbuds. Built for one evening: a storytelling and comedy show in
Amsterdam, three friends, three iPhones, AirPods Pro.

Live page: https://jwbowers.github.io/dutch-live/

## How it works

1. Safari's built-in speech recognition turns the performer's Dutch into text
   (`nl-NL`).
2. The page cuts that text into pieces at pauses, or every 22 words in a long
   unpaused run, holding back the last 3 words because the recognizer is most
   likely to revise them.
3. One piece at a time goes to Claude Haiku 5.5 through the Anthropic API,
   with the last few translated lines as context. When a piece stops before
   its verb, which Dutch often puts at the end of a clause, Claude answers
   `WAIT` and the piece goes out again with its ending.
4. The English appears on screen and is spoken with the phone's own voice.
   If English arrives faster than it can be spoken, the oldest unspoken lines
   are skipped (they stay on screen).

Each phone runs the whole chain on its own. Nothing is shared between phones.

## The API key

You need an Anthropic API key (console.anthropic.com). The page stores it in
that phone's Safari storage and sends it only to `api.anthropic.com`. The
"Copy setup link" button puts the key after `#` in the link; browsers do not
send that part of an address to the server, so GitHub never sees it. Anyone
holding the link can spend from the key, so set a spending limit and delete
the key after the show.

## Files

- `core.js` --- the logic between recognizer and speaker, with no browser
  dependencies, so node can test it.
- `page.html` --- the page; `node build.js` inlines `core.js` into it and
  writes `index.html`, the file GitHub Pages serves.
- `tests/core.test.js` --- tests of `core.js`.
- `tests/smoke.js` --- loads `index.html` in jsdom with a fake recognizer,
  fake speech and a fake API, and checks the wiring end to end.

```sh
npm install
npm test
```

The tests cannot exercise Safari's real speech recognition or the real API;
those get checked on a phone.
