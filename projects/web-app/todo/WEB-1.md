---
title: Fix login redirect loop
assignee: alexis
priority: high
labels: [bug, auth]
created: 2026-07-14
---

Users get bounced back to `/login` after a successful authentication.

## Steps to reproduce

1. Sign in with valid credentials.
2. Observe the redirect to `/dashboard`.
3. The app immediately sends you back to `/login`.

## Notes

Likely a stale session cookie not being read on the first navigation.
