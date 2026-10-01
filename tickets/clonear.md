---
version: 1.1.0
name: Clonear
prefix: CLO
columns: [todo, in-progress, in-qa, done]
labels: []
---

Tickets for building Clonear itself.

This file marks the folder as a Clonear project; the board refuses folders
without it. `version` is the clonear.md format version (semver), `name` is the
display name, `prefix` is the ticket id prefix, `columns` is the column order
(each column is a subfolder), and `labels` are the project's labels, suggested
when editing a ticket.

## Tickets

A ticket is `<column>/<ID>.md`, e.g. `todo/CLO-7.md`. The filename stem is the
id (`CLO-<next number>`); the folder it sits in is its status. To move a
ticket, move the file to another column folder.

## Template

Every field filled in. Only `title` is required; unknown keys are kept.

```markdown
---
title: Fix login redirect loop   # required, one line
assignee: dave                   # free text, optional
priority: medium                 # urgent | high | medium | low (default: low)
size: M                          # S | M | L (t-shirt estimate)
labels: [bug, auth]              # free-text tags; prefer the project's labels
created: 2026-09-30              # YYYY-MM-DD
---

Markdown description: context, what to do, acceptance criteria.
Supports headings, lists, code, links, **bold** and *italic*.
```
