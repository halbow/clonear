// Board storage: a local folder opened with the File System Access API
// (showDirectoryPicker). Read-write, watches the folder for outside changes.
// Browsers without that API (Safari, Firefox) get ReadOnlyBackend: a snapshot
// of a folder picked with <input type="file" webkitdirectory>.
// FsBackend exposes this shape to the UI:
//
//   scan()                         -> { projects: [{ id, name, prefix, labels, version, newer, columns: [{ id, label, tickets }] }],
//                                       rejected: [{ id, reason, action, dir }] }
//                                     action: "migrate" | null
//   readText(ticket)               -> the file's current content
//   writeTicket(ticket, raw, opts) -> { lastModified }      (throws ConflictError)
//   moveTicket(ticket, columnId)   -> { lastModified }
//   createTicket(project, columnId, id, raw)
//   deleteTicket(ticket)
//   initProject(name, prefix)      -> makes the root a project: clonear.md + column folders
//   writeSettings(project, fields, opts) -> rewrites name / prefix / labels in clonear.md, and renames the
//                                     tickets to a new prefix -> { renamed }   (throws ConflictError)
//   migrateProject(dir)            -> rewrites clonear.md and its tickets to FORMAT_VERSION
//   watch(onChange)                -> { mode, stop }       mode: "live" | "polling" | "readonly"
//   readonly                       -> true when every write above throws
//
// Data model: <projects root>/<project>/<column>/<TICKET-ID>.md. Every project
// folder needs a <project>/clonear.md: it marks the folder as a Clonear
// project, pins the format version, sets the display name and column order, and
// holds a ticket template for people and agents. Folders without it are refused.

import { parseFrontmatter, updateTicketText } from "./frontmatter.js";
import {
  DEFAULT_COLUMNS,
  FORMAT_VERSION,
  checkVersion,
  compareVersions,
  initClonearMd,
  migrate,
  parseVersion,
} from "./format.js";

export const MARKER_FILE = "clonear.md";

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
export const SIZES = ["S", "M", "L"];
const ACRONYMS = new Set(["qa", "ui", "ci", "api", "id", "ux"]);
// Folders that can hold projects when the user picks a repo root.
export const CONTAINER_DIRS = ["projects", "tickets"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build"]);

export class ConflictError extends Error {
  constructor() {
    super("The file changed on disk since it was loaded.");
    this.name = "ConflictError";
  }
}

export function titleize(slug) {
  const words = slug
    .replace(/_/g, "-")
    .split("-")
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  return words.join(" ") || slug;
}

// Build the ticket fields the UI needs from a raw .md file.
export function ticketFromText(id, raw) {
  const { data, body } = parseFrontmatter(raw);
  const str = (v) => (Array.isArray(v) ? v.join(", ") : v || "");
  let labels = data.labels || [];
  if (!Array.isArray(labels)) labels = [labels];
  const priority = str(data.priority).toLowerCase();
  const size = str(data.size).toUpperCase();
  return {
    id,
    raw,
    body,
    title: str(data.title) || id,
    assignee: str(data.assignee),
    priority: priority in PRIORITY_ORDER ? priority : "low", // missing or unknown (e.g. old "none")
    size: SIZES.includes(size) ? size : "",
    labels: labels.filter(Boolean),
    created: str(data.created),
  };
}

function sortTickets(tickets) {
  const idNum = (t) => Number((t.id.match(/(\d+)$/) || [0, 0])[1]);
  return tickets.sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.created.localeCompare(a.created) ||
      idNum(b) - idNum(a)
  );
}

// Next free id in a project, e.g. WEB-6. Uses the prefix from clonear.md,
// else the one already in use, else one made from the folder name.
export function nextTicketId(project) {
  const prefix = currentPrefix(project);
  const max = Math.max(0, ...parsedIds(project).filter((m) => m.prefix === prefix).map((m) => m.number));
  return `${prefix}-${max + 1}`;
}

// The prefix new tickets get: clonear.md's, else the one in use, else one
// made from the folder name.
export function currentPrefix(project) {
  const parsed = parsedIds(project);
  return project.prefix || (parsed[0] && parsed[0].prefix) || defaultPrefix(project.id);
}

// Tickets whose id is <prefix>-<number>, e.g. { ticket, prefix: "WEB", number: 6 }.
function parsedIds(project) {
  return project.columns.flatMap((c) =>
    c.tickets.flatMap((ticket) => {
      const m = ticket.id.match(/^([A-Za-z]+)-(\d+)$/);
      return m ? [{ ticket, prefix: m[1], number: Number(m[2]) }] : [];
    })
  );
}

// Changing the prefix renames the tickets that use the current one, e.g.
// TIC-3 -> CLO-3: [{ ticket, id }]. Tickets with another prefix are left alone.
export function prefixRenames(project, prefix) {
  const from = currentPrefix(project);
  if (!prefix || prefix === from) return [];
  return parsedIds(project)
    .filter((m) => m.prefix === from)
    .map((m) => ({ ticket: m.ticket, id: `${prefix}-${m.number}` }));
}

// Ticket id prefix for a project without tickets yet, e.g. web-app -> WEB.
export function defaultPrefix(projectId) {
  return projectId.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "TIX";
}

// A ticket id prefix as typed by someone, e.g. " clo " -> "CLO". "" when it
// isn't letters only.
export function normalizePrefix(value) {
  const prefix = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]+$/.test(prefix) ? prefix : "";
}

// clonear.md with its name / prefix / labels replaced by `fields`. Stamps the
// current format version on older files, since prefix and labels need it.
export function updateClonearMd(raw, fields) {
  const { data, body } = parseFrontmatter(raw);
  const version = parseVersion(data.version);
  const stamp = !version || compareVersions(version, parseVersion(FORMAT_VERSION)) < 0;
  return updateTicketText(raw, stamp ? { version: FORMAT_VERSION, ...fields } : fields, body);
}

// Build a project from its clonear.md and column folder names. Returns
// { error, action } when the folder must be refused; action says what fixes it.
export function projectFromParts(id, clonearMd, dirNames) {
  if (clonearMd == null) return { error: `no ${MARKER_FILE}`, action: null };
  const { data } = parseFrontmatter(clonearMd);
  const version = String(data.version ?? "");
  switch (checkVersion(version)) {
    case "invalid":
      return { error: `${MARKER_FILE} has no valid "version"`, action: null };
    case "too-new":
      return {
        error: `${MARKER_FILE} is version ${version}, which needs a newer board (this one reads ${FORMAT_VERSION})`,
        action: null,
      };
    case "outdated":
      return { error: `${MARKER_FILE} is version ${version}; migrate it to ${FORMAT_VERSION}`, action: "migrate" };
  }
  const newer = checkVersion(version) === "newer";
  const name = typeof data.name === "string" && data.name ? data.name : titleize(id);
  const prefix = normalizePrefix(typeof data.prefix === "string" ? data.prefix : "");
  let labels = data.labels || [];
  if (!Array.isArray(labels)) labels = [labels];
  const columns =
    Array.isArray(data.columns) && data.columns.length ? data.columns.filter(Boolean) : [...DEFAULT_COLUMNS];
  // Include every column folder that exists on disk, even if clonear.md omits it.
  for (const d of dirNames) if (!columns.includes(d)) columns.push(d);
  return {
    id,
    name,
    prefix,
    labels: labels.map(String).filter(Boolean),
    version,
    newer,
    columns: columns.map((c) => ({ id: c, label: titleize(c), tickets: [] })),
  };
}

// --------------------------------------------------------------------------- //
// File System Access backend
// --------------------------------------------------------------------------- //
export const fsSupported = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

async function listEntries(dir) {
  const entries = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    entries.push({ name, kind: handle.kind, handle });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const missingMarker = (id, dir) => ({ id, reason: `no ${MARKER_FILE}`, action: null, dir });
const hasMarker = (entries) => entries.some((e) => e.kind === "file" && e.name === MARKER_FILE);
// Looks like a project but lacks clonear.md: reported instead of silently skipped.
const looksLikeProject = (entries) =>
  entries.some(
    (e) =>
      (e.kind === "file" && e.name === "project.md") ||
      (e.kind === "directory" && DEFAULT_COLUMNS.includes(e.name))
  );

export class FsBackend {

  constructor(root) {
    this.root = root;
    this.cache = new Map(); // path -> { lastModified, size, raw }
  }

  get name() {
    return this.root.name;
  }

  get readonly() {
    return false;
  }

  async hasPermission() {
    return (await this.root.queryPermission({ mode: "readwrite" })) === "granted";
  }

  // Accepts: a single project folder, a folder containing projects/ or tickets/
  // (either a project itself or a folder of projects), or a folder whose
  // subfolders are projects. Only folders with a clonear.md
  // are projects; lookalikes without one come back in `rejected`.
  async resolveProjects() {
    const entries = await listEntries(this.root);
    if (hasMarker(entries)) return { found: [{ id: this.root.name, dir: this.root, entries }], rejected: [] };
    if (looksLikeProject(entries)) return { found: [], rejected: [missingMarker(this.root.name, this.root)] };

    const container = entries.find((e) => e.kind === "directory" && CONTAINER_DIRS.includes(e.name));
    const baseEntries = container ? await listEntries(container.handle) : entries;
    // tickets/ (or projects/) can itself be the project: tickets/clonear.md, tickets/todo/…
    if (container && hasMarker(baseEntries)) {
      return { found: [{ id: container.name, dir: container.handle, entries: baseEntries }], rejected: [] };
    }
    const found = [];
    const rejected = [];
    for (const e of baseEntries) {
      if (e.kind !== "directory" || SKIP_DIRS.has(e.name)) continue;
      const sub = await listEntries(e.handle);
      if (hasMarker(sub)) found.push({ id: e.name, dir: e.handle, entries: sub });
      else if (container || looksLikeProject(sub)) rejected.push(missingMarker(e.name, e.handle));
    }
    return { found, rejected };
  }

  async scan() {
    const { found, rejected } = await this.resolveProjects();
    const scanned = await Promise.all(found.map((p) => this.scanProject(p)));
    const projects = [];
    for (const p of scanned) {
      if (p.error) rejected.push({ id: p.id, reason: p.error, action: p.action, dir: p.dir });
      else projects.push(p);
    }
    return { projects, rejected };
  }

  async scanProject({ id, dir, entries }) {
    const markerEntry = entries.find((e) => e.kind === "file" && e.name === MARKER_FILE);
    const markerFile = await markerEntry.handle.getFile();
    const clonearMd = await markerFile.text();
    const dirs = entries.filter((e) => e.kind === "directory");
    const project = projectFromParts(id, clonearMd, dirs.map((d) => d.name));
    if (project.error) return { id, dir, error: project.error, action: project.action };
    project.dir = dir;
    project.marker = { handle: markerEntry.handle, lastModified: markerFile.lastModified };

    await Promise.all(
      project.columns.map(async (col) => {
        const entry = dirs.find((d) => d.name === col.id);
        col.dir = entry ? entry.handle : null;
        if (!col.dir) return;
        const files = (await listEntries(col.dir)).filter((e) => e.kind === "file" && e.name.endsWith(".md"));
        col.tickets = sortTickets(
          await Promise.all(files.map((f) => this.readTicket(project, col, f.name, f.handle)))
        );
      })
    );
    return project;
  }

  async readTicket(project, col, fileName, handle) {
    const path = `${project.id}/${col.id}/${fileName}`;
    const file = await handle.getFile();
    let cached = this.cache.get(path);
    if (!cached || cached.lastModified !== file.lastModified || cached.size !== file.size) {
      cached = { lastModified: file.lastModified, size: file.size, raw: await file.text() };
      this.cache.set(path, cached);
    }
    return {
      ...ticketFromText(fileName.replace(/\.md$/, ""), cached.raw),
      path,
      projectId: project.id,
      column: col.id,
      lastModified: file.lastModified,
      bytes: file.size, // file size on disk; `size` is the S/M/L estimate
      fileName,
      handle,
      dirHandle: col.dir,
      projectDir: project.dir,
    };
  }

  async readText(ticket) {
    return (await ticket.handle.getFile()).text();
  }

  async writeTicket(ticket, raw, { force = false } = {}) {
    const current = await ticket.handle.getFile();
    if (!force && current.lastModified !== ticket.lastModified) throw new ConflictError();
    await writeFile(ticket.handle, raw);
    return { lastModified: (await ticket.handle.getFile()).lastModified };
  }

  async moveTicket(ticket, columnId) {
    const dest = await ticket.projectDir.getDirectoryHandle(columnId, { create: true });
    if (await fileExists(dest, ticket.fileName)) {
      throw new Error(`${columnId}/${ticket.fileName} already exists.`);
    }
    const moved = await moveFile(ticket, dest, ticket.fileName);
    return { lastModified: (await moved.getFile()).lastModified };
  }

  async createTicket(project, columnId, id, raw) {
    const dir = await project.dir.getDirectoryHandle(columnId, { create: true });
    const fileName = `${id}.md`;
    if (await fileExists(dir, fileName)) throw new Error(`${columnId}/${fileName} already exists.`);
    await writeFile(await dir.getFileHandle(fileName, { create: true }), raw);
  }

  async deleteTicket(ticket) {
    await ticket.dirHandle.removeEntry(ticket.fileName);
    this.cache.delete(ticket.path);
  }

  // Make the root folder a project named `name`: clonear.md at the current
  // format version, plus the default column folders.
  async initProject(name, prefix = defaultPrefix(name)) {
    const root = this.root;
    if (await fileExists(root, MARKER_FILE)) throw new Error(`${root.name}/${MARKER_FILE} already exists.`);
    const md = initClonearMd({ name, prefix });
    for (const col of DEFAULT_COLUMNS) await root.getDirectoryHandle(col, { create: true });
    await writeFile(await root.getFileHandle(MARKER_FILE, { create: true }), md);
  }

  // Rewrite name / prefix / labels in a project's clonear.md. `force` writes
  // over outside changes; the fields are applied to the file as it is now.
  // A new prefix renames the tickets using the current one first; clonear.md
  // is written last. Refuses before touching anything if a new name is taken.
  async writeSettings(project, fields, { force = false } = {}) {
    const { handle, lastModified } = project.marker;
    const current = await handle.getFile();
    if (!force && current.lastModified !== lastModified) throw new ConflictError();
    const renames = "prefix" in fields ? prefixRenames(project, fields.prefix) : [];
    const taken = new Set(project.columns.flatMap((c) => c.tickets.map((t) => t.id)));
    for (const { ticket, id } of renames) {
      if (taken.has(id) || (await fileExists(ticket.dirHandle, `${id}.md`))) throw new Error(`${id} already exists.`);
    }
    for (const { ticket, id } of renames) {
      await moveFile(ticket, ticket.dirHandle, `${id}.md`);
      this.cache.delete(ticket.path);
    }
    await writeFile(handle, updateClonearMd(await current.text(), fields));
    return { renamed: renames.length };
  }

  // Rewrite a project's clonear.md and tickets to FORMAT_VERSION. clonear.md
  // is written last, so the version only moves once every ticket is migrated.
  async migrateProject(dir) {
    const markerHandle = await dir.getFileHandle(MARKER_FILE);
    const clonearMd = await (await markerHandle.getFile()).text();
    const tickets = [];
    for (const col of await listEntries(dir)) {
      if (col.kind !== "directory") continue;
      for (const f of await listEntries(col.handle)) {
        if (f.kind !== "file" || !f.name.endsWith(".md")) continue;
        tickets.push({ path: `${col.name}/${f.name}`, handle: f.handle, raw: await (await f.handle.getFile()).text() });
      }
    }
    const out = migrate({ clonearMd, tickets });
    for (const t of out.tickets) await writeFile(t.handle, t.raw);
    await writeFile(markerHandle, out.clonearMd);
    return { tickets: out.tickets.length };
  }

  // Calls onChange() whenever something may have changed on disk. Uses
  // FileSystemObserver where available and polling as the fallback (and as a
  // slow safety net, since observers can drop events).
  async watch(onChange) {
    let observer = null;
    let debounce = null;
    const trigger = () => {
      clearTimeout(debounce);
      debounce = setTimeout(onChange, 120);
    };
    if (typeof window.FileSystemObserver === "function") {
      try {
        observer = new window.FileSystemObserver(trigger);
        await observer.observe(this.root, { recursive: true });
      } catch {
        observer = null;
      }
    }
    const interval = setInterval(onChange, observer ? 10000 : 1500);
    const onFocus = () => document.visibilityState === "visible" && trigger();
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return {
      mode: observer ? "live" : "polling",
      stop() {
        clearInterval(interval);
        clearTimeout(debounce);
        if (observer) observer.disconnect();
        document.removeEventListener("visibilitychange", onFocus);
        window.removeEventListener("focus", onFocus);
      },
    };
  }
}

// --------------------------------------------------------------------------- //
// Read-only backend: the files of a folder picked with <input webkitdirectory>
// --------------------------------------------------------------------------- //

// Build a directory tree from the picked files, shaped like the parts of
// FileSystemDirectoryHandle / FileSystemFileHandle that scan() uses, so the
// same scanning code reads it. Each file's webkitRelativePath starts with the
// picked folder's name.
export function directoryFromFiles(files) {
  const dir = (name) => ({
    kind: "directory",
    name,
    children: new Map(),
    async *entries() {
      yield* this.children;
    },
  });
  let root = null;
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split("/");
    root ||= dir(parts[0]);
    let node = root;
    for (const part of parts.slice(1, -1)) {
      if (!node.children.has(part)) node.children.set(part, dir(part));
      node = node.children.get(part);
    }
    const name = parts[parts.length - 1];
    node.children.set(name, { kind: "file", name, getFile: async () => file });
  }
  return root;
}

export class ReadOnlyBackend extends FsBackend {
  get readonly() {
    return true;
  }

  async hasPermission() {
    return true;
  }

  async writeTicket() {
    throw readOnlyError();
  }

  async moveTicket() {
    throw readOnlyError();
  }

  async createTicket() {
    throw readOnlyError();
  }

  async deleteTicket() {
    throw readOnlyError();
  }

  async initProject() {
    throw readOnlyError();
  }

  async writeSettings() {
    throw readOnlyError();
  }

  async migrateProject() {
    throw readOnlyError();
  }

  // A snapshot never changes; reopening the folder picks up outside changes.
  async watch() {
    return { mode: "readonly", stop() {} };
  }
}

const readOnlyError = () => new Error("This board is read-only in this browser.");

// Move a ticket's file to `dest` as `fileName` (another column, or a new
// name); returns the new file handle. FileSystemHandle.move() is
// Chromium-only and newer for user-visible files; fall back to copy + delete
// where it is missing or refused.
async function moveFile(ticket, dest, fileName) {
  if (typeof ticket.handle.move === "function") {
    try {
      await ticket.handle.move(dest, fileName);
      return ticket.handle;
    } catch {
      // The move may have gone through before failing; otherwise fall back.
      if (!(await fileExists(ticket.dirHandle, ticket.fileName))) return dest.getFileHandle(fileName);
    }
  }
  const raw = await (await ticket.handle.getFile()).text();
  const copy = await dest.getFileHandle(fileName, { create: true });
  await writeFile(copy, raw);
  await ticket.dirHandle.removeEntry(ticket.fileName);
  return copy;
}

async function writeFile(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Remember the opened folder, and the recently opened ones with their
// projects, per page URL (IndexedDB can store handles).
// --------------------------------------------------------------------------- //
const DB_NAME = "clonear";
const MAX_RECENT = 8;
const handleKey = () => location.origin + location.pathname;
const recentKey = () => `${handleKey()}#folders`;

function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

// Saves `handle` as the folder to reopen, and moves it to the front of the
// recent folders. `projects` ([{ id, name }]) replaces the ones remembered
// for it; without it they are kept. Saves run one at a time, so two
// read-modify-writes of the list can't drop a folder.
let saving = Promise.resolve();
export function saveHandle(handle, projects = null) {
  saving = saving.catch(() => {}).then(() => writeRecent(handle, projects));
  return saving;
}

async function writeRecent(handle, projects) {
  const others = [];
  let known = [];
  for (const f of await loadRecentFolders()) {
    if (await f.handle.isSameEntry(handle).catch(() => false)) known = f.projects;
    else others.push(f);
  }
  const recent = [{ handle, projects: projects || known }, ...others].slice(0, MAX_RECENT);
  return withStore("readwrite", (s) => {
    s.put(recent, recentKey());
    return s.put(handle, handleKey());
  });
}

// [{ handle, projects: [{ id, name }] }], most recently opened first.
export const loadRecentFolders = () =>
  withStore("readonly", (s) => s.get(recentKey())).then((r) => r || [], () => []);
export const loadHandle = () => withStore("readonly", (s) => s.get(handleKey())).catch(() => null);
export const forgetHandle = () => withStore("readwrite", (s) => s.delete(handleKey()));
