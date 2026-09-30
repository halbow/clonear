# Cloinear

A tiny, Linear-style kanban board whose **backend is just folders and files**.
No database, no npm, no server: one HTML file, `dist/cloinear.html`.

Copy it into any repo (or use the GitHub Pages copy), open it in Chrome/Edge/Arc,
pick the ticket folder once, and you can drag, edit, create and delete tickets.
Every change is written straight to the `.md` files, and changes made on disk (by
you, git, or an agent) show up on the board within a second.

- **A project** is a folder with a `cloinear.md` at its root, e.g. `tickets/`.
  Need several? Put one folder per project under `projects/`.
- **Columns** (`todo`, `in-progress`, `in-qa`, `done`) are subfolders.
- **Tickets** are markdown files inside a column folder.

Moving a ticket = moving its file to another column folder. Editing a ticket =
editing its file.

## Using the board

```bash
cp dist/cloinear.html ~/code/my-app/      # next to projects/ (or tickets/)
open ~/code/my-app/cloinear.html          # needs a Chromium browser
```

Click **Open folder** and pick the folder that holds your tickets. Any of these works:

- a folder containing `tickets/` or `projects/` (e.g. your repo root); that folder
  is either the project itself or holds one folder per project,
- a folder whose subfolders are projects (`<project>/cloinear.md`, `<project>/todo/…`),
- a single project folder with `cloinear.md`, `todo/`, `in-progress/`, `done/`… inside.

Folders without a `cloinear.md` are refused: the board lists them and says why.

To start a new project, click **Create** and pick a folder (e.g. a new
`tickets/` folder in your repo). The board writes a `cloinear.md` at the current
format version and the column folders into it, then opens it.

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

## Privacy: no network access

The board only reads and writes the folder you pick. It never talks to a server.
The browser enforces this: the page's Content-Security-Policy (first `<meta>` in
`dist/cloinear.html`) is

```
default-src 'none'; connect-src 'none'; img-src data:; form-action 'none'; …
```

so every request (fetch, images, fonts, scripts, WebSockets, beacons, form posts)
is refused, even if the code tried. Scripts are pinned by SHA-256 hash, so only
the bundled code can run. `tests/no-network.test.mjs` fails if the policy is
loosened or a network API shows up in `app/`.

To check it yourself: open DevTools → Network while you use the board, or turn
off Wi-Fi and see that it works the same. For the strongest guarantee, download
`dist/cloinear.html` and run the local copy, which you can inspect and hash; the
Pages copy changes with each deploy.

## How it works

`bundle.py` inlines `app/` (HTML, CSS and JS modules) into `dist/cloinear.html`.
Browsers refuse `<script src>` modules on `file://` pages, which is why the board
is a single file. The UI reads and writes the folder through the File System
Access API (`app/lib/store.js`). `bundle.py` is zero-dependency Python 3.

## Repository layout

```
tickets/                      # this repo's own tickets — open the repo root to see them
  cloinear.md                 # required: format version, name, columns, ticket template
  todo/CLO-2.md
  done/CLO-1.md
demo/                         # demo / test data — open this folder to try the board
  web-app/
    cloinear.md
    todo/WEB-1.md
    in-progress/WEB-2.md
    in-qa/WEB-5.md
    done/WEB-3.md
  mobile-app/
app/                          # UI (never mixed with data)
  index.html  app.js  styles.css
  lib/format.js               # cloinear.md format: semver checks, init template, migrations
  lib/frontmatter.js          # parse / rewrite ticket files, render markdown
  lib/search.js               # ticket search
  lib/store.js                # read / write the local folder
dist/cloinear.html            # generated single-file board (committed; run bundle.py)
tests/                        # node --test tests/*.test.mjs
bundle.py                     # app/ -> dist/cloinear.html
```

## cloinear.md

Every project folder has a `cloinear.md` next to its column folders:

```
tickets/
  cloinear.md
  todo/
  in-progress/
  done/
```

It does three things:

- **Marks the folder as a Cloinear project.** The board refuses folders without one.
- **Pins the format version** (`version: 1.0.0`, semver). See [Format versions](#format-versions).
- **Documents the ticket format.** Its body has a full template ticket with every
  field filled in and the allowed values, so an agent can read it and create or edit
  tickets correctly.

```markdown
---
version: 1.0.0                             # required: cloinear.md format version (semver)
name: Mobile App                           # optional: display name (default: from folder name)
columns: [todo, in-progress, in-qa, done]  # optional: column order (default shown)
---

Description, then the ticket template (see tickets/cloinear.md).
```

Column folders that exist on disk but are missing from `columns` are added at the end.

### Format versions

`version` is the version of the ticket layout, and `FORMAT_VERSION` in
`app/lib/format.js` is the one this board reads. They are compared with semver:

| File's version vs. the board's | What the board does |
| --- | --- |
| Same, or older with the same major | Reads it. |
| Newer minor/patch (additions only) | Reads it, with a notice. Fields it doesn't know are ignored and kept on save. |
| Newer major (breaking change) | Refuses it with a warning: update the board. |
| Older major | Refuses it, with a **Migrate** button that rewrites `cloinear.md` and every ticket to the current version. |

A plain integer (`version: 1`, from before semver) reads as `1.0.0`.

A breaking change bumps the major and adds a step to `MIGRATIONS` in
`app/lib/format.js` that rewrites `cloinear.md` and each ticket from the previous
major. Migrations run in order and `cloinear.md` is written last, so its version
only changes once every ticket is migrated. Commit before migrating, so you can
review the diff.

## Ticket format

`tickets/<column>/<TICKET-ID>.md` (or `projects/<project>/<column>/<TICKET-ID>.md`):

```markdown
---
title: Fix login redirect loop
assignee: alexis
priority: high            # urgent | high | medium | low (default: low)
size: M                   # S | M | L (t-shirt estimate)
labels: [bug, auth]
created: 2026-07-14
---

Markdown description here. Supports headings, lists, code, links, **bold**, *italic*.
```

Only `title` is required. The filename stem (`WEB-1`) is the ticket id; the parent
folder decides the column.

### Adding / moving / editing tickets

Use the board, or do it by hand — it's just files:

```bash
$EDITOR tickets/todo/CLO-9.md
git mv tickets/todo/CLO-9.md tickets/in-progress/CLO-9.md
```

### Adding a project

Click **Create** in the board and pick the new project folder. By hand: create `tickets/` with column
subfolders and copy this repo's `tickets/cloinear.md` into it (change `name` and
the ticket prefix). For several,
create `projects/<name>/` for each one, laid out the same way.

## Development

Edit `app/`, then run `python3 bundle.py` (or `just bundle`) and reload
`dist/cloinear.html`. CI fails if the bundle is stale.

| Recipe | What it does |
| --- | --- |
| `just open` | Open `dist/cloinear.html` in your default browser |
| `just bundle` | Regenerate `dist/cloinear.html` from `app/` |
| `just test` | Run the unit tests (needs Node) |
| `just check` | Run the tests and fail if `dist/cloinear.html` is stale |

## GitHub Pages

`.github/workflows/pages.yml` runs the checks and publishes `dist/cloinear.html`
as the site's index page on every push to `main`. Enable it once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Roadmap

- Reordering cards within a column (cards are sorted by priority, then date).
- Filtering, cycles, comments.
