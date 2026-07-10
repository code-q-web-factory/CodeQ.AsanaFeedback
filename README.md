# CodeQ.AsanaFeedback

# WIP This is currently tailored to the use cases for Code Q, feel free to fork your own version of add PRs

A reusable Neos CMS package that adds a visual feedback widget to the rendered
website. Visitors capture a screenshot of the current page, annotate it
(freehand, rectangle, arrow, text, undo/redo, delete), give the report a
title and description — and every submission creates exactly one task in a
fixed Asana project, including the annotated screenshot as attachment, the
page URL, the author and technical browser context. It replaces Marker.io
for this use case.

## Features

- Screenshot of the visible viewport, rendered DOM-based in the browser
  (`html-to-image`) with a loading indicator during capture; the widget
  itself is never part of the screenshot
- Annotation editor on `Fabric.js`: freehand, rectangle, arrow, text,
  undo/redo, remove selection, five colors
- Direct task creation in a fixed Asana project; the target section is
  resolved by name (configurable candidate list, e.g. `Todo`) or by fixed GID
- Every user can set an optional task title (otherwise the task is named
  `Website-Feedback: <description>`) and assign the task to a client visible
  assignee (`visibleToClient: true`); submissions without an explicit choice
  use the configured default assignee
- Logged-in Neos users are identified server side; their display name is
  used as author and cannot be overridden by the browser
- Members of the internal Code Q team (server side allowlist) can pick every
  configured assignee and get the Asana task link after submission
- Feedback button in the Neos backend toolbar (next to the dimension
  switcher) for all logged-in users; its screenshot captures the full
  backend including the content canvas and inspector
- Optional screencast recording (Screen Capture API, https only), attached
  to the same task
- German and English UI via XLIFF resources, following the site language
- Styled after the Neos CMS backend and hardened against site CSS
- Rate limiting, server side MIME/size validation and cleanup of temp files

## Setup

### 1. Require the package

For a distribution that contains the package under `DistributionPackages/`
(path repository, as usual in Code Q projects):

```bash
composer require codeq/asanafeedback:@dev
```

Nothing else needs to be wired up manually: the Fusion integration
(`autoInclude`), the routes, the security policy for the public endpoint,
the authentication request pattern and the Neos backend toolbar plugin are
all registered by the package itself.

### 2. Provide the Asana access token

Create (or reuse) a dedicated Asana integration user, generate a Personal
Access Token in the Asana developer console and provide it as the
environment variable `ASANA_FEEDBACK_ACCESS_TOKEN` — never in versioned
configuration. Locally with ddev, for example:

```yaml
# .ddev/config.local.yaml (git-ignored)
web_environment:
  - ASANA_FEEDBACK_ACCESS_TOKEN=1/1234567890:abcdef...
```

followed by `ddev restart`. On Proserver/Beach the variable is set through
the deployment secret store. The integration user must be a member of the
target Asana project.

### 3. Configure the Asana project

The only mandatory per-project setting is the Asana project GID (the long
number in the project URL):

```yaml
# DistributionPackages/Vendor.Site/Configuration/Settings.AsanaFeedback.yaml
CodeQ:
  AsanaFeedback:
    asanaProjectGid: '1216274953146548'
```

Tasks are placed in the first section whose name matches the configured
candidate list (`Todo`, `Todos`, `Organisation` — case-insensitive). Make
sure the Asana project has such a section, configure your own
`asanaSectionNames`, or pin a fixed `asanaSectionGid`. If no section can be
resolved, submissions fail with a controlled error message.

### 4. Decide where the frontend widget is visible

`enableInFrontend` controls whether the widget is rendered on the website
for all visitors. The package default is `false`, but it ships context
configuration that enables it in the `Development`,
`Production/Proserver/Staging` and `Production/Beach/Staging` Flow contexts.
Projects can override this per context in their global configuration, e.g.:

```yaml
# Configuration/Production/Proserver/Staging/Settings.yaml
CodeQ:
  AsanaFeedback:
    enableInFrontend: false
```

The decision is cached with the page (disabled sites stay fully cacheable),
so changing it requires a content cache flush:
`./flow flow:cache:flushone Neos_Fusion_Content`.

Independent of this flag, every logged-in Neos user always has the feedback
button in the backend toolbar.

## All configuration options

The package defaults (see `Configuration/Settings.yaml`) already contain the
Code Q team mapping; every value can be overridden per project:

```yaml
CodeQ:
  AsanaFeedback:
    enableInFrontend: false

    asana:
      accessToken: '%env:ASANA_FEEDBACK_ACCESS_TOKEN%'

    asanaProjectGid: ''
    defaultAssigneeGid: '422230010221' # Roland; used when none is selected
    # optional fixed section; when empty the section is resolved by name:
    asanaSectionGid: ''
    asanaSectionNames: ['Todo', 'Todos', 'Organisation']

    limits:
      screenshotBytes: 10485760      # 10 MB
      videoBytes: 100000000          # Asana attachment limit
      descriptionCharacters: 10000

    rateLimit:                       # per client IP
      maxPerMinute: 5
      maxPerHour: 40

    # Neos account identifiers of the internal team: these users can pick
    # every assignee, get the task link and are named by their Neos account
    teamAccountIdentifiers:
      - 'roland.schuetz'
      - 'felix.gradinaru'

    # selectable assignees; "visibleToClient: true" entries can be picked
    # by every visitor, the others only by team members
    assignees:
      roland:
        label: 'Roland'
        asanaUserGid: '422230010221'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/roland.jpg'
        visibleToClient: true
      yurii:
        label: 'Yurii'
        asanaUserGid: '510973132418883'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/yurii.jpg'
        visibleToClient: false
```

## Security notes

- All Asana communication happens exclusively server side; token, project,
  section and assignee GIDs are never delivered to the browser
- Submitted assignees are validated server side against the allowlist and
  the `visibleToClient` flag; project and section can never be chosen by
  the client
- The submit endpoint is rate limited per client IP and validates MIME type
  (content sniffing), file size and description length server side
- Uploaded files are stored under server generated temporary names and are
  removed after the transfer, successful or not

## Development

The built assets are committed under `Resources/Public`, deployments need no
node step. To rebuild after changes (builds the website widget and the
backend toolbar plugin):

```bash
cd Resources/Private/JavaScript && npm install
cd ../BackendUi && npm install && cd ../JavaScript
npm run build
```

Tests:

```bash
# unit tests (from the distribution root)
bin/phpunit --bootstrap Build/BuildEssentials/PhpUnit/UnitTestBootstrap.php \
    DistributionPackages/CodeQ.AsanaFeedback/Tests/Unit

# end-to-end tests in Chromium, Firefox and WebKit incl. Asana verification
cd Tests/E2E && npm install playwright && npx playwright install
ASANA_FEEDBACK_ACCESS_TOKEN=... node run-tests.mjs
```

## Open source dependencies

| Library | License | Purpose |
| --- | --- | --- |
| [fabric](https://github.com/fabricjs/fabric.js) 6.x | MIT | screenshot annotation canvas |
| [html-to-image](https://github.com/bubkoo/html-to-image) 1.x | MIT | DOM based screenshot rendering |
| [esbuild](https://github.com/evanw/esbuild) 0.25.x | MIT | build tooling (dev only) |
| [@neos-project/neos-ui-extensibility](https://github.com/neos/neos-ui) 8.x | GPL-3.0 (as Neos UI) | backend toolbar plugin shim (dev only, aliases to host UI) |
| Feather Icons (inlined SVG paths) | MIT | toolbar and status icons |

Versions are pinned via the committed `package-lock.json`; third-party license
texts are linked from the bundle header comment (`Widget.js` legal comments).
