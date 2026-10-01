---
title: Init clonear.md and version the ticket layout with semver
priority: medium
size: L
labels: [feature, format]
created: 2026-09-30
---

Add a way to **init** a project: create the `clonear.md` file (and column
folders) stamped with the current format version, so nobody has to copy it by
hand.

## Versioning

Replace the integer `version: 1` with a semver version of the ticket layout
(e.g. `version: 1.0.0`). The board compares the file's version with the one it
supports (`FORMAT_VERSION` in `app/lib/format.js`):

- **Same version, or older with the same major**: read normally.
- **Older major**: don't read it; offer to migrate it to the current version.
- **Newer minor/patch** (additions only): read it; new fields are ignored
  (and kept on save, as unknown keys already are).
- **Newer major** (breaking change): don't read it, show a warning that the
  board is too old for this project.

## Migration

Provide a way to migrate tickets from a previous version to the current one:
rewrite `clonear.md` and the ticket files to the new layout and bump the
version. Each breaking change ships with its migration step.

## Acceptance criteria

- Init creates `clonear.md` with the current version, name, columns and
  ticket template.
- Newer minor version loads; unknown fields are ignored and preserved.
- Newer major version is refused with a clear warning.
- An older major version is refused with an offer to migrate; migrating
  brings `clonear.md` and every ticket to the current version.
- Existing `version: 1` files keep working (treated as `1.0.0`).
- Tests cover the version comparison and a migration.
