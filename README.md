# CodeQ.AsanaFeedback

# WIP This is currently tailored to the use cases for Code Q, feel free to fork your own version of add PRs

A reusable Neos CMS package that adds a visual feedback widget to the rendered
website. Visitors annotate a screenshot of the current page or record a
screencast, give the report a title and description — and every successful
submission creates one task in a fixed Asana project, including the selected
media attachment, page URL, author and technical browser context. It replaces
Marker.io for this use case.

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
  backend including the content canvas and inspector, and its technical
  context includes the live content-canvas URL
- Screencast recording (Screen Capture API, https only), either instead of a
  screenshot or as an additional attachment on the same task
- Screenshots encoded as JPEG at quality `0.8` (PNG fallback) and
  screencasts capped at 1280×720, 20 FPS preferred/24 FPS maximum,
  2 Mbit/s video, 96 kbit/s audio and 90 seconds
- Browser-native `Blob`/`FormData` upload directly to the central relay;
  screenshot and video bytes never pass through the Neos backend
- German and English UI via XLIFF resources, following the site language
- Styled after the Neos CMS backend and hardened against site CSS
- 95 MB client/server limit, content-sniffed MIME validation, exact-origin
  CORS, per-site rate limiting and idempotent Asana task creation

## Architecture: direct browser upload

The control plane and binary data plane are deliberately separate:

```text
Browser ── JSON metadata ──▶ Neos /prepare
Browser ◀─ opaque upload grant + signed CORS policy ── Neos

Browser ── grant + JPEG and/or WebM in FormData ──▶ central relay ──▶ Asana API
                                                  task first, attachment second
```

Neos authenticates the current user, validates metadata, resolves the
project/section/assignee allowlists and encrypts those trusted claims into a
short-lived grant. The browser cannot read the GIDs or alter the claims. The
relay validates the grant, origin and uploaded bytes before it creates one
Asana task and adds the attachments. Only the relay has the Asana personal
access token. Neos and the relay share one relay-wide grant secret, never the
Asana token. Direct-upload behavior is not project-configurable: the grant
lifetime is fixed, the current public request origin comes from Neos' trusted
request URI, and a keyed hash of the project GID provides the relay namespace.

`html-to-image` uses SVG data URLs internally while rasterizing the DOM; this
is a transient browser implementation detail. No Base64 or data URL is placed
in either HTTP request. The requests carry JSON and binary multipart parts.

## Setup

### 0. Deploy the relay service (once, centrally)

The relay must be running before any website can submit feedback. Copy the
complete contents of `RemoteService/` into a folder on the central server, e.g.
`asana-feedback-widget.codeq.at`, then:

1. Copy `config.example.php` to `config.php` (git-ignored, never committed)
   and fill in:
   - `asanaAccessToken`: the Personal Access Token of the dedicated Asana
     integration user (Asana developer console). The integration user must
     be a member of every target Asana project.
   - `grantSecret`: one strong relay-wide secret (`openssl rand -hex 32`).
     Provision the same value to every Neos installation as
     `ASANA_FEEDBACK_GRANT_SECRET`. Adding a website never requires a relay
     configuration change.
   - `stateDirectory`: a persistent PHP-writable directory outside the public
     web root for idempotency state and small rate-limit counters. Run the
     relay as a single instance; multiple instances require storage with
     shared, reliable `flock` semantics (or a transactional replacement).
     Remove state files only after the chosen retry/audit period, for example
     files older than 30 days in a nightly maintenance job. Never clean a
     currently active relay directory during requests.
2. Make sure `config.php` is not served: the shipped `.htaccess` denies it
   on Apache; on nginx add an equivalent `location` block.
3. Install PHP 8.1+ with cURL, Fileinfo, mbstring and OpenSSL. The relay must
   be reachable via HTTPS only; the Neos grant issuer rejects HTTP endpoints.
4. Apply the limits while the request is read. The shipped Apache
   `.htaccess` sets a 191,000,000-byte request cap (two 95 MB files plus
   multipart overhead) and, for mod_php, exact
   PHP limits. For nginx/PHP-FPM configure the equivalents:

   ```nginx
   client_max_body_size 191000000;
   client_body_timeout 300s;
   fastcgi_read_timeout 900s;
   ```

   ```ini
   upload_max_filesize = 95000000
   post_max_size = 191000000
   max_input_time = 300
   max_execution_time = 900
   ```

   The outer 900-second FastCGI/PHP timeout deliberately exceeds two
   sequential 300-second Asana attachment timeouts plus the smaller
   task/section requests. Apply the same outer timeout at any upstream proxy.

   If a reverse proxy is present, configure its real-IP module so PHP's
   `REMOTE_ADDR` is the actual browser IP. Do not trust arbitrary
   `X-Forwarded-For` values in application code.
5. The application limiter counts every authenticated upload attempt, but PHP
   sees it only after the request body has been read. Protect ingress before
   body buffering as well. With nginx, define an IP zone in `http` and apply
   it to the relay location; use the equivalent edge/WAF rule on Apache:

   ```nginx
   limit_req_zone $binary_remote_addr zone=feedback_uploads:10m rate=5r/m;
   # inside the exact relay location:
   limit_req zone=feedback_uploads burst=2 nodelay;
   ```

   The widget sends only file parts (grant plus at least one screenshot or
   video), so PHP spools them to upload temp files. If an edge WAF is available,
   reject unexpected regular multipart fields and cap each such field at
   512 KB; this prevents malicious form fields from consuming PHP memory
   before application code runs.

A quick smoke test — a request without a signed CORS policy must return 403:

```bash
curl -i -X OPTIONS 'https://asana-feedback-widget.codeq.at?action=upload&site=ilf-website' \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: POST'
```

### 1. Require the package

Install the package from Packagist in the project root:

```bash
composer require codeq/asanafeedback
```

Nothing else needs to be wired up manually: the Fusion integration
(`autoInclude`), the routes, the security policy for the public endpoint,
the authentication request pattern and the Neos backend toolbar plugin are
all registered by the package itself.

### 2. Provide the upload-grant secret

Provide the relay-wide `grantSecret` from the relay's `config.php` (**not** an
Asana token) as the environment variable
`ASANA_FEEDBACK_GRANT_SECRET` — never in versioned configuration. Locally
with ddev, for example:

```yaml
# .ddev/config.local.yaml (git-ignored)
web_environment:
  - ASANA_FEEDBACK_GRANT_SECRET=3f9c2e...
```

followed by `ddev restart`. On Proserver/Beach the variable is set through
the deployment secret store.

If the relay runs somewhere other than the default
`https://asana-feedback-widget.codeq.at/`, point the package at it:

```yaml
# DistributionPackages/Vendor.Site/Configuration/Settings.AsanaFeedback.yaml
CodeQ:
  AsanaFeedback:
    feedbackService:
      endpoint: 'https://example.com/asana-feedback/'
```

### 3. Configure the Asana project

The only direct-upload setting a website needs is the Asana project GID (the
long number in the project URL):

```yaml
# DistributionPackages/Vendor.Site/Configuration/Settings.AsanaFeedback.yaml
CodeQ:
  AsanaFeedback:
    asanaProjectGid: '1216274953146548'
```

The GID is encrypted inside the opaque upload grant. A stable HMAC of the GID
namespaces rate limiting and idempotency without revealing the project. Neos
derives the exact CORS origin from the public URI of the `/prepare` request;
reverse proxies must therefore provide Flow with the verified public scheme,
host and port. No RemoteService configuration change is needed when adding a
website.

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

### Static and headless frontend embeds

Frontends that do not render the Fusion integration can request the same safe
frontend configuration from
`/codeq-asana-feedback/frontend-config?locale=en`. The endpoint is available
whenever `enableInFrontend` permits the current visitor to use the widget; the
authenticated backend configuration endpoint remains unchanged.

Embed the returned JSON as the text content of a
`#codeq-asana-feedback-config` script element, then load the versioned URLs in
`assets.stylesheetUrl` and `assets.scriptUrl`. Do not construct the public asset
paths in the host application: static Neos resources can be cached for a long
time and need the content hash returned by the endpoint. Hosts whose visible
content lives in same-origin iframes can add
`data-include-iframes="true"` to the configuration element so the iframe
content is composited into the screenshot.

## All configuration options

The package defaults (see `Configuration/Settings.yaml`) already contain the
Code Q team mapping; every value can be overridden per project:

```yaml
CodeQ:
  AsanaFeedback:
    enableInFrontend: false

    feedbackService:
      # relay service that holds the actual Asana access token
      endpoint: 'https://asana-feedback-widget.codeq.at/'
      # secret for short-lived encrypted grants; not the Asana token
      grantSecret: '%env:ASANA_FEEDBACK_GRANT_SECRET%'

    asanaProjectGid: ''
    defaultAssigneeGid: '422230010221' # Roland; used when none is selected
    # optional fixed section; when empty the section is resolved by name:
    asanaSectionGid: ''
    asanaSectionNames: ['Todo', 'Todos', 'Organisation']

    limits:
      fileBytes: 95000000            # hard cap per file
      screenshotBytes: 95000000      # may be lowered per project
      descriptionCharacters: 10000

    media:
      screenshot:
        mimeTypes: ['image/jpeg', 'image/png']
        quality: 0.8
      video:
        width: 1280
        height: 720
        idealFrameRate: 20
        maximumFrameRate: 24
        videoBitsPerSecond: 2000000
        audioBitsPerSecond: 96000
        maximumDurationSeconds: 90

    rateLimit:                       # per client IP
      maxPerMinute: 5
      maxPerHour: 40

    # Neos account identifiers of the internal team: these users can pick
    # every assignee, get the task link and are named by their Neos account
    teamAccountIdentifiers:
      - 'roland.schuetz'
      - 'felix.gradinaru'
      - 'daniel.schmelz'
      - 'clara.borek'
      - 'michael.koepl'
      - 'dion.holder'

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
      daniel:
        label: 'Daniel'
        asanaUserGid: '240050036824008'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/daniel.jpg'
        visibleToClient: false
      clara:
        label: 'Clara'
        asanaUserGid: '1210155270823988'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/clara.jpeg'
        visibleToClient: true
      michael:
        label: 'Michael'
        asanaUserGid: '778955489601506'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/michael.jpeg'
        visibleToClient: true
      arvin:
        label: 'Arvin'
        asanaUserGid: '1213418029127040'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/arvin.jpeg'
        visibleToClient: false
      dion:
        label: 'Dion'
        asanaUserGid: '1215306059024724'
        avatar: 'resource://CodeQ.AsanaFeedback/Public/Images/Team/dion.jpg'
        visibleToClient: true
```

## CORS and website integration responsibilities

Reusable CORS behavior belongs to `CodeQ.AsanaFeedback`: the relay validates
the signed policy, handles `OPTIONS`, permits only `POST`/`OPTIONS` and the
two required request headers, emits `Vary: Origin`, and never emits
`Access-Control-Allow-Credentials`. Missing, unknown and `null` origins are
rejected. The received origin is only reflected after exact validation
against the policy signed by Neos with the relay-wide secret. CORS is not
treated as authentication because the encrypted grant file part authorizes
the operation.

The website configures only `asanaProjectGid`. Neos derives the one allowed
origin from the trusted public request URI and signs it into the CORS policy;
it never blindly signs the incoming `Origin` header. The relay has no site
registry. A strict Content Security Policy must also list the relay URL in
`connect-src`. A headless frontend or reverse proxy still forwards only
`/config`, `/frontend-config` and `/prepare` to Neos; it must not proxy file
bytes and must preserve the verified public request URI for Neos.

For ILFWebsite specifically there was no existing CORS middleware, Neos CORS
setting or webserver CORS rule. Its current CSP has no `connect-src` and its
broad HTTPS-capable `default-src` fallback already permits the relay request,
so no CSP change is required. ILF's authenticated trusted-proxy middleware
already changes the Neos request URI to the verified public Next.js origin.
ILF therefore configures only `asanaProjectGid` and keeps the Next middleware
route for the small metadata endpoints.

## Browser media optimization measurement

The widget re-encodes the annotated capture with the browser-native canvas
encoder before upload instead of sending the lossless PNG. A 1280×720 opaque
UI screenshot that is roughly 48 KB as lossless PNG typically shrinks to a
few kilobytes as JPEG at quality `0.8`. Complex photographic pages produce
different absolute sizes, but use the same browser-native encoding path.
PNG remains only the final fallback when JPEG encoding is not available.
At the configured bitrates a full 90-second screencast is about 23.6 MB
before container overhead, comfortably below the 95 MB cap.

## Security notes

- The Asana personal access token only exists on the central relay server.
  One relay-wide grant secret is shared by the trusted Neos installations and
  never appears in the widget or publicly delivered configuration.
- The browser receives an opaque AES-256-GCM grant. Project, section and
  assignee GIDs are encrypted and cannot be altered without invalidating it.
- The relay validates exact origin, grant expiry/project namespace, idempotency key,
  numeric GIDs, file size and content-sniffed MIME type before creating the
  task. The singular project GID comes from Neos package configuration and is
  protected by the encrypted grant.
- The relay-wide secret removes central per-site maintenance. Its deliberate
  trade-off is a wider trust boundary: a compromised Neos server holding that
  secret could issue a grant for any project accessible to the Asana
  integration user. Keep that user's project memberships minimal and rotate
  the global secret if any participating installation is compromised.
- Submitted assignees are validated server side against the allowlist and
  the `visibleToClient` flag; project and section can never be chosen by
  the client
- Grant preparation is rate limited in Neos; authenticated direct-upload
  attempts are independently counted by opaque project namespace and client IP at the relay.
  The deployment's edge limiter rejects floods before PHP buffers the body.
- PHP creates its own upload temp files for the grant and media, but client
  filenames are ignored; generated names are used for Asana attachments.
- A locked idempotency record is written as soon as Asana returns the task
  ID. Retrying the same key returns or completes the same task instead of
  creating a duplicate during normal operation. There remains an unavoidable
  crash window between Asana accepting task creation and the relay persisting
  that task ID. The current Asana API call has no idempotency primitive that
  can close this window.
- A failed required media attachment stays retryable on the same task. When a
  screenshot was attached successfully, a failed additional video returns a
  warning and remains retryable if the browser retries the same submission
  after a lost response; there is no background retry worker.

## Feasibility of true browser-to-Asana streaming

**Decision: with the current stack, true end-to-end streaming is not
reliably feasible.**

The relay is a conventional PHP entry point. Before `index.php` runs, the
PHP SAPI parses the complete multipart request and exposes finished files in
`$_FILES`; nginx/FastCGI or Apache may buffer the request as well. The cURL
client uses `CURLFile`, which reads the PHP temp file without loading it all
into RAM, but this outgoing upload only starts after the incoming upload has
completed. This is disk-buffered and memory-efficient, not duplex streaming.

Asana attachment creation also requires a parent task GID. A streaming
design therefore needs a two-stage protocol: create the task from metadata,
then upload/stream the attachment. A browser disconnect, proxy timeout or
Asana failure after stage one leaves a task without an attachment and needs
durable state, retry/cleanup policy and backpressure handling. Disabling
proxy request buffering and `enable_post_data_reading`, writing a streaming
multipart parser and constructing a callback-driven outbound multipart body
would still be fragile in PHP-FPM and substantially enlarge the security
surface.

The direct-upload implementation already removes the most expensive old
hop (browser → Neos temp file → relay temp file). A true relay would only
overlap the remaining browser ingress and Asana egress: completion time could
drop from roughly `Tin + Tout` to `max(Tin, Tout)`, so the saved time is at
most `min(Tin, Tout)`. That does not justify the operational complexity for optimized files below
95 MB. If durable retries become necessary, direct object-storage upload
followed by an asynchronous worker is the more reliable next architecture;
it adds infrastructure and queue latency but cleanly handles retries and
orphan cleanup.

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
# unit tests (from the Neos distribution root; PHP runs inside DDEV)
ddev exec bin/phpunit --bootstrap Build/BuildEssentials/PhpUnit/UnitTestBootstrap.php \
    DistributionPackages/CodeQ.AsanaFeedback/Tests/Unit

# end-to-end tests in Chromium, Firefox and WebKit incl. Asana verification
# (ASANA_FEEDBACK_TEST_ACCESS_TOKEN is a real Asana PAT used only by this
# verification script, independent of the website's upload-grant secret)
cd Tests/E2E && npm install playwright && npx playwright install
ASANA_FEEDBACK_TEST_ACCESS_TOKEN=... node run-tests.mjs
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
