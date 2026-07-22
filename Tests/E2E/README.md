# End-to-end tests

Full feedback flow (capture, annotate with every tool, undo/redo, submit)
in Chromium, Firefox and WebKit, verified against the real Asana API
(section placement, notes content, attachment, assignee, task link
visibility). These tests create real Asana tasks and deliberately do not
delete them; use only a dedicated test project and archive them manually.
The Chromium anonymous scenario records a short synthetic canvas/audio stream
through the real browser `MediaRecorder` and verifies two Asana attachments.

```bash
npm install playwright && npx playwright install chromium firefox webkit
ASANA_FEEDBACK_TEST_ACCESS_TOKEN=... node run-tests.mjs
```

Environment: `E2E_BASE_URL` (default http://basewebsite.ddev.site),
`E2E_TEAM_USER` / `E2E_TEAM_PASSWORD` for the team member scenario.
The Asana project/section GIDs at the top of the script belong to the
"ILF Website Frontend" test project.
