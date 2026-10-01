import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../app/lib/frontmatter.js";
import { checkVersion, compareVersions, migrate, parseVersion } from "../app/lib/format.js";

test("parses semver, and reads a plain integer as major.0.0", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(parseVersion("1"), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion(2), { major: 2, minor: 0, patch: 0 });
  for (const bad of ["", "abc", "0", "1.x", "v1.0.0", undefined]) assert.equal(parseVersion(bad), null, bad);
});

test("compares versions field by field", () => {
  const v = parseVersion;
  assert.ok(compareVersions(v("1.10.0"), v("1.9.9")) > 0);
  assert.ok(compareVersions(v("1.0.1"), v("2.0.0")) < 0);
  assert.equal(compareVersions(v("1"), v("1.0.0")), 0);
});

test("checkVersion: same major is readable, other majors are not", () => {
  assert.equal(checkVersion("2.1.0", "2.1.0"), "ok");
  assert.equal(checkVersion("2.0.5", "2.1.0"), "ok");
  assert.equal(checkVersion("2.3.0", "2.1.0"), "newer");
  assert.equal(checkVersion("2.1.1", "2.1.0"), "newer");
  assert.equal(checkVersion("3.0.0", "2.1.0"), "too-new");
  assert.equal(checkVersion("1.9.0", "2.1.0"), "outdated");
  assert.equal(checkVersion("nope", "2.1.0"), "invalid");
});

// A made-up 2.0.0 that renames `assignee` to `owner`.
const RENAME = {
  to: "2.0.0",
  project: (md) => md.replace("assignee:", "owner:"),
  ticket: (raw) => raw.replace(/^assignee:/m, "owner:"),
};

test("migrate runs each step after the file's version and stamps the target", () => {
  const out = migrate(
    {
      clonearMd: "---\nversion: 1\nname: Web\n---\n\nTemplate: assignee: alexis\n",
      tickets: [
        { path: "todo/WEB-1.md", raw: "---\ntitle: A\nassignee: alexis\n---\n" },
        { path: "todo/WEB-2.md", raw: "---\ntitle: B\n---\n" },
      ],
    },
    { migrations: [RENAME], target: "2.0.0" }
  );
  assert.equal(parseFrontmatter(out.clonearMd).data.version, "2.0.0");
  assert.equal(parseFrontmatter(out.clonearMd).data.name, "Web");
  assert.match(out.clonearMd, /owner: alexis/);
  // Only changed tickets come back.
  assert.deepEqual(out.tickets, [{ path: "todo/WEB-1.md", raw: "---\ntitle: A\nowner: alexis\n---\n" }]);
});

test("migrate skips steps the file already has", () => {
  const out = migrate(
    { clonearMd: "---\nversion: 2.0.0\n---\n", tickets: [{ path: "a.md", raw: "---\nassignee: x\n---\n" }] },
    { migrations: [RENAME], target: "2.1.0" }
  );
  assert.equal(parseFrontmatter(out.clonearMd).data.version, "2.1.0");
  assert.deepEqual(out.tickets, []);
});

test("migrate refuses a gap in the migration chain, or going down", () => {
  const clonearMd = "---\nversion: 1.0.0\n---\n";
  assert.throws(() => migrate({ clonearMd, tickets: [] }, { migrations: [RENAME], target: "3.0.0" }), /to version 3\.0\.0/);
  assert.throws(() => migrate({ clonearMd: "---\nversion: 3.0.0\n---\n", tickets: [] }, { target: "2.0.0" }), /down/);
});
