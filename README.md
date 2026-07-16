# Cloinear

A tiny, Linear-style kanban board whose **backend is just folders and files** in
this repo. No database, no npm, no runtime server — a fully static site you can
host on **GitHub Pages**.

- **Projects** are folders under `projects/`.
- **Columns** (`todo`, `in-progress`, `in-qa`, `done`) are subfolders.
- **Tickets** are markdown files inside a column folder.

Moving a ticket = moving its file to another column folder. Editing a ticket =
editing its file. Every change is a normal git commit and shows up on the board
after a rebuild.

## How it works

A static host can't list a directory's contents, so a small build step scans the
folder tree and writes `manifest.json` — the index the UI reads over HTTP.

```
projects/ ──scan──> manifest.json ──fetch──> app/ (the board UI)
        build.py                    browser
```

- `build.py` — zero-dependency Python 3 scanner (standard library only).
- `app/` — the UI (`index.html`, `app.js`, `styles.css`, `lib/frontmatter.js`).
- `.github/workflows/pages.yml` — runs `build.py` and deploys to Pages on push.

`manifest.json` is **generated** (git-ignored). It is rebuilt in CI on every push,
so you never commit or hand-maintain it.

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
  index.html  app.js  styles.css  lib/frontmatter.js
build.py                      # scanner -> manifest.json
index.html                    # redirect to app/ (Pages entry point)
manifest.json                 # generated (git-ignored)
```

## Ticket format

`projects/<project>/<column>/<TICKET-ID>.md`:

```markdown
---
title: Fix login redirect loop
assignee: alexis
priority: high            # urgent | high | medium | low | none
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
just new web-app todo "Fix flaky logout" high alexis bug,auth  # create (auto-ids WEB-6)
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
| `just serve [port]` | Build, then serve at `http://localhost:8000` |
| `just list [project]` | List projects, or one project's tickets by column |
| `just new <project> <column> "<title>" [priority] [assignee] [labels]` | Create a ticket (auto-generates the id) |
| `just move <project> <id> <column>` | Move a ticket to another column |
| `just edit <project> <id>` | Open a ticket in `$EDITOR` |
| `just rm <project> <id>` | Delete a ticket |
| `just new-project <id> ["Display Name"]` | Scaffold a project with the default columns |

`move` / `rm` use `git mv` / `git rm` automatically when run inside a git repo,
and fall back to plain `mv` / `rm` otherwise.

## Run locally

The UI fetches files over HTTP, so use a static server (not `file://`):

```bash
python3 build.py             # generate manifest.json
python3 -m http.server 8000  # serve the repo root
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this repo to GitHub (default branch `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push any change — the workflow runs `build.py` and publishes the board.

## Roadmap (not in v1)

- In-browser authoring: a "new ticket" helper that emits a ready-to-commit file,
  or full write-back via the GitHub API.
- Search / filtering, cycles, comments.
