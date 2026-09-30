// Board storage backends. Both expose the same shape to the UI:
//
//   scan()                         -> { projects: [{ id, name, columns: [{ id, label, tickets }] }] }
//   readText(ticket)               -> the file's current content
//   writeTicket(ticket, raw, opts) -> { lastModified }      (throws ConflictError)
//   moveTicket(ticket, columnId)   -> { lastModified }
//   createTicket(project, columnId, id, raw)
//   deleteTicket(ticket)
//   watch(onChange)                -> { mode, stop }
//
// - FsBackend: a local folder opened with the File System Access API
//   (showDirectoryPicker). Read-write, watches the folder for outside changes.
// - HttpBackend: the manifest.json produced by build.py, served over HTTP.
//   Read-only; used for the GitHub Pages deploy.
//
// Data model: <projects root>/<project>/<column>/<TICKET-ID>.md, with an
// optional <project>/project.md that sets the display name and column order.

import { parseFrontmatter } from "./frontmatter.js";

export const DEFAULT_COLUMNS = ["todo", "in-progress", "in-qa", "done"];

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

function projectFromParts(id, projectMd, dirNames) {
  let name = titleize(id);
  let columns = [...DEFAULT_COLUMNS];
  if (projectMd) {
    const { data } = parseFrontmatter(projectMd);
    if (typeof data.name === "string" && data.name) name = data.name;
    if (Array.isArray(data.columns) && data.columns.length) columns = data.columns.filter(Boolean);
  }
  // Include every column folder that exists on disk, even if project.md omits it.
  for (const d of dirNames) if (!columns.includes(d)) columns.push(d);
  return { id, name, columns: columns.map((c) => ({ id: c, label: titleize(c), tickets: [] })) };
}

// --------------------------------------------------------------------------- //
// File System Access backend
// --------------------------------------------------------------------------- //
export const fsSupported = typeof window.showDirectoryPicker === "function";

async function listEntries(dir) {
  const entries = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    entries.push({ name, kind: handle.kind, handle });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const looksLikeProject = (entries) =>
  entries.some(
    (e) =>
      (e.kind === "file" && e.name === "project.md") ||
      (e.kind === "directory" && DEFAULT_COLUMNS.includes(e.name))
  );

export class FsBackend {
  readOnly = false;

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

  // Accepts: a single project folder, a folder containing projects/ or tickets/,
  // or a folder whose subfolders are projects.
  async resolveProjects() {
    const entries = await listEntries(this.root);
    if (looksLikeProject(entries)) return [{ id: this.root.name, dir: this.root, entries }];

    const container = entries.find((e) => e.kind === "directory" && CONTAINER_DIRS.includes(e.name));
    const baseEntries = container ? await listEntries(container.handle) : entries;
    const found = [];
    for (const e of baseEntries) {
      if (e.kind !== "directory" || SKIP_DIRS.has(e.name)) continue;
      const sub = await listEntries(e.handle);
      if (container || looksLikeProject(sub)) found.push({ id: e.name, dir: e.handle, entries: sub });
    }
    return found;
  }

  async scan() {
    const found = await this.resolveProjects();
    const projects = await Promise.all(found.map((p) => this.scanProject(p)));
    return { projects };
  }

  async scanProject({ id, dir, entries }) {
    const projectMdEntry = entries.find((e) => e.kind === "file" && e.name === "project.md");
    const projectMd = projectMdEntry ? await (await projectMdEntry.handle.getFile()).text() : null;
    const dirs = entries.filter((e) => e.kind === "directory");
    const project = projectFromParts(id, projectMd, dirs.map((d) => d.name));
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
// Read-only HTTP backend (manifest.json from build.py)
// --------------------------------------------------------------------------- //
export class HttpBackend {
  readOnly = true;
  name = "manifest.json";

  constructor(baseUrl) {
    this.baseUrl = baseUrl; // URL of the repo root, which holds manifest.json
  }

  async scan() {
    const res = await fetch(new URL("manifest.json", this.baseUrl), { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
    const manifest = await res.json();
    const projects = await Promise.all(
      (manifest.projects || []).map(async (p) => {
        const project = projectFromParts(p.id, null, []);
        project.name = p.name;
        project.columns = await Promise.all(
          (p.columnOrder || Object.keys(p.columns)).map(async (colId) => ({
            id: colId,
            label: (p.columnLabels && p.columnLabels[colId]) || titleize(colId),
            tickets: sortTickets(
              await Promise.all(
                (p.columns[colId] || []).map(async (t) => {
                  const raw = await fetch(new URL(t.path, this.baseUrl), { cache: "no-cache" })
                    .then((r) => (r.ok ? r.text() : ""))
                    .catch(() => "");
                  return { ...ticketFromText(t.id, raw), path: t.path, projectId: p.id, column: colId };
                })
              )
            ),
          }))
        );
        return project;
      })
    );
    return { projects };
  }

  async watch() {
    return { mode: "read-only", stop() {} };
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
