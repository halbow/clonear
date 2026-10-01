import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORMAT_VERSION, initClonearMd } from "../app/lib/format.js";
import {
  ReadOnlyBackend,
  directoryFromFiles,
  nextTicketId,
  normalizePrefix,
  prefixRenames,
  projectFromParts,
  ticketFromText,
  updateClonearMd,
} from "../app/lib/store.js";

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

// Files as <input webkitdirectory> gives them: the path starts with the picked folder.
const picked = (files) =>
  Object.entries(files).map(([path, text]) => {
    const file = new File([text], path.split("/").pop(), { lastModified: 1 });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  });

test("a picked folder is scanned like an opened one, read-only", async () => {
  const root = directoryFromFiles(
    picked({
      "repo/tickets/clonear.md": `---\nversion: ${FORMAT_VERSION}\nname: Repo\n---\n`,
      "repo/tickets/todo/R-1.md": "---\ntitle: First\npriority: high\n---\nBody",
      "repo/tickets/done/R-2.md": "---\ntitle: Second\n---\n",
      "repo/tickets/.hidden/R-3.md": "---\ntitle: Hidden\n---\n",
    })
  );
  const backend = new ReadOnlyBackend(root);
  assert.equal(backend.name, "repo");
  assert.equal(backend.readonly, true);
  const { projects, rejected } = await backend.scan();
  assert.deepEqual(rejected, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "Repo");
  const byColumn = Object.fromEntries(projects[0].columns.map((c) => [c.id, c.tickets.map((t) => t.title)]));
  assert.deepEqual(byColumn, { todo: ["First"], "in-progress": [], "in-qa": [], done: ["Second"] });
  const ticket = projects[0].columns[0].tickets[0];
  assert.equal(ticket.priority, "high");
  assert.equal(await backend.readText(ticket), "---\ntitle: First\npriority: high\n---\nBody");
  await assert.rejects(backend.writeTicket(ticket, "x"), /read-only/);
  await assert.rejects(backend.moveTicket(ticket, "done"), /read-only/);
  await assert.rejects(backend.deleteTicket(ticket), /read-only/);
  assert.equal((await backend.watch()).mode, "readonly");
});

test("picking an empty folder gives no tree", () => {
  assert.equal(directoryFromFiles([]), null);
});

test("reads prefix and labels from clonear.md", () => {
  const p = projectFromParts("tickets", "---\nversion: 1.1.0\nprefix: clo\nlabels: [bug, ui]\n---\n", []);
  assert.equal(p.prefix, "CLO");
  assert.deepEqual(p.labels, ["bug", "ui"]);
  const bare = projectFromParts("tickets", "---\nversion: 1\nprefix: C-1\n---\n", []);
  assert.equal(bare.prefix, "");
  assert.deepEqual(bare.labels, []);
});

test("init writes the prefix", () => {
  const p = projectFromParts("tickets", initClonearMd({ name: "Clonear", prefix: "CLO" }), []);
  assert.equal(p.prefix, "CLO");
  assert.deepEqual(p.labels, []);
});

const withTickets = (prefix, ids) => ({ id: "tickets", prefix, columns: [{ tickets: ids.map((id) => ({ id })) }] });

test("next ticket id prefers the prefix from clonear.md", () => {
  assert.equal(nextTicketId(withTickets("", [])), "TIC-1");
  assert.equal(nextTicketId(withTickets("", ["OLD-4"])), "OLD-5");
  assert.equal(nextTicketId(withTickets("CLO", [])), "CLO-1");
  assert.equal(nextTicketId(withTickets("CLO", ["CLO-6", "OLD-9"])), "CLO-7");
});

test("normalizePrefix keeps letters only, uppercased", () => {
  assert.equal(normalizePrefix(" clo "), "CLO");
  assert.equal(normalizePrefix("C-1"), "");
  assert.equal(normalizePrefix(""), "");
});

test("updateClonearMd rewrites settings, keeps the rest, and stamps older versions", () => {
  const raw = "---\nversion: 1.0.0\nname: Old\ncolumns: [todo, done]\nswimlanes: [a]\n---\n\nNotes.\n";
  const out = updateClonearMd(raw, { name: "New", prefix: "NEW", labels: ["bug"] });
  assert.equal(out, `---\nversion: ${FORMAT_VERSION}\nname: New\ncolumns: [todo, done]\nswimlanes: [a]\nprefix: NEW\nlabels: [bug]\n---\n\nNotes.\n`);
  // A newer minor version is kept, and an empty prefix is removed.
  const newer = updateClonearMd("---\nversion: 1.9.0\nprefix: X\n---\n", { prefix: "" });
  assert.equal(newer, "---\nversion: 1.9.0\n---\n");
});

test("a new prefix renames the tickets using the current one", () => {
  const ids = (renames) => renames.map((r) => `${r.ticket.id}>${r.id}`);
  assert.deepEqual(ids(prefixRenames(withTickets("", ["TIC-1", "TIC-3", "OLD-2"]), "CLO")), ["TIC-1>CLO-1", "TIC-3>CLO-3"]);
  assert.deepEqual(ids(prefixRenames(withTickets("CLO", ["CLO-1", "NOTE"]), "APP")), ["CLO-1>APP-1"]);
  assert.deepEqual(prefixRenames(withTickets("CLO", ["CLO-1"]), "CLO"), []);
  assert.deepEqual(prefixRenames(withTickets("CLO", ["CLO-1"]), ""), []);
});
