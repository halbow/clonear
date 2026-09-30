---
title: Add a cloinear.md file at the project root
priority: high
size: S
labels: [docs, agents]
created: 2026-09-30
---

The idea is to have a special cloinear.md file at the root of the project:
cloinear.md
todo
done
in progress
etc

The cloinear file wills erve diffferent purpose:
- Define the version of the app
- Allow the app to refuse a folder if it's not present
- Show the template structure used for the file:
Add a template ticket file at the root of the project. It shows a full example ticket
that follows the spec, with every field filled in and the allowed values listed
(`priority`, `size`, `labels`, …).
The goal is that an agent can read it and create or edit tickets correctly during dev.
