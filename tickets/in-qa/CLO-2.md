---
title: Read-only mode for non-Chromium browsers
priority: medium
size: M
labels: [feature, compat]
created: 2026-09-30
---

Safari and Firefox don't support the File System Access API, so today they only
show a notice. Offer a read-only board instead: let the user pick the folder
(e.g. with `<input type="file" webkitdirectory>`) and show the tickets without
drag, edit, create or delete.
