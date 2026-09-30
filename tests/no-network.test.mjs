// The board must never talk to another origin. The browser enforces this
// through the CSP in app/index.html; these tests keep that policy strict and
// fail if a network API shows up in the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function csp(html) {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(m, "missing CSP meta tag");
  return Object.fromEntries(
    m[1].split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
  );
}

const EXPECTED = {
  "default-src": ["'none'"],
  "img-src": ["data:"],
  "connect-src": ["'none'"],
  "form-action": ["'none'"],
  "base-uri": ["'none'"],
};

for (const file of ["app/index.html", "dist/cloinear.html"]) {
  test(`${file}: CSP blocks every other origin`, () => {
    const policy = csp(read(file));
    for (const [name, values] of Object.entries(EXPECTED)) assert.deepEqual(policy[name], values, name);
    assert.deepEqual(policy["style-src"], ["'self'", "'unsafe-inline'"]);
    for (const [name, values] of Object.entries(policy)) {
      for (const v of values) assert.doesNotMatch(v, /^(https?:|wss?:|\*)/, `${name} allows ${v}`);
    }
  });
}

test("dist/cloinear.html: only the bundled scripts may run", () => {
  const scriptSrc = csp(read("dist/cloinear.html"))["script-src"];
  assert.ok(scriptSrc.length > 0 && scriptSrc.every((v) => v.startsWith("'sha256-")), scriptSrc.join(" "));
});

test("the app uses no network API", () => {
  const NETWORK = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|Worker)\s*\(|new\s+(WebSocket|EventSource|Worker|SharedWorker|RTCPeerConnection|XMLHttpRequest)\b/g;
  const files = ["app.js", ...readdirSync(new URL("../app/lib", import.meta.url)).map((f) => `lib/${f}`)];
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const hits = read(`app/${f}`).match(NETWORK) || [];
    assert.deepEqual(hits, [], f);
  }
});
