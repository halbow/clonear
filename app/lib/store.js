// Board storage: a local folder opened with the File System Access API
// (showDirectoryPicker). Read-write, watches the folder for outside changes.
// FsBackend exposes this shape to the UI:
//
//   scan()                         -> { projects: [{ id, name, columns: [{ id, label, tickets }] }],
//                                       rejected: [{ id, reason }] }
//   readText(ticket)               -> the file's current content
//   writeTicket(ticket, raw, opts) -> { lastModified }      (throws ConflictError)
//   moveTicket(ticket, columnId)   -> { lastModified }
//   createTicket(project, columnId, id, raw)
//   deleteTicket(ticket)
//   watch(onChange)                -> { mode, stop }
//
// Data model: <projects root>/<project>/<column>/<TICKET-ID>.md. Every project
// folder needs a <project>/cloinear.md: it marks the folder as a Cloinear
// project, pins the format version, sets the display name and column order, and
// holds a ticket template for people and agents. Folders without it are refused.

import { parseFrontmatter } from "./frontmatter.js";

export const DEFAULT_COLUMNS = ["todo", "in-progress", "in-qa", "done"];
// Version of the cloinear.md format this build understands.
export const FORMAT_VERSION = 1;
export const MARKER_FILE = "cloinear.md";

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
export const SIZES = ["S", "M", "L"];
const ACRONYMS = new Set(["qa", "ui", "ci", "api", "id", "ux"]);
// Folders that can hold projects when the user picks a repo root.
const CONTAINER_DIRS = ["projects", "tickets"];
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
    priority: priority in PRIORITY_ORDER ? priority : "none",
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

// Next free id in a project, e.g. WEB-6. Reuses the prefix already in use.
export function nextTicketId(project) {
  const ids = project.columns.flatMap((c) => c.tickets.map((t) => t.id));
  const parsed = ids.map((id) => id.match(/^([A-Za-z]+)-(\d+)$/)).filter(Boolean);
  const prefix =
    (parsed[0] && parsed[0][1]) || project.id.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "TIX";
  const max = Math.max(0, ...parsed.filter((m) => m[1] === prefix).map((m) => Number(m[2])));
  return `${prefix}-${max + 1}`;
}

// Build a project from its cloinear.md and column folder names. Returns
// { error } when the folder must be refused.
export function projectFromParts(id, cloinearMd, dirNames) {
  if (cloinearMd == null) return { error: `no ${MARKER_FILE}` };
  const { data } = parseFrontmatter(cloinearMd);
  const version = Number(data.version);
  if (!Number.isInteger(version) || version < 1) {
    return { error: `${MARKER_FILE} has no valid "version"` };
  }
  if (version > FORMAT_VERSION) {
    return { error: `${MARKER_FILE} is version ${version}; this board supports up to ${FORMAT_VERSION}` };
  }
  const name = typeof data.name === "string" && data.name ? data.name : titleize(id);
  const columns =
    Array.isArray(data.columns) && data.columns.length ? data.columns.filter(Boolean) : [...DEFAULT_COLUMNS];
  // Include every column folder that exists on disk, even if cloinear.md omits it.
  for (const d of dirNames) if (!columns.includes(d)) columns.push(d);
  return { id, name, version, columns: columns.map((c) => ({ id: c, label: titleize(c), tickets: [] })) };
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

const hasMarker = (entries) => entries.some((e) => e.kind === "file" && e.name === MARKER_FILE);
// Looks like a project but lacks cloinear.md: reported instead of silently skipped.
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

  async hasPermission() {
    return (await this.root.queryPermission({ mode: "readwrite" })) === "granted";
  }

  // Accepts: a single project folder, a folder containing projects/ or tickets/
  // (either a project itself or a folder of projects), or a folder whose
  // subfolders are projects. Only folders with a cloinear.md
  // are projects; lookalikes without one come back in `rejected`.
  async resolveProjects() {
    const entries = await listEntries(this.root);
    if (hasMarker(entries)) return { found: [{ id: this.root.name, dir: this.root, entries }], rejected: [] };
    if (looksLikeProject(entries)) return { found: [], rejected: [{ id: this.root.name, reason: `no ${MARKER_FILE}` }] };

    const container = entries.find((e) => e.kind === "directory" && CONTAINER_DIRS.includes(e.name));
    const baseEntries = container ? await listEntries(container.handle) : entries;
    // tickets/ (or projects/) can itself be the project: tickets/cloinear.md, tickets/todo/…
    if (container && hasMarker(baseEntries)) {
      return { found: [{ id: container.name, dir: container.handle, entries: baseEntries }], rejected: [] };
    }
    const found = [];
    const rejected = [];
    for (const e of baseEntries) {
      if (e.kind !== "directory" || SKIP_DIRS.has(e.name)) continue;
      const sub = await listEntries(e.handle);
      if (hasMarker(sub)) found.push({ id: e.name, dir: e.handle, entries: sub });
      else if (container || looksLikeProject(sub)) rejected.push({ id: e.name, reason: `no ${MARKER_FILE}` });
    }
    return { found, rejected };
  }

  async scan() {
    const { found, rejected } = await this.resolveProjects();
    const scanned = await Promise.all(found.map((p) => this.scanProject(p)));
    const projects = [];
    for (const p of scanned) {
      if (p.error) rejected.push({ id: p.id, reason: p.error });
      else projects.push(p);
    }
    return { projects, rejected };
  }

  async scanProject({ id, dir, entries }) {
    const markerEntry = entries.find((e) => e.kind === "file" && e.name === MARKER_FILE);
    const cloinearMd = await (await markerEntry.handle.getFile()).text();
    const dirs = entries.filter((e) => e.kind === "directory");
    const project = projectFromParts(id, cloinearMd, dirs.map((d) => d.name));
    if (project.error) return { id, error: project.error };
    project.dir = dir;

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
    // FileSystemHandle.move() is Chromium-only and newer for user-visible files;
    // fall back to copy + delete where it is missing or refused.
    if (typeof ticket.handle.move === "function") {
      try {
        await ticket.handle.move(dest);
        return { lastModified: (await ticket.handle.getFile()).lastModified };
      } catch {
        // The move may have gone through before failing; otherwise fall back.
        if (!(await fileExists(ticket.dirHandle, ticket.fileName))) {
          const moved = await dest.getFileHandle(ticket.fileName);
          return { lastModified: (await moved.getFile()).lastModified };
        }
      }
    }
    const raw = await (await ticket.handle.getFile()).text();
    const copy = await dest.getFileHandle(ticket.fileName, { create: true });
    await writeFile(copy, raw);
    await ticket.dirHandle.removeEntry(ticket.fileName);
    return { lastModified: (await copy.getFile()).lastModified };
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
// Remember the opened folder per page URL (IndexedDB can store handles).
// --------------------------------------------------------------------------- //
const DB_NAME = "cloinear";
const handleKey = () => location.origin + location.pathname;

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

export const saveHandle = (handle) => withStore("readwrite", (s) => s.put(handle, handleKey()));
export const loadHandle = () => withStore("readonly", (s) => s.get(handleKey())).catch(() => null);
export const forgetHandle = () => withStore("readwrite", (s) => s.delete(handleKey()));
