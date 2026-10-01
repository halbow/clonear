import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORMAT_VERSION, initClonearMd } from "../app/lib/format.js";
import { projectFromParts, ticketFromText } from "../app/lib/store.js";

const md = (version) => `---\nversion: ${version}\n---\n`;

test("a folder without clonear.md is refused", () => {
  assert.deepEqual(projectFromParts("web", null, ["todo"]), { error: "no clonear.md", action: null });
});

test("clonear.md needs a valid version", () => {
  assert.match(projectFromParts("web", "---\nname: Web\n---\n", []).error, /no valid "version"/);
  assert.match(projectFromParts("web", "---\nversion: abc\n---\n", []).error, /no valid "version"/);
});

test("a newer major version is refused with a warning", () => {
  const out = projectFromParts("web", md("2.0.0"), []);
  assert.match(out.error, /needs a newer board/);
  assert.equal(out.action, null);
});

test("a newer minor version is read, and flagged", () => {
  const p = projectFromParts("web", "---\nversion: 1.4.0\nswimlanes: [a, b]\n---\n", []);
  assert.equal(p.error, undefined);
  assert.equal(p.newer, true);
});

test("the current version, and the legacy integer 1, are read as-is", () => {
  assert.equal(projectFromParts("web", md(FORMAT_VERSION), []).newer, false);
  assert.equal(projectFromParts("web", md(1), []).newer, false);
});

test("init writes a clonear.md the board reads at the current version", () => {
  const p = projectFromParts("tickets", initClonearMd({ name: "My App", prefix: "APP" }), []);
  assert.equal(p.name, "My App");
  assert.equal(p.version, FORMAT_VERSION);
  assert.deepEqual(p.columns.map((c) => c.id), ["todo", "in-progress", "in-qa", "done"]);
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
  test(`${dir}/clonear.md is valid`, () => {
    const raw = readFileSync(new URL(`../${dir}/clonear.md`, import.meta.url), "utf8");
    assert.equal(projectFromParts("x", raw, []).error, undefined);
  });
}

test("priority defaults to low when missing or unknown (including the old none)", () => {
  for (const fm of ["", "priority: none\n", "priority: whatever\n"]) {
    assert.equal(ticketFromText("WEB-1", `---\ntitle: A\n${fm}---\n`).priority, "low", fm);
  }
});
