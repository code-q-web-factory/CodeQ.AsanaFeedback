# CodeQ.AsanaFeedback

A reusable Neos CMS package that adds a visual feedback widget to the rendered
website. Visitors capture a screenshot of the current page, annotate it
(freehand, rectangle, arrow, text, undo/redo, delete) and describe their
feedback. Every submission creates exactly one task in a fixed Asana project —
including the annotated screenshot as attachment, the page URL, the author and
technical browser context. It replaces Marker.io for this use case.

## Features

- Screenshot of the visible viewport, rendered DOM-based in the browser
  (`html-to-image`); the widget itself is never part of the screenshot
- Annotation editor on `Fabric.js`: freehand, rectangle, arrow, text,
  undo/redo, remove selection, five colors
- Direct task creation in a fixed Asana project; the target section is
  resolved by name (configurable candidate list, e.g. `Todo`) or by fixed GID
- Logged-in Neos users are identified server side; their display name is used
  as author and cannot be overridden by the browser
- Members of the internal Code Q team (server side allowlist) can assign the
  task to a configured Asana user and get the task link after submission
- Anonymous access is controlled per deployment context via
  `enableForAnonymousUsersInFrontend`
- German and English UI via XLIFF resources, following the site language
- Styled after the Neos CMS backend (colors, typography, form elements)
- Rate limiting, server side MIME/size validation and cleanup of temp files

## Installation

```bash
composer require codeq/asanafeedback
```

The package hooks into `Neos.Neos:Page` automatically (Fusion `autoInclude`)
and injects the widget before `</body>` inside an uncached segment, so cached
pages never contain user specific markup.

## Configuration

```yaml
CodeQ:
  AsanaFeedback:
    enableForAnonymousUsersInFrontend: false

    asana:
      accessToken: '%env:ASANA_FEEDBACK_ACCESS_TOKEN%'

    asanaProjectGid: '1216274953146548'
    # optional, when empty the section is resolved by name:
    asanaSectionGid: ''
    asanaSectionNames: ['Todo', 'ToDo', 'Todos', 'Organisation']

    limits:
      screenshotBytes: 10485760
      videoBytes: 100000000
      descriptionCharacters: 10000

    rateLimit:
      maxPerMinute: 5
      maxPerHour: 20

    teamAccountIdentifiers:
      - 'roland.schuetz'
      - 'felix.gradinaru'

    assignees:
      roland:
        label: 'Roland'
        asanaUserGid: '422230010221'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/roland.jpg'
```

The Asana access token must be provided as environment variable
(`ASANA_FEEDBACK_ACCESS_TOKEN`) or other non-versioned deployment secret.
Anonymous access is typically enabled per context, e.g. in
`Configuration/Staging/Settings.yaml`.

## Security notes

- All Asana communication happens exclusively server side; token, project,
  section and assignee GIDs are never delivered to the browser
- Submitted assignees are validated against the YAML allowlist; project and
  section can never be chosen by the client
- The submit endpoint is rate limited per client IP and validates MIME type
  (content sniffing), file size and description length server side
- Uploaded files are stored under server generated temporary names and are
  removed after the transfer, successful or not

## Frontend build

The built widget assets are committed under `Resources/Public`, deployments
need no node step. To rebuild after changes:

```bash
cd Resources/Private/JavaScript
npm install
npm run build
```

## Open source dependencies

| Library | License | Purpose |
| --- | --- | --- |
| [fabric](https://github.com/fabricjs/fabric.js) 6.x | MIT | screenshot annotation canvas |
| [html-to-image](https://github.com/bubkoo/html-to-image) 1.x | MIT | DOM based screenshot rendering |
| [esbuild](https://github.com/evanw/esbuild) 0.25.x | MIT | build tooling (dev only) |
| Feather Icons (inlined SVG paths) | MIT | toolbar and status icons |

Versions are pinned via the committed `package-lock.json`; third-party license
texts are linked from the bundle header comment (`Widget.js` legal comments).
