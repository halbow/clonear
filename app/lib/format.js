// The clonear.md format: its semver version, the file `init` writes, and the
// migrations that bring an older project up to date.
//
// Versioning rules (the file's version vs. FORMAT_VERSION):
// - same major, same or older minor/patch: read normally
// - same major, newer minor/patch: additions only, so read it; unknown fields
//   are ignored (and kept on save)
// - newer major: breaking change, refused with a warning
// - older major: refused until migrated
//
// A breaking change bumps the major and adds an entry to MIGRATIONS that
// rewrites clonear.md and every ticket from the previous major.

import { parseFrontmatter, updateTicketText } from "./frontmatter.js";

export const FORMAT_VERSION = "1.1.0";
export const DEFAULT_COLUMNS = ["todo", "in-progress", "in-qa", "done"];

// { to: "2.0.0", project(md) -> md, ticket(raw) -> raw }, oldest first.
// `project` and `ticket` are optional; version bumps are done by migrate().
export const MIGRATIONS = [];

// "1.2.3" -> { major, minor, patch }. "1" and "1.2" are read as "1.0.0" and
// "1.2.0" (early clonear.md files used a plain integer). null when invalid.
export function parseVersion(value) {
  const m = String(value ?? "").trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m || Number(m[1]) < 1) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0) };
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const format = (v) => `${v.major}.${v.minor}.${v.patch}`;

// How this board should treat a clonear.md with `value` as its version:
// "ok" | "newer" (newer minor/patch, readable) | "too-new" | "outdated" | "invalid".
export function checkVersion(value, current = FORMAT_VERSION) {
  const v = parseVersion(value);
  const c = parseVersion(current);
  if (!v) return "invalid";
  if (v.major > c.major) return "too-new";
  if (v.major < c.major) return "outdated";
  return compareVersions(v, c) > 0 ? "newer" : "ok";
}

// Bring a project to `target`: runs every migration after the file's version,
// then stamps the new version. `tickets` is [{ path, raw }]; returns the same
// shape with only the tickets whose content changed.
export function migrate({ clonearMd, tickets }, { migrations = MIGRATIONS, target = FORMAT_VERSION } = {}) {
  const from = parseVersion(parseFrontmatter(clonearMd).data.version);
  const to = parseVersion(target);
  if (!from) throw new Error('clonear.md has no valid "version"');
  if (compareVersions(from, to) > 0) throw new Error(`cannot migrate ${format(from)} down to ${format(to)}`);

  const steps = migrations.filter((m) => {
    const v = parseVersion(m.to);
    return compareVersions(v, from) > 0 && compareVersions(v, to) <= 0;
  });
  for (let major = from.major + 1; major <= to.major; major++) {
    if (!steps.some((m) => parseVersion(m.to).major === major)) {
      throw new Error(`no migration to version ${major}.0.0`);
    }
  }

  let md = clonearMd;
  let out = tickets.map((t) => ({ ...t }));
  for (const step of steps) {
    if (step.project) md = step.project(md);
    if (step.ticket) out = out.map((t) => ({ ...t, raw: step.ticket(t.raw) }));
  }
  md = updateTicketText(md, { version: format(to) }, parseFrontmatter(md).body);
  const changed = out.filter((t, i) => t.raw !== tickets[i].raw);
  return { clonearMd: md, tickets: changed };
}

// The clonear.md `init` writes: current version, name, prefix, columns,
// labels, and the ticket template people and agents follow.
export function initClonearMd({ name, prefix, columns = DEFAULT_COLUMNS, labels = [] }) {
  return `---
version: ${FORMAT_VERSION}
name: ${name}
prefix: ${prefix}
columns: [${columns.join(", ")}]
labels: [${labels.join(", ")}]
---

This file marks the folder as a Clonear project; the board refuses folders
without it. \`version\` is the clonear.md format version (semver), \`name\` is
the display name, \`prefix\` is the ticket id prefix, \`columns\` is the
column order (each column is a subfolder), and \`labels\` are the project's
labels, suggested when editing a ticket.

## Tickets

A ticket is \`<column>/<ID>.md\`, e.g. \`${columns[0]}/${prefix}-7.md\`. The filename stem is the
id (\`${prefix}-<next number>\`); the folder it sits in is its status. To move a
ticket, move the file to another column folder.

## Template

Every field filled in. Only \`title\` is required; unknown keys are kept.

\`\`\`markdown
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
\`\`\`
`;
}
