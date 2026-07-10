# End-to-end tests

Full feedback flow (capture, annotate with every tool, undo/redo, submit)
in Chromium, Firefox and WebKit, verified against the real Asana API
(section placement, notes content, attachment, assignee, task link
visibility) with automatic cleanup of the created test tasks.

```bash
npm install playwright && npx playwright install chromium firefox webkit
ASANA_FEEDBACK_ACCESS_TOKEN=... node run-tests.mjs
```

Environment: `E2E_BASE_URL` (default http://basewebsite.ddev.site),
`E2E_TEAM_USER` / `E2E_TEAM_PASSWORD` for the team member scenario.
The Asana project/section GIDs at the top of the script belong to the
"ILF Website Frontend" test project.
