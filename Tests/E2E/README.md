# End-to-end tests

Full feedback flows (screenshot capture and annotation or video-only
screencast submission) in Chromium, Firefox and WebKit, verified against the real Asana API
(section placement, notes content, attachment, assignee, task link
visibility). These tests create real Asana tasks and deliberately do not
delete them; use only a dedicated test project and archive them manually.
The Chromium anonymous scenario starts a short synthetic canvas/audio stream
from the annotation dialog through the real browser `MediaRecorder`, verifies
that no screenshot is uploaded and checks the single Asana video attachment.
The Chromium admin scenario keeps the annotated screenshot and records an
additional screencast to cover the existing two-attachment flow.

```bash
npm install playwright && npx playwright install chromium firefox webkit
ASANA_FEEDBACK_TEST_ACCESS_TOKEN=... node run-tests.mjs
```

Environment: `E2E_BASE_URL` (default http://basewebsite.ddev.site),
`E2E_TEAM_USER` / `E2E_TEAM_PASSWORD` for the team member scenario.
The Asana project/section GIDs at the top of the script belong to the
"ILF Website Frontend" test project.
