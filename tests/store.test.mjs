import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORMAT_VERSION, projectFromParts } from "../app/lib/store.js";

test("a folder without cloinear.md is refused", () => {
  assert.deepEqual(projectFromParts("web", null, ["todo"]), { error: "no cloinear.md" });
});

test("cloinear.md needs a valid version", () => {
  assert.match(projectFromParts("web", "---\nname: Web\n---\n", []).error, /no valid "version"/);
  assert.match(projectFromParts("web", "---\nversion: abc\n---\n", []).error, /no valid "version"/);
});

test("a newer format version is refused", () => {
  const out = projectFromParts("web", `---\nversion: ${FORMAT_VERSION + 1}\n---\n`, []);
  assert.match(out.error, /supports up to/);
});

test("reads name and column order, and appends extra column folders", () => {
  const p = projectFromParts("web", "---\nversion: 1\nname: Web App\ncolumns: [todo, done]\n---\n", ["done", "todo", "blocked"]);
  assert.equal(p.name, "Web App");
  assert.deepEqual(p.columns.map((c) => c.id), ["todo", "done", "blocked"]);
});

test("defaults name and columns", () => {
  const p = projectFromParts("mobile-app", "---\nversion: 1\n---\n", []);
  assert.equal(p.name, "Mobile App");
  assert.deepEqual(p.columns.map((c) => c.id), ["todo", "in-progress", "in-qa", "done"]);
});

for (const dir of ["tickets", "demo/web-app", "demo/mobile-app"]) {
  test(`${dir}/cloinear.md is valid`, () => {
    const raw = readFileSync(new URL(`../${dir}/cloinear.md`, import.meta.url), "utf8");
    assert.equal(projectFromParts("x", raw, []).error, undefined);
  });
}
