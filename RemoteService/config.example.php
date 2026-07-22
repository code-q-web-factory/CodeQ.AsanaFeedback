<?php

// Copy this file to config.php on the relay server and fill in the values.
// config.php must never be committed to version control.
return [
    // Personal access token of the dedicated Asana integration user. This is
    // the only place the token lives; the CMS projects never see it.
    // https://app.asana.com/0/my-apps
    'asanaAccessToken' => '',

    // Relay-wide secret used by every Neos installation to encrypt and sign
    // short-lived grants. Generate it once with: openssl rand -hex 32
    'grantSecret' => '',

    // Must be writable by PHP and should live outside the public web root.
    // Completed idempotency records and small rate-limit counters live here;
    // uploaded files continue to use PHP's generated upload temp files.
    'stateDirectory' => '/var/lib/codeq-asana-feedback',

    'rateLimit' => [
        'maxPerMinute' => 5,
        'maxPerHour' => 40,
    ],

    'timeouts' => [
        'connectSeconds' => 10,
        'requestSeconds' => 60,
        'uploadSeconds' => 300,
    ],
];
