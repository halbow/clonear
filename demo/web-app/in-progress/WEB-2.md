---
title: Paginate the activity feed
assignee: alexis
priority: medium
labels: [performance]
created: 2026-07-10
---

The activity feed loads all events at once and gets slow past ~500 items.

Implement cursor-based pagination with a "Load more" button, 50 items per page.
