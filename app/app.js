import { renderMarkdown, updateTicketText } from "./lib/frontmatter.js";
import { FORMAT_VERSION } from "./lib/format.js";
import { scoreTicket } from "./lib/search.js";
import {
  CONTAINER_DIRS,
  ConflictError,
  FsBackend,
  SIZES,
  fsSupported,
  loadHandle,
  loadRecentFolders,
  nextTicketId,
  saveHandle,
  ticketFromText,
  titleize,
} from "./lib/store.js";

const PRIORITIES = {
  urgent: { label: "Urgent", cls: "prio-urgent" },
  high: { label: "High", cls: "prio-high" },
  medium: { label: "Medium", cls: "prio-medium" },
  low: { label: "Low", cls: "prio-low" },
};

const AUTOSAVE_MS = 600;

const state = {
  backend: null,
  watcher: null,
  board: null, // { projects }
  signature: "",
  projectId: null,
  scanning: null, // in-flight refresh: { backend, promise }
  rescan: false,
  dragging: null, // { projectId, ticketId }
  renderPending: false,
  drawer: null, // see openTicket / openCreate
  query: "", // top-bar search
  otherFolders: [], // recently opened folders other than the current one: [{ handle, projects }]
};

const els = {
  board: document.getElementById("board"),
  select: document.getElementById("project-select"),
  count: document.getElementById("ticket-count"),
  searchBox: document.getElementById("search-box"),
  search: document.getElementById("search"),
  sync: document.getElementById("sync-status"),
  newTicket: document.getElementById("new-ticket"),
  notices: document.getElementById("notices"),
  openFolder: document.getElementById("open-folder"),
  createProject: document.getElementById("create-project"),
  drawer: document.getElementById("drawer"),
  drawerOverlay: document.getElementById("drawer-overlay"),
  drawerContent: document.getElementById("drawer-content"),
  drawerClose: document.getElementById("drawer-close"),
  toasts: document.getElementById("toasts"),
};

boot();

// --------------------------------------------------------------------------- //
// Startup & connection
// --------------------------------------------------------------------------- //
async function boot() {
  els.select.addEventListener("change", onSelectChange);
  els.newTicket.addEventListener("click", () => openCreate(state.projectId));
  els.openFolder.addEventListener("click", pickFolder);
  els.createProject.addEventListener("click", createProject);
  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderBoard();
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (els.search.value) {
        els.search.value = state.query = "";
        renderBoard();
      } else {
        els.search.blur();
      }
    } else if (e.key === "Enter") {
      const first = els.board.querySelector(".card");
      if (first) first.click();
    }
  });
  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerOverlay.addEventListener("click", closeDrawer);
  window.addEventListener("hashchange", syncFromUrl);
  document.addEventListener("keydown", onGlobalKey);
  window.addEventListener("beforeunload", (e) => {
    if (state.drawer && state.drawer.dirty) e.preventDefault();
  });
  els.openFolder.hidden = els.createProject.hidden = !fsSupported;

  const stored = fsSupported ? await loadHandle() : null;
  if (stored) {
    const backend = new FsBackend(stored);
    if (await backend.hasPermission().catch(() => false)) return connect(backend);
    return renderStart({ stored });
  }
  renderStart({});
}

async function chooseDirectory() {
  try {
    return await window.showDirectoryPicker({ id: "clonear", mode: "readwrite" });
  } catch (err) {
    if (err.name !== "AbortError") toast(err.message, "error");
    return null;
  }
}

async function pickFolder() {
  const handle = await chooseDirectory();
  if (handle) connect(new FsBackend(handle));
}

// Pick a folder and make it a project (clonear.md + column folders), then open it.
async function createProject() {
  const handle = await chooseDirectory();
  if (!handle) return;
  // tickets/ or projects/ says nothing about the project, so don't suggest it.
  const suggested = CONTAINER_DIRS.includes(handle.name) ? "" : titleize(handle.name);
  const name = (prompt(`Name of the project in “${handle.name}”:`, suggested) || "").trim();
  if (!name) return;
  const backend = new FsBackend(handle);
  try {
    await backend.initProject(name);
    toast(`Created ${handle.name}/clonear.md (version ${FORMAT_VERSION}).`);
  } catch (err) {
    toast(`Could not create the project: ${err.message}`, "error");
    return;
  }
  connect(backend);
}

// `projectId`: the project to show once the folder is open.
async function reconnect(handle, projectId = null) {
  const perm = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
  if (perm !== "granted") return toast("Permission to the folder was not granted.", "error");
  if (projectId) location.hash = `project=${encodeURIComponent(projectId)}`;
  connect(new FsBackend(handle));
}

async function connect(backend) {
  if (state.watcher) state.watcher.stop();
  closeDrawer();
  Object.assign(state, { backend, watcher: null, board: null, signature: "" });
  await saveHandle(backend.root).catch(() => {});
  state.otherFolders = await otherFolders(backend.root);
  await refresh();
  if (state.backend !== backend || !state.board) return;
  state.watcher = await backend.watch(refresh);
  renderTopbar();
}

function disconnect(reason) {
  if (state.watcher) state.watcher.stop();
  const stored = state.backend instanceof FsBackend ? state.backend.root : null;
  closeDrawer();
  Object.assign(state, { backend: null, watcher: null, board: null, signature: "" });
  renderNotices();
  renderStart({ stored, reason });
}

// Rescan the backend; coalesces overlapping calls into one extra pass.
// A scan of a folder that was since switched away from is left to finish on
// its own (its result is dropped), so the new folder gets scanned right away.
function refresh() {
  const backend = state.backend;
  if (!backend) return Promise.resolve();
  if (state.scanning && state.scanning.backend === backend) {
    state.rescan = true;
    return state.scanning.promise;
  }
  const scan = { backend, promise: null };
  state.scanning = scan;
  scan.promise = (async () => {
    try {
      do {
        state.rescan = false;
        const board = await backend.scan();
        if (state.backend === backend) applyBoard(board);
      } while (state.rescan && state.backend === backend);
    } catch (err) {
      if (state.backend !== backend) return;
      if (err.name === "NotAllowedError" || err.name === "NotFoundError") {
        disconnect("Lost access to the folder.");
      } else {
        toast(`Could not read the folder: ${err.message}`, "error");
      }
    } finally {
      if (state.scanning === scan) state.scanning = null;
    }
  })();
  return scan.promise;
}

function applyBoard(board) {
  const signature = JSON.stringify([
    board.rejected,
    board.projects.map((p) => [
      p.id,
      p.name,
      p.version,
      p.columns.map((c) => [c.id, c.tickets.map((t) => [t.id, t.lastModified, t.bytes, t.size, t.raw.length])]),
    ]),
  ]);
  if (signature === state.signature) return;
  state.signature = signature;
  state.board = board;
  const names = board.projects.map((p) => ({ id: p.id, name: p.name }));
  saveHandle(state.backend.root, names).catch(() => {});

  renderProjectSelect();
  renderNotices();
  if (!board.projects.length) {
    renderStart({ empty: true });
    return;
  }
  syncFromUrl();
  syncDrawerWithDisk();
}

// --------------------------------------------------------------------------- //
// Projects & URL (#project=<id>, a hash so it also works on file://)
// --------------------------------------------------------------------------- //
function syncFromUrl() {
  if (!state.board || !state.board.projects.length) return;
  const wanted = new URLSearchParams(location.hash.slice(1)).get("project");
  const projects = state.board.projects;
  const found = projects.find((p) => p.id === wanted) || projects.find((p) => p.id === state.projectId);
  selectProject((found || projects[0]).id, { pushUrl: false });
}

function selectProject(projectId, { pushUrl }) {
  if (state.drawer && state.drawer.projectId !== projectId) closeDrawer();
  state.projectId = projectId;
  els.select.value = projectId;
  if (pushUrl) location.hash = `project=${encodeURIComponent(projectId)}`;
  renderBoard();
}

async function otherFolders(root) {
  const others = [];
  for (const f of await loadRecentFolders()) {
    if (!(await f.handle.isSameEntry(root).catch(() => false))) others.push(f);
  }
  return others;
}

// The dropdown lists the open folder's projects, then the projects of the
// other recent folders ("folder:<index>:<projectId>").
function onSelectChange() {
  const match = /^folder:(\d+):(.*)$/.exec(els.select.value);
  if (!match) return selectProject(els.select.value, { pushUrl: true });
  els.select.value = state.projectId;
  reconnect(state.otherFolders[Number(match[1])].handle, match[2] || null);
}

function currentProject() {
  return state.board && state.board.projects.find((p) => p.id === state.projectId);
}

function findTicket(projectId, ticketId) {
  const project = state.board && state.board.projects.find((p) => p.id === projectId);
  if (!project) return null;
  for (const col of project.columns) {
    const t = col.tickets.find((x) => x.id === ticketId);
    if (t) return t;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Rendering: top bar, start screen, board, cards
// --------------------------------------------------------------------------- //
function renderTopbar() {
  const backend = state.backend;
  const hasBoard = !!(backend && state.board && state.board.projects.length);
  els.select.hidden = !hasBoard;
  els.newTicket.hidden = !hasBoard;
  els.count.hidden = !hasBoard;
  els.searchBox.hidden = !hasBoard;

  const mode = state.watcher ? state.watcher.mode : null;
  if (!backend || !mode) {
    els.sync.hidden = true;
  } else {
    els.sync.hidden = false;
    els.sync.className = `sync-status sync-${mode}`;
    els.sync.textContent = backend.name;
    els.sync.title =
      mode === "live" ? "Watching the folder for changes" : "Checking the folder for changes every 1.5s";
  }
}

function renderProjectSelect() {
  const projects = state.board ? state.board.projects : [];
  const options = projects
    .map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");
  // A folder whose projects aren't known yet shows under its own name.
  const others = state.otherFolders
    .flatMap(({ handle, projects }, i) =>
      (projects.length ? projects : [{ id: "", name: handle.name }]).map(
        (p) => `<option value="folder:${i}:${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`
      )
    )
    .join("");
  els.select.innerHTML = others ? `${options}<hr>${others}` : options;
  if (state.projectId) els.select.value = state.projectId;
  renderTopbar();
}

function renderStart({ stored = null, reason = "", empty = false }) {
  renderTopbar();
  els.count.hidden = true;
  let body;
  if (!fsSupported) {
    body = `
      <h2>Open this board in Chrome, Edge or Arc</h2>
      <p>Clonear reads and writes your ticket folder with the File System Access API,
      which only Chromium-based browsers support.</p>`;
  } else if (empty) {
    const rejected = state.board ? state.board.rejected : [];
    body = `
      <h2>No Clonear project in “${escapeHtml(state.backend.name)}”</h2>
      <p>Each project folder needs a <code>clonear.md</code> next to its <code>todo/</code>,
      <code>done/</code>… subfolders. Pick a project folder, a folder of projects, or a
      folder containing <code>tickets/</code> or <code>projects/</code>. To start a new
      project, use <strong>Create</strong>.</p>
      ${
        rejected.length
          ? `<ul class="start-rejected">${rejected
              .map(
                (r, i) =>
                  `<li><strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.reason)}${rejectedAction(r, i)}</li>`
              )
              .join("")}</ul>`
          : ""
      }
      <div class="start-actions">
        <button class="btn btn-primary" data-action="pick">Choose another folder</button>
        <button class="btn" data-action="create">Create a project</button>
      </div>`;
  } else if (stored) {
    body = `
      <h2>${reason ? escapeHtml(reason) : "Welcome back"}</h2>
      <p>Allow access to <strong>${escapeHtml(stored.name)}</strong> to load the board.</p>
      <div class="start-actions">
        <button class="btn btn-primary" data-action="reconnect">Open “${escapeHtml(stored.name)}”</button>
        <button class="btn" data-action="pick">Choose another folder</button>
      </div>`;
  } else {
    body = `
      <h2>Open a ticket folder</h2>
      <p>Pick the folder that holds your tickets: the one containing <code>tickets/</code>,
      or a project folder with a <code>clonear.md</code> and <code>todo/</code>, <code>done/</code>…
      Changes you make here are written straight to the <code>.md</code> files, and changes made
      on disk show up here live.</p>
      <div class="start-actions">
        <button class="btn btn-primary" data-action="pick">Open folder</button>
        <button class="btn" data-action="create" title="Pick a folder and make it a Clonear project">Create a project</button>
      </div>`;
  }
  els.board.innerHTML = `<div class="start-panel">${body}</div>`;
  const pick = els.board.querySelector('[data-action="pick"]');
  if (pick) pick.addEventListener("click", pickFolder);
  const again = els.board.querySelector('[data-action="reconnect"]');
  if (again) again.addEventListener("click", () => reconnect(stored));
  const create = els.board.querySelector('[data-action="create"]');
  if (create) create.addEventListener("click", createProject);
  bindRejectedActions(els.board);
}

// Skipped projects and projects written by a newer board, shown above the board.
function renderNotices() {
  const board = state.board;
  const items = [];
  if (board && board.projects.length) {
    board.rejected.forEach((r, i) =>
      items.push(
        `<div class="notice notice-warn">Skipped <strong>${escapeHtml(r.id)}</strong>: ${escapeHtml(r.reason)}${rejectedAction(r, i)}</div>`
      )
    );
    for (const p of board.projects.filter((p) => p.newer)) {
      items.push(
        `<div class="notice notice-warn"><strong>${escapeHtml(p.name)}</strong> uses clonear.md ${escapeHtml(p.version)},
        newer than this board (${FORMAT_VERSION}). Fields it doesn't know are ignored and kept.</div>`
      );
    }
  }
  els.notices.hidden = !items.length;
  els.notices.innerHTML = items.join("");
  bindRejectedActions(els.notices);
}

function rejectedAction(r, i) {
  return r.action === "migrate" && r.dir
    ? ` <button class="btn" data-rejected="${i}">Migrate to ${FORMAT_VERSION}</button>`
    : "";
}

function bindRejectedActions(root) {
  for (const btn of root.querySelectorAll("[data-rejected]")) {
    const r = state.board.rejected[Number(btn.dataset.rejected)];
    btn.addEventListener("click", () => migrateProject(r));
  }
}

async function migrateProject(r) {
  try {
    const { tickets } = await state.backend.migrateProject(r.dir);
    toast(`Migrated ${r.id} to ${FORMAT_VERSION} (${tickets} ticket${tickets === 1 ? "" : "s"} rewritten).`);
  } catch (err) {
    toast(`Could not migrate ${r.id}: ${err.message}`, "error");
    return;
  }
  refresh();
}

function renderBoard() {
  if (state.dragging) {
    state.renderPending = true;
    return;
  }
  state.renderPending = false;
  const project = currentProject();
  if (!project) return;
  const query = state.query.trim();
  let total = 0;
  let shown = 0;

  els.board.innerHTML = "";
  for (const col of project.columns) {
    total += col.tickets.length;
    // While searching, keep only matches, best first.
    const tickets = query
      ? col.tickets
          .map((t) => ({ t, score: scoreTicket(t, query) }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((m) => m.t)
      : col.tickets;
    shown += tickets.length;
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.column = col.id;
    column.innerHTML = `
      <div class="column-header">
        <span class="column-title">${escapeHtml(col.label)}</span>
        <span class="column-count">${tickets.length}</span>
        <button class="column-add" title="New ticket in ${escapeAttr(col.label)}" aria-label="New ticket in ${escapeAttr(col.label)}">+</button>
      </div>
      <div class="column-cards"></div>
    `;
    const cardsEl = column.querySelector(".column-cards");
    if (tickets.length === 0) {
      cardsEl.innerHTML = `<div class="column-empty">${query ? "No matches" : "No tickets"}</div>`;
    } else {
      for (const ticket of tickets) cardsEl.appendChild(renderCard(ticket));
    }
    column.querySelector(".column-add").addEventListener("click", () => openCreate(project.id, col.id));
    bindDropTarget(column, project.id, col.id);
    els.board.appendChild(column);
  }
  els.count.hidden = false;
  els.count.textContent = query
    ? `${shown} of ${total} ticket${total === 1 ? "" : "s"}`
    : `${total} ticket${total === 1 ? "" : "s"}`;
}

function renderCard(ticket) {
  const prio = PRIORITIES[ticket.priority];
  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.dataset.id = ticket.id;

  const labels = ticket.labels.map((l) => `<span class="chip">${escapeHtml(l)}</span>`).join("");
  card.innerHTML = `
    <div class="card-top">
      <span class="card-id">${escapeHtml(ticket.id)}</span>
      <span class="card-badges">
        ${ticket.size ? `<span class="size" title="Size ${ticket.size}">${ticket.size}</span>` : ""}
        <span class="prio ${prio.cls}" title="${prio.label}"></span>
      </span>
    </div>
    <div class="card-title">${escapeHtml(ticket.title)}</div>
    <div class="card-labels">${labels}</div>
    <div class="card-footer">
      ${ticket.assignee ? `<span class="avatar" title="${escapeAttr(ticket.assignee)}">${initials(ticket.assignee)}</span>` : "<span></span>"}
      ${ticket.created ? `<span class="card-date">${escapeHtml(ticket.created)}</span>` : ""}
    </div>
  `;

  const open = () => openTicket(ticket.projectId, ticket.id);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    state.dragging = { projectId: ticket.projectId, ticketId: ticket.id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ticket.id);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    state.dragging = null;
    document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
    if (state.renderPending) renderBoard();
  });
  return card;
}

function bindDropTarget(column, projectId, columnId) {
  column.addEventListener("dragover", (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    column.classList.add("drop-target");
  });
  column.addEventListener("dragleave", (e) => {
    if (!column.contains(e.relatedTarget)) column.classList.remove("drop-target");
  });
  column.addEventListener("drop", (e) => {
    e.preventDefault();
    column.classList.remove("drop-target");
    const drag = state.dragging;
    if (!drag) return;
    const ticket = findTicket(drag.projectId, drag.ticketId);
    if (!ticket || ticket.column === columnId) return;
    // Optimistic: show the card in its new column right away.
    const card = els.board.querySelector(`.card[data-id="${CSS.escape(drag.ticketId)}"]`);
    const cards = column.querySelector(".column-cards");
    if (card) {
      cards.querySelector(".column-empty")?.remove();
      cards.prepend(card);
    }
    moveTicket(projectId, drag.ticketId, columnId);
  });
}

// --------------------------------------------------------------------------- //
// Mutations
// --------------------------------------------------------------------------- //
async function moveTicket(projectId, ticketId, columnId) {
  const ticket = findTicket(projectId, ticketId);
  if (!ticket || ticket.column === columnId) return;
  const d = state.drawer;
  if (d && d.ticketId === ticketId) await saveNow();
  try {
    const { lastModified } = await state.backend.moveTicket(findTicket(projectId, ticketId), columnId);
    if (d && d === state.drawer && d.ticketId === ticketId) d.base.lastModified = lastModified;
  } catch (err) {
    toast(`Could not move ${ticketId}: ${err.message}`, "error");
  }
  state.signature = ""; // force a re-render even if the optimistic DOM already matches
  await refresh();
}

// --------------------------------------------------------------------------- //
// Drawer: view / edit / create
// --------------------------------------------------------------------------- //
function openTicket(projectId, ticketId) {
  const ticket = findTicket(projectId, ticketId);
  if (!ticket) return;
  if (state.drawer) closeDrawer();
  state.drawer = {
    mode: "edit",
    projectId,
    ticketId,
    base: { raw: ticket.raw, lastModified: ticket.lastModified },
    dirty: false,
    version: 0,
    saving: null,
    saveTimer: null,
    conflict: false,
    deleted: false,
    bodyMode: ticket.body.trim() ? "preview" : "write",
  };
  buildDrawer();
  fillDrawer(ticket);
  showDrawer();
}

function openCreate(projectId, columnId) {
  const project = state.board.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (state.drawer) closeDrawer();
  state.drawer = { mode: "create", projectId, column: columnId || project.columns[0].id, bodyMode: "write" };
  buildDrawer();
  fillDrawer({
    id: nextTicketId(project),
    title: "",
    priority: "low",
    size: "",
    assignee: "",
    labels: [],
    created: today(),
    body: "",
    column: state.drawer.column,
  });
  showDrawer();
  document.getElementById("f-title").focus();
}

function buildDrawer() {
  const d = state.drawer;
  const project = state.board.projects.find((p) => p.id === d.projectId);
  const columnOptions = project.columns
    .map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label)}</option>`)
    .join("");
  const prioOptions = Object.entries(PRIORITIES)
    .map(([id, p]) => `<option value="${id}">${p.label}</option>`)
    .join("");
  const sizeOptions = ["", ...SIZES].map((s) => `<option value="${s}">${s || "—"}</option>`).join("");

  els.drawerContent.innerHTML = `
    <div class="dt-bar">
      <span class="dt-id-group">
        <span class="dt-id" id="f-id"></span>
        ${
          d.mode === "create"
            ? ""
            : `<button type="button" class="dt-copy" id="f-copy-id" title="Copy ticket ID" aria-label="Copy ticket ID">${COPY_ICON}</button>`
        }
      </span>
      <span class="dt-save" id="dt-save"></span>
    </div>
    <div class="dt-banner" id="dt-banner" hidden></div>
    <textarea class="dt-title" id="f-title" rows="1" placeholder="Ticket title"></textarea>
    <div class="dt-meta">
      <label><span>Status</span><select id="f-column">${columnOptions}</select></label>
      <label><span>Priority</span><select id="f-priority">${prioOptions}</select></label>
      <label><span>Size</span><select id="f-size">${sizeOptions}</select></label>
      <label id="f-assignee-row"><span>Assignee</span><input id="f-assignee" placeholder="—" /></label>
      <label><span>Labels</span><input id="f-labels" placeholder="bug, auth" /></label>
      <label id="f-created-row"><span>Created</span><span id="f-created" class="dt-static"></span></label>
    </div>
    <div class="dt-tabs">
      <button type="button" data-mode="write">Write</button>
      <button type="button" data-mode="preview">Preview</button>
    </div>
    <textarea class="dt-editor" id="f-body" placeholder="Add a description… (markdown)"></textarea>
    <div class="dt-body" id="f-preview"></div>
    <div class="dt-footer">
      <span class="dt-path" id="f-path"></span>
      <span class="dt-actions">
        ${
          d.mode === "create"
            ? `<button type="button" class="btn" data-action="cancel">Cancel</button>
               <button type="button" class="btn btn-primary" data-action="create">Create ticket</button>`
            : `<button type="button" class="btn btn-danger" data-action="delete">Delete</button>`
        }
      </span>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const title = $("f-title");
  autoGrow(title);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(); // titles are single-line
  });

  for (const id of ["f-title", "f-assignee", "f-labels", "f-body"]) {
    $(id).addEventListener("input", onFieldInput);
  }
  $("f-priority").addEventListener("change", onFieldInput);
  $("f-size").addEventListener("change", onFieldInput);
  $("f-column").addEventListener("change", (e) => {
    if (d.mode === "create") d.column = e.target.value;
    else moveTicket(d.projectId, d.ticketId, e.target.value);
  });
  $("f-body").addEventListener("input", () => autoGrow($("f-body")));
  $("f-preview").addEventListener("click", (e) => {
    if (!e.target.closest("a")) setBodyMode("write", { focus: true });
  });
  els.drawerContent.querySelectorAll(".dt-tabs button").forEach((b) =>
    b.addEventListener("click", () => setBodyMode(b.dataset.mode, { focus: b.dataset.mode === "write" }))
  );

  if ($("f-copy-id")) $("f-copy-id").addEventListener("click", copyTicketId);

  const action = (name) => els.drawerContent.querySelector(`[data-action="${name}"]`);
  if (action("cancel")) action("cancel").addEventListener("click", closeDrawer);
  if (action("create")) action("create").addEventListener("click", createFromDrawer);
  if (action("delete")) {
    const btn = action("delete");
    let armed = null;
    btn.addEventListener("click", () => {
      if (!armed) {
        btn.textContent = "Click again to delete";
        armed = setTimeout(() => {
          armed = null;
          btn.textContent = "Delete";
        }, 3000);
        return;
      }
      clearTimeout(armed);
      deleteFromDrawer();
    });
  }
}

const COPY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function copyTicketId() {
  const btn = document.getElementById("f-copy-id");
  const id = state.drawer?.ticketId;
  if (!btn || !id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    toast("Couldn't copy to the clipboard.", "error");
    return;
  }
  btn.innerHTML = CHECK_ICON;
  btn.title = "Copied";
  btn.classList.add("copied");
  clearTimeout(btn.resetTimer);
  btn.resetTimer = setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.title = "Copy ticket ID";
    btn.classList.remove("copied");
  }, 1500);
}

function fillDrawer(t) {
  const d = state.drawer;
  const $ = (id) => document.getElementById(id);
  $("f-id").textContent = t.id;
  $("f-title").value = t.title;
  $("f-priority").value = t.priority;
  $("f-size").value = t.size;
  $("f-assignee").value = t.assignee;
  // Hide unset fields on existing tickets; a new ticket still offers Assignee.
  $("f-assignee-row").hidden = !t.assignee && d.mode !== "create";
  $("f-labels").value = t.labels.join(", ");
  $("f-created").textContent = t.created;
  $("f-created-row").hidden = !t.created;
  $("f-column").value = t.column;
  $("f-body").value = t.body;
  if (d.mode === "create") {
    $("f-path").textContent = `${d.projectId}/${t.column}/${t.id}.md`;
  } else {
    $("f-path").textContent = t.path;
  }
  autoGrow($("f-title"));
  setBodyMode(d.bodyMode);
}

function setBodyMode(mode, { focus = false } = {}) {
  const d = state.drawer;
  d.bodyMode = mode;
  const body = document.getElementById("f-body");
  const preview = document.getElementById("f-preview");
  const text = body.value.trim();
  body.hidden = mode !== "write";
  preview.hidden = mode !== "preview";
  if (mode === "preview") {
    preview.innerHTML = text ? renderMarkdown(text) : `<p class="dt-empty">No description.</p>`;
  } else {
    autoGrow(body);
    if (focus) body.focus();
  }
  els.drawerContent.querySelectorAll(".dt-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
}

function readForm() {
  const $ = (id) => document.getElementById(id);
  return {
    title: $("f-title").value.trim(),
    priority: $("f-priority").value,
    size: $("f-size").value,
    assignee: $("f-assignee").value.trim(),
    labels: $("f-labels").value.split(",").map((l) => l.trim()).filter(Boolean),
    body: $("f-body").value,
  };
}

function onFieldInput() {
  const d = state.drawer;
  if (!d || d.mode !== "edit") return;
  d.dirty = true;
  d.version++;
  setSaveStatus("Unsaved");
  clearTimeout(d.saveTimer);
  d.saveTimer = setTimeout(saveNow, AUTOSAVE_MS);
}

// Write the drawer's edits to disk. Only fields that actually changed are
// touched, so unknown frontmatter keys and formatting survive a save.
async function saveNow({ force = false } = {}) {
  const d = state.drawer;
  if (!d || d.mode !== "edit") return;
  clearTimeout(d.saveTimer);
  // Read the form now: the drawer DOM may be replaced while we wait below.
  const form = readForm();
  const version = d.version;
  while (d.saving) await d.saving;
  if (!d.dirty || d.deleted || (d.conflict && !force)) return;
  if (d.version !== version && d === state.drawer) return; // newer edits have their own save queued
  const ticket = findTicket(d.projectId, d.ticketId);
  if (!ticket) return;

  const before = ticketFromText(ticket.id, d.base.raw);
  const fields = {};
  if ((form.title || ticket.id) !== before.title) fields.title = form.title || ticket.id;
  if (form.priority !== before.priority) fields.priority = form.priority;
  if (form.size !== before.size) fields.size = form.size;
  if (form.assignee !== before.assignee) fields.assignee = form.assignee;
  if (form.labels.join("\n") !== before.labels.join("\n")) fields.labels = form.labels;
  // Forcing after a conflict: apply our changed fields on top of the current
  // disk version (read fresh, not from the last scan), so outside edits to
  // other fields are kept.
  const onDisk = force ? await state.backend.readText(ticket).catch(() => ticket.raw) : d.base.raw;
  const raw = updateTicketText(onDisk, fields, form.body);
  const ui = (fn) => d === state.drawer && fn();

  ui(() => setSaveStatus("Saving…"));
  d.saving = state.backend
    .writeTicket({ ...ticket, lastModified: d.base.lastModified }, raw, { force })
    .then(({ lastModified }) => {
      d.base = { raw, lastModified };
      d.conflict = false;
      if (d.version === version) d.dirty = false;
      ui(() => {
        showBanner(null);
        setSaveStatus(d.dirty ? "Unsaved" : "Saved");
        if (force) fillDrawer({ ...ticket, ...ticketFromText(ticket.id, raw) }); // show the merged result
      });
    })
    .catch((err) => {
      ui(() => setSaveStatus("Not saved"));
      if (err instanceof ConflictError) {
        d.conflict = true;
        if (d === state.drawer) showConflictBanner();
        else toast(`${d.ticketId} changed on disk; your last edits were not saved.`, "error");
      } else {
        toast(`Could not save ${d.ticketId}: ${err.message}`, "error");
      }
    })
    .finally(() => {
      d.saving = null;
    });
  await d.saving;
  refresh();
}

async function createFromDrawer() {
  const d = state.drawer;
  const project = state.board.projects.find((p) => p.id === d.projectId);
  const form = readForm();
  if (!form.title) {
    document.getElementById("f-title").focus();
    toast("Give the ticket a title first.");
    return;
  }
  const id = nextTicketId(project);
  const raw = updateTicketText(
    "",
    {
      title: form.title,
      assignee: form.assignee,
      priority: form.priority,
      size: form.size,
      labels: form.labels,
      created: today(),
    },
    form.body
  );
  try {
    await state.backend.createTicket(project, d.column, id, raw);
  } catch (err) {
    toast(`Could not create the ticket: ${err.message}`, "error");
    return;
  }
  state.drawer = null;
  await refresh();
  openTicket(project.id, id);
}

async function deleteFromDrawer() {
  const d = state.drawer;
  const ticket = findTicket(d.projectId, d.ticketId);
  if (!ticket) return;
  clearTimeout(d.saveTimer);
  try {
    await state.backend.deleteTicket(ticket);
  } catch (err) {
    toast(`Could not delete ${ticket.id}: ${err.message}`, "error");
    return;
  }
  d.dirty = false;
  closeDrawer();
  toast(`Deleted ${ticket.id}.`);
  refresh();
}

// Called after every rescan: reflect outside changes in the open ticket.
function syncDrawerWithDisk() {
  const d = state.drawer;
  if (!d || d.mode !== "edit") return;
  const ticket = findTicket(d.projectId, d.ticketId);
  if (!ticket) {
    if (d.saving) return; // a move is in flight
    d.deleted = true;
    showBanner(`<span>This ticket was deleted or renamed on disk.</span>`);
    setSaveStatus("");
    return;
  }
  if (d.deleted) {
    d.deleted = false;
    showBanner(null);
  }
  document.getElementById("f-column").value = ticket.column;
  document.getElementById("f-path").textContent = ticket.path || "";
  if (ticket.raw === d.base.raw) {
    d.base.lastModified = ticket.lastModified; // e.g. moved, content untouched
    return;
  }
  if (d.saving) return; // our own write; the next rescan will settle
  if (d.dirty) {
    d.conflict = true;
    clearTimeout(d.saveTimer);
    setSaveStatus("Not saved");
    showConflictBanner();
    return;
  }
  d.base = { raw: ticket.raw, lastModified: ticket.lastModified };
  fillDrawer(ticket);
}

function showConflictBanner() {
  showBanner(`
    <span>This ticket changed on disk while you were editing.</span>
    <span class="dt-banner-actions">
      <button type="button" class="btn" data-banner="reload">Load disk version</button>
      <button type="button" class="btn btn-primary" data-banner="overwrite">Apply my changes</button>
    </span>`);
  const banner = document.getElementById("dt-banner");
  banner.querySelector('[data-banner="reload"]').addEventListener("click", () => {
    const d = state.drawer;
    const ticket = findTicket(d.projectId, d.ticketId);
    if (!ticket) return;
    Object.assign(d, { dirty: false, conflict: false, base: { raw: ticket.raw, lastModified: ticket.lastModified } });
    showBanner(null);
    setSaveStatus("");
    fillDrawer(ticket);
  });
  banner.querySelector('[data-banner="overwrite"]').addEventListener("click", () => saveNow({ force: true }));
}

function showBanner(html) {
  const banner = document.getElementById("dt-banner");
  if (!banner) return;
  banner.hidden = !html;
  banner.innerHTML = html || "";
}

function setSaveStatus(text) {
  const el = document.getElementById("dt-save");
  if (el) el.textContent = text;
}

function showDrawer() {
  els.drawer.hidden = false;
  els.drawerOverlay.hidden = false;
  els.drawer.setAttribute("aria-hidden", "false");
  // Textareas can only measure their content once the drawer is displayed.
  autoGrow(document.getElementById("f-title"));
  if (state.drawer.bodyMode === "write") autoGrow(document.getElementById("f-body"));
  requestAnimationFrame(() => els.drawer.classList.add("open"));
}

function closeDrawer() {
  const d = state.drawer;
  if (d && d.mode === "edit" && d.dirty && !d.conflict) saveNow();
  state.drawer = null;
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.drawer.hidden = true;
  els.drawerOverlay.hidden = true;
}

function onGlobalKey(e) {
  const d = state.drawer;
  if (e.key === "Escape" && d) {
    closeDrawer();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "s" && d) {
    e.preventDefault();
    saveNow();
  } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && d && d.mode === "create") {
    e.preventDefault();
    createFromDrawer();
  } else if (
    e.key === "/" && !d && !e.metaKey && !e.ctrlKey && !e.altKey &&
    !e.target.closest("input, textarea, select") && !els.searchBox.hidden
  ) {
    e.preventDefault();
    els.search.focus();
    els.search.select();
  } else if (
    e.key === "c" && !d && !e.metaKey && !e.ctrlKey && !e.altKey &&
    !e.target.closest("input, textarea, select") &&
    state.backend && currentProject()
  ) {
    e.preventDefault();
    openCreate(state.projectId);
  }
}

// --------------------------------------------------------------------------- //
// Small utilities
// --------------------------------------------------------------------------- //
function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function initials(name) {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
