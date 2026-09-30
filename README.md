# Cloinear

A tiny, Linear-style kanban board whose **backend is just folders and files**.
No database, no npm, no server:

- **Drop-in board:** copy the single file `dist/cloinear.html` into any repo, open
  it in Chrome/Edge/Arc, pick the ticket folder once, and you can drag, edit, create
  and delete tickets. Every change is written straight to the `.md` files, and changes
  made on disk (by you, git, or an agent) show up on the board within a second.
- **Read-only site** for **GitHub Pages**, built from this repo's `projects/`.

- **Projects** are folders under `projects/`.
- **Columns** (`todo`, `in-progress`, `in-qa`, `done`) are subfolders.
- **Tickets** are markdown files inside a column folder.

Moving a ticket = moving its file to another column folder. Editing a ticket =
editing its file.

## Drop-in board (`dist/cloinear.html`)

```bash
cp dist/cloinear.html ~/code/my-app/      # next to projects/ (or tickets/)
open ~/code/my-app/cloinear.html          # needs a Chromium browser
```

Click **Open folder** and pick the folder that holds your tickets. Any of these works:

- a folder containing `projects/` or `tickets/` (e.g. your repo root),
- a folder whose subfolders are projects (`<project>/todo/…`),
- a single project folder with `todo/`, `in-progress/`, `done/`… inside.

The board remembers the folder for that page. On later visits it opens it
automatically, or asks with one click, depending on the permission Chrome kept.

**What you can do:** search tickets (`/`, fuzzy on id and title, plain text on labels and description), drag cards between columns, click a card to edit its title,
status, priority, assignee, labels and markdown description (autosaved), create
tickets (`C`, or `+` on a column) and delete them. Saving only rewrites the fields you
changed, so any extra frontmatter keys you add are kept.

**Working alongside an agent:** the board watches the folder (with
`FileSystemObserver` where available, otherwise by polling every 1.5s). So an agent
running `git mv tickets/web/todo/WEB-3.md tickets/web/done/` moves the card on screen.
If a file changes on disk while you are editing it, you get a choice: load the disk
version, or apply your changes on top of it.

**Limits:** it only works in Chrome, Edge, Arc and other Chromium browsers, because it
uses the File System Access API. Safari and Firefox show a notice instead.

## How it works

The UI in `app/` talks to one of two storage backends (`app/lib/store.js`):

```
local folder ──File System Access API──> app/  (read-write, live)
projects/ ──build.py──> manifest.json ──fetch──> app/  (read-only, GitHub Pages)
```

- `bundle.py` inlines `app/` (HTML, CSS and JS modules) into `dist/cloinear.html`.
  Browsers refuse `<script src>` modules and `fetch()` on `file://` pages, which is
  why the drop-in board has to be a single file.
- `build.py` scans `projects/` into `manifest.json`, because a static host can't
  list directories. `manifest.json` is generated in CI (git-ignored).
- `.github/workflows/pages.yml` runs `build.py`, checks `dist/cloinear.html` is up to
  date, and deploys to Pages on push.

Both scripts are zero-dependency Python 3 (standard library only).

## Repository layout

```
projects/                     # DATA — the "backend"
  web-app/
    project.md                # optional: display name + column order
    todo/WEB-1.md
    in-progress/WEB-2.md
    in-qa/WEB-5.md
    done/WEB-3.md
app/                          # UI (never mixed with data)
  index.html  app.js  styles.css
  lib/frontmatter.js          # parse / rewrite ticket files, render markdown
  lib/store.js                # storage backends (local folder, manifest.json)
dist/cloinear.html            # generated single-file board (committed; run bundle.py)
tests/                        # node --test tests/*.test.mjs
build.py                      # scanner -> manifest.json
bundle.py                     # app/ -> dist/cloinear.html
index.html                    # redirect to dist/cloinear.html (entry point)
manifest.json                 # generated (git-ignored)
```

## Ticket format

`projects/<project>/<column>/<TICKET-ID>.md`:

```markdown
---
title: Fix login redirect loop
assignee: alexis
priority: high            # urgent | high | medium | low | none
size: M                   # S | M | L (t-shirt estimate)
labels: [bug, auth]
created: 2026-07-14
---

Markdown description here. Supports headings, lists, code, links, **bold**, *italic*.
```

Only `title` is required. The filename stem (`WEB-1`) is the ticket id; the parent
folder decides the column.

### Adding / moving / editing tickets

The quickest way is the [`justfile`](#task-runner-just) recipes:

```bash
just new web-app todo "Fix flaky logout" high alexis bug,auth M  # create (auto-ids WEB-6)
just move web-app WEB-6 in-progress                            # move across the board
just edit web-app WEB-6                                        # open in $EDITOR
just rm web-app WEB-6                                          # delete
```

Or do it by hand — it's just files:

```bash
$EDITOR projects/web-app/todo/WEB-9.md
git mv projects/web-app/todo/WEB-9.md projects/web-app/in-progress/WEB-9.md
git add -A && git commit -m "WEB-9: start work" && git push   # Pages rebuilds automatically
```

### Adding a project

Create `projects/<name>/` with column subfolders. Optionally add a `project.md`:

```markdown
---
name: Mobile App
columns: [todo, in-progress, in-qa, done]
---
```

Without `project.md`, the default columns are used and the display name is derived
from the folder name.

## Task runner (`just`)

If you have [`just`](https://github.com/casey/just), the `justfile` wraps every
common action (each one rebuilds `manifest.json` afterwards). Run `just` to list them:

| Recipe | What it does |
| --- | --- |
| `just build` | Regenerate `manifest.json` |
| `just bundle` | Regenerate `dist/cloinear.html` after changing `app/` |
| `just test` | Run the unit tests (needs Node) |
| `just check` | Fail if `manifest.json` or `dist/cloinear.html` is stale |
| `just serve [port]` | Build, then serve at `http://localhost:8000` |
| `just list [project]` | List projects, or one project's tickets by column |
| `just new <project> <column> "<title>" [priority] [assignee] [labels] [size]` | Create a ticket (auto-generates the id) |
| `just move <project> <id> <column>` | Move a ticket to another column |
| `just edit <project> <id>` | Open a ticket in `$EDITOR` |
| `just rm <project> <id>` | Delete a ticket |
| `just new-project <id> ["Display Name"]` | Scaffold a project with the default columns |

`move` / `rm` use `git mv` / `git rm` automatically when run inside a git repo,
and fall back to plain `mv` / `rm` otherwise.

## Run locally

To edit this repo's tickets, open `dist/cloinear.html` and pick the repo folder.

To preview the read-only Pages site, serve the repo over HTTP:

```bash
python3 build.py             # generate manifest.json
python3 -m http.server 8000  # serve the repo root
# open http://localhost:8000
```

When developing the UI, edit `app/` and serve it the same way (`app/index.html` loads
the modules directly). Run `python3 bundle.py` before committing so
`dist/cloinear.html` stays in sync. CI fails otherwise.

## Deploy to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push any change — the workflow runs `build.py` and publishes the board.

## Roadmap

- Write-back from the hosted Pages site via the GitHub API.
- Reordering cards within a column (cards are sorted by priority, then date).
- Search / filtering, cycles, comments.
