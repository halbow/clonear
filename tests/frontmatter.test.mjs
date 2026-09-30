// Run with: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, updateTicketText } from "../app/lib/frontmatter.js";

const TICKET = `---
title: Fix login redirect loop
assignee: alexis
priority: high
labels: [bug, auth]
created: 2026-07-14
estimate: 3 # custom key
---

Body line one.

## Notes
`;

test("parses scalars, inline lists and block lists", () => {
  const { data, body } = parseFrontmatter("---\ntitle: 'A: b'\nlabels:\n  - x\n  - y\nempty: []\n---\n\nHello\n");
  assert.deepEqual(data, { title: "A: b", labels: ["x", "y"], empty: [] });
  assert.equal(body, "Hello");
});

test("updates changed keys in place and keeps unknown keys", () => {
  const out = updateTicketText(TICKET, { priority: "low", labels: ["bug"] }, "New body");
  assert.equal(
    out,
    "---\ntitle: Fix login redirect loop\nassignee: alexis\npriority: low\nlabels: [bug]\ncreated: 2026-07-14\nestimate: 3 # custom key\n---\n\nNew body\n"
  );
});

test("removes emptied keys, appends new ones, replaces block lists", () => {
  const raw = "---\ntitle: T\nlabels:\n  - a\n  - b\nassignee: sam\n---\n";
  const out = updateTicketText(raw, { assignee: "", labels: ["c"], priority: "urgent" }, "");
  assert.equal(out, "---\ntitle: T\nlabels: [c]\npriority: urgent\n---\n");
});

test("quotes values the parser would misread, and round-trips them", () => {
  const out = updateTicketText("", { title: "[WIP] thing", assignee: "# nobody" }, "");
  const { data } = parseFrontmatter(out);
  assert.equal(data.title, "[WIP] thing");
  assert.equal(data.assignee, "# nobody");
});

test("creates frontmatter for a file without one", () => {
  assert.equal(updateTicketText("", { title: "New" }, "Hi"), "---\ntitle: New\n---\n\nHi\n");
});
