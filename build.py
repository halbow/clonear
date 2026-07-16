#!/usr/bin/env python3
"""Scan the projects/ folder tree and emit manifest.json.

The manifest is the folder *index* the static UI reads, because a static host
(GitHub Pages, python -m http.server, ...) cannot list a directory's contents.

Zero dependencies: python3 standard library only. Run it directly:

    python3 build.py            # write manifest.json
    python3 build.py --check    # exit 1 if manifest.json is missing or stale

Data model:
    projects/<project>/<column>/<TICKET-ID>.md
Each ticket is markdown with a YAML-ish frontmatter block delimited by --- fences.
An optional projects/<project>/project.md sets the display name and column order.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(ROOT, "projects")
MANIFEST_PATH = os.path.join(ROOT, "manifest.json")

DEFAULT_COLUMNS = ["todo", "in-progress", "in-qa", "done"]

# Priority ordering for sorting cards within a column (highest first).
PRIORITY_ORDER = {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}

# Tokens that should render fully uppercase when titleizing an id.
ACRONYMS = {"qa", "ui", "ci", "api", "id", "ux"}


# --------------------------------------------------------------------------- #
# Frontmatter parsing (tiny, dependency-free)
# --------------------------------------------------------------------------- #
def split_frontmatter(text):
    """Return (frontmatter_dict, body_str) from markdown `text`.

    Frontmatter is the block between a leading `---` line and the next `---`.
    If absent, returns ({}, text).
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            fm = parse_frontmatter("\n".join(lines[1:i]))
            body = "\n".join(lines[i + 1:]).strip("\n")
            return fm, body
    # No closing fence -> treat whole thing as body.
    return {}, text


def parse_frontmatter(block):
    """Parse the supported YAML subset: scalars, inline lists, block lists.

        key: value
        key: [a, b, c]
        key:
          - a
          - b
    """
    data = {}
    lines = block.split("\n")
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        i += 1
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value == "":
            # Possibly a block list on the following indented `- item` lines.
            items = []
            while i < len(lines) and lines[i].strip().startswith("- "):
                items.append(_scalar(lines[i].strip()[2:].strip()))
                i += 1
            data[key] = items
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            data[key] = [_scalar(v.strip()) for v in inner.split(",")] if inner else []
        else:
            data[key] = _scalar(value)
    return data


def _scalar(value):
    """Coerce a scalar string: strip quotes, keep everything else as text."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


# --------------------------------------------------------------------------- #
# Scanning
# --------------------------------------------------------------------------- #
def titleize(slug):
    words = []
    for word in slug.replace("_", "-").split("-"):
        if not word:
            continue
        words.append(word.upper() if word.lower() in ACRONYMS else word.capitalize())
    return " ".join(words) or slug


def read_ticket(path, rel_path):
    with open(path, "r", encoding="utf-8") as fh:
        fm, _body = split_frontmatter(fh.read())
    labels = fm.get("labels", [])
    if isinstance(labels, str):
        labels = [labels]
    ticket_id = os.path.splitext(os.path.basename(path))[0]
    return {
        "id": ticket_id,
        "path": rel_path,
        "title": fm.get("title", ticket_id),
        "assignee": fm.get("assignee", ""),
        "priority": fm.get("priority", "none"),
        "labels": labels,
        "created": fm.get("created", ""),
    }


def sort_key(ticket):
    prio = PRIORITY_ORDER.get(str(ticket.get("priority", "none")).lower(), 99)
    # Newer first within the same priority (created descending).
    return (prio, _neg_date(ticket.get("created", "")))


def _neg_date(value):
    # Dates are ISO-ish (YYYY-MM-DD); reverse-sort lexically via a sortable key.
    return tuple(-int(part) for part in value.replace("/", "-").split("-") if part.isdigit()) or (0,)


def scan_project(project_dir):
    project_id = os.path.basename(project_dir)
    project_md = os.path.join(project_dir, "project.md")
    name = titleize(project_id)
    columns = list(DEFAULT_COLUMNS)
    if os.path.isfile(project_md):
        with open(project_md, "r", encoding="utf-8") as fh:
            fm, _ = split_frontmatter(fh.read())
        name = fm.get("name", name)
        if fm.get("columns"):
            columns = fm["columns"]

    # Ensure any column folder that exists on disk is included, even if not
    # listed in project.md (keeps the board honest about what's really there).
    on_disk = [
        d for d in sorted(os.listdir(project_dir))
        if os.path.isdir(os.path.join(project_dir, d))
    ]
    for d in on_disk:
        if d not in columns:
            columns.append(d)

    column_map = {}
    for col in columns:
        col_dir = os.path.join(project_dir, col)
        tickets = []
        if os.path.isdir(col_dir):
            for fname in sorted(os.listdir(col_dir)):
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(col_dir, fname)
                rel = os.path.relpath(fpath, ROOT).replace(os.sep, "/")
                tickets.append(read_ticket(fpath, rel))
            tickets.sort(key=sort_key)
        column_map[col] = tickets

    return {
        "id": project_id,
        "name": name,
        "columnOrder": columns,
        "columnLabels": {c: titleize(c) for c in columns},
        "columns": column_map,
    }


def build_manifest():
    projects = []
    if os.path.isdir(PROJECTS_DIR):
        for entry in sorted(os.listdir(PROJECTS_DIR)):
            pdir = os.path.join(PROJECTS_DIR, entry)
            if os.path.isdir(pdir):
                projects.append(scan_project(pdir))
    return {
        "generator": "build.py",
        "projects": projects,
    }


def dumps(manifest):
    return json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n"


def main(argv):
    manifest = build_manifest()
    payload = dumps(manifest)

    if "--check" in argv:
        if not os.path.isfile(MANIFEST_PATH):
            print("manifest.json is missing; run: python3 build.py", file=sys.stderr)
            return 1
        with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
            current = fh.read()
        if current != payload:
            print("manifest.json is stale; run: python3 build.py", file=sys.stderr)
            return 1
        print("manifest.json is up to date.")
        return 0

    with open(MANIFEST_PATH, "w", encoding="utf-8") as fh:
        fh.write(payload)
    n_tickets = sum(
        len(tickets)
        for p in manifest["projects"]
        for tickets in p["columns"].values()
    )
    print(f"Wrote manifest.json: {len(manifest['projects'])} project(s), {n_tickets} ticket(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
