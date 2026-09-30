---
version: 1.0.0
name: Web App
columns: [todo, in-progress, in-qa, done]
---

The main customer-facing web application board.

This file marks the folder as a Cloinear project; the board refuses folders
without it. `version` is the cloinear.md format version (semver), `name` is the
display name, and `columns` is the column order (each column is a subfolder).

## Tickets

A ticket is `<column>/<ID>.md`, e.g. `todo/WEB-7.md`. The filename stem is the
id (`WEB-<next number>`); the folder it sits in is its status. To move a
ticket, move the file to another column folder.

## Template

Every field filled in. Only `title` is required; unknown keys are kept.

```markdown
---
title: Fix login redirect loop   # required, one line
assignee: dave                   # free text, optional
priority: medium                 # urgent | high | medium | low (default: low)
size: M                          # S | M | L (t-shirt estimate)
labels: [bug, auth]              # list of free-text tags
created: 2026-09-30              # YYYY-MM-DD
---

Markdown description: context, what to do, acceptance criteria.
Supports headings, lists, code, links, **bold** and *italic*.
```
