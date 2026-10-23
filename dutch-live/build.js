// Inline core.js into page.html to make the single file GitHub Pages serves.
// One file means the phone has everything after one load, which matters in a
// theater basement with weak signal. Run: node build.js
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const core = fs.readFileSync(path.join(dir, "core.js"), "utf8");
const page = fs.readFileSync(path.join(dir, "page.html"), "utf8");
if (!page.includes("/*__CORE__*/")) throw new Error("page.html lost its /*__CORE__*/ marker");
// A function replacement avoids $-patterns in core.js being read as regex groups.
fs.writeFileSync(path.join(dir, "index.html"), page.replace("/*__CORE__*/", () => core));
console.log("wrote index.html");
