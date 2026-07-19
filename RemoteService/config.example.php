<?php

// Copy this file to config.php on the relay server and fill in the values.
// config.php must never be committed to version control.
return [
    // Personal access token of the dedicated Asana integration user. This is
    // the only place the token lives; the CMS projects never see it.
    // https://app.asana.com/0/my-apps
    'asanaAccessToken' => '',

    // Shared secret the CMS projects use to authenticate against this relay
    // (their ASANA_FEEDBACK_ACCESS_TOKEN environment variable). Generate a
    // strong random value, e.g. with: openssl rand -hex 32
    'sharedSecret' => '',

    // Optional allowlist of Asana project GIDs tasks may be created in.
    // An empty list accepts every project the integration user can access.
    'allowedProjectGids' => [],
];
