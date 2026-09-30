import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, scoreTicket } from "../app/lib/search.js";

const t = (fields) => ({ id: "IMP-1", title: "", labels: [], assignee: "", size: "", body: "", ...fields });

test("empty query matches everything", () => {
  assert.ok(scoreTicket(t({ title: "Anything" }), "  ") > 0);
});

test("matches id, title, labels and body substrings, ignoring case and accents", () => {
  const ticket = t({ id: "IMP-2", title: "Ride history", labels: ["ux"], body: "Show previous rides — détails" });
  for (const q of ["imp-2", "HISTORY", "ux", "details"]) assert.ok(scoreTicket(ticket, q) > 0, q);
});

test("fuzzy subsequence on id + title", () => {
  assert.ok(scoreTicket(t({ title: "Ride history" }), "rdhst") > 0);
  assert.equal(scoreTicket(t({ title: "Ride history" }), "zzz"), 0);
  // scattered letters with no word starts or runs are noise
  assert.equal(scoreTicket(t({ id: "MOB-1", title: "Offline mode for the inbox" }), "bio"), 0);
});

test("every word must match", () => {
  const ticket = t({ title: "Heart rate monitor" });
  assert.ok(scoreTicket(ticket, "heart mon") > 0);
  assert.equal(scoreTicket(ticket, "heart cadence"), 0);
});

test("title hits outrank description hits, and word starts beat scattered letters", () => {
  const inTitle = t({ title: "Cadence" });
  const inBody = t({ title: "Other", body: "about cadence" });
  assert.ok(scoreTicket(inTitle, "cadence") > scoreTicket(inBody, "cadence"));
  assert.ok(fuzzyScore("rh", "ride history") > fuzzyScore("rh", "other"));
});
