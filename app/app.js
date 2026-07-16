import { stripFrontmatter, renderMarkdown } from "./lib/frontmatter.js";

// The manifest lives at the repo root, one level above app/.
const MANIFEST_URL = "../manifest.json";

const PRIORITIES = {
  urgent: { label: "Urgent", cls: "prio-urgent" },
  high: { label: "High", cls: "prio-high" },
  medium: { label: "Medium", cls: "prio-medium" },
  low: { label: "Low", cls: "prio-low" },
  none: { label: "No priority", cls: "prio-none" },
};

const state = {
  manifest: null,
  projectId: null,
};

const els = {
  board: document.getElementById("board"),
  select: document.getElementById("project-select"),
  count: document.getElementById("ticket-count"),
  drawer: document.getElementById("drawer"),
  drawerOverlay: document.getElementById("drawer-overlay"),
  drawerContent: document.getElementById("drawer-content"),
  drawerClose: document.getElementById("drawer-close"),
};

init();

async function init() {
  els.select.addEventListener("change", () => {
    selectProject(els.select.value, { pushUrl: true });
  });
  els.drawerClose.addEventListener("click", closeDrawer);
  els.drawerOverlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  window.addEventListener("popstate", syncFromUrl);

  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.manifest = await res.json();
  } catch (err) {
    renderError(
      "Could not load manifest.json.",
      "Run <code>python3 build.py</code>, then serve the folder over HTTP " +
        "(<code>python3 -m http.server</code>) — opening via file:// will not work."
    );
    return;
  }

  const projects = state.manifest.projects || [];
  if (projects.length === 0) {
    renderError("No projects found.", "Add a folder under <code>projects/</code> and re-run <code>python3 build.py</code>.");
    return;
  }

  els.select.innerHTML = projects
    .map((p) => `<option value="${p.id}">${escapeAttr(p.name)}</option>`)
    .join("");

  syncFromUrl();
}

function syncFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const wanted = params.get("project");
  const projects = state.manifest.projects || [];
  const found = projects.find((p) => p.id === wanted);
  selectProject(found ? found.id : projects[0].id, { pushUrl: false });
}

function selectProject(projectId, { pushUrl }) {
  state.projectId = projectId;
  els.select.value = projectId;
  if (pushUrl) {
    const url = new URL(window.location);
    url.searchParams.set("project", projectId);
    window.history.pushState({}, "", url);
  }
  renderBoard();
}

function currentProject() {
  return (state.manifest.projects || []).find((p) => p.id === state.projectId);
}

function renderBoard() {
  const project = currentProject();
  if (!project) return;

  const order = project.columnOrder || Object.keys(project.columns);
  let total = 0;

  els.board.innerHTML = "";
  for (const colId of order) {
    const tickets = project.columns[colId] || [];
    total += tickets.length;
    const label = (project.columnLabels && project.columnLabels[colId]) || colId;

    const column = document.createElement("section");
    column.className = "column";
    column.innerHTML = `
      <div class="column-header">
        <span class="column-title">${escapeHtml(label)}</span>
        <span class="column-count">${tickets.length}</span>
      </div>
      <div class="column-cards"></div>
    `;
    const cardsEl = column.querySelector(".column-cards");

    if (tickets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "column-empty";
      empty.textContent = "No tickets";
      cardsEl.appendChild(empty);
    } else {
      for (const ticket of tickets) {
        cardsEl.appendChild(renderCard(ticket));
      }
    }
    els.board.appendChild(column);
  }

  els.count.textContent = `${total} ticket${total === 1 ? "" : "s"}`;
}

function renderCard(ticket) {
  const prio = PRIORITIES[ticket.priority] || PRIORITIES.none;
  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "button");

  const labels = (ticket.labels || [])
    .map((l) => `<span class="chip">${escapeHtml(l)}</span>`)
    .join("");

  card.innerHTML = `
    <div class="card-top">
      <span class="card-id">${escapeHtml(ticket.id)}</span>
      <span class="prio ${prio.cls}" title="${prio.label}"></span>
    </div>
    <div class="card-title">${escapeHtml(ticket.title)}</div>
    <div class="card-labels">${labels}</div>
    <div class="card-footer">
      ${ticket.assignee ? `<span class="avatar" title="${escapeAttr(ticket.assignee)}">${initials(ticket.assignee)}</span>` : ""}
      ${ticket.created ? `<span class="card-date">${escapeHtml(ticket.created)}</span>` : ""}
    </div>
  `;

  const open = () => openTicket(ticket);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return card;
}

async function openTicket(ticket) {
  const prio = PRIORITIES[ticket.priority] || PRIORITIES.none;
  const labels = (ticket.labels || [])
    .map((l) => `<span class="chip">${escapeHtml(l)}</span>`)
    .join("");

  els.drawerContent.innerHTML = `
    <div class="dt-id">${escapeHtml(ticket.id)}</div>
    <h1 class="dt-title">${escapeHtml(ticket.title)}</h1>
    <dl class="dt-meta">
      <div><dt>Priority</dt><dd><span class="prio ${prio.cls}"></span> ${prio.label}</dd></div>
      <div><dt>Assignee</dt><dd>${ticket.assignee ? escapeHtml(ticket.assignee) : "—"}</dd></div>
      <div><dt>Created</dt><dd>${ticket.created ? escapeHtml(ticket.created) : "—"}</dd></div>
      <div><dt>Labels</dt><dd class="dt-labels">${labels || "—"}</dd></div>
    </dl>
    <div class="dt-body" id="dt-body"><p class="dt-loading">Loading description…</p></div>
    <div class="dt-source"><a href="../${escapeAttr(ticket.path)}" target="_blank" rel="noopener">View raw file →</a></div>
  `;
  openDrawer();

  try {
    const res = await fetch(`../${ticket.path}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const body = stripFrontmatter(raw).trim();
    const bodyEl = document.getElementById("dt-body");
    bodyEl.innerHTML = body ? renderMarkdown(body) : `<p class="dt-empty">No description.</p>`;
  } catch (err) {
    const bodyEl = document.getElementById("dt-body");
    if (bodyEl) bodyEl.innerHTML = `<p class="dt-empty">Could not load description.</p>`;
  }
}

function openDrawer() {
  els.drawer.hidden = false;
  els.drawerOverlay.hidden = false;
  els.drawer.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => els.drawer.classList.add("open"));
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.drawer.hidden = true;
  els.drawerOverlay.hidden = true;
}

function renderError(title, detail) {
  els.board.innerHTML = `
    <div class="error-panel">
      <h2>${escapeHtml(title)}</h2>
      <p>${detail}</p>
    </div>
  `;
}

// --- small utilities ---
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
