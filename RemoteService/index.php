<?php

declare(strict_types=1);

/**
 * Asana feedback relay for https://github.com/code-q-web-factory/CodeQ.AsanaFeedback
 *
 * Standalone single-purpose endpoint that is deployed separately from the
 * Neos CMS projects (e.g. at https://docs.codeq.at/asana-feedback/). It is
 * the only place that knows the Asana personal access token: the CMS
 * projects merely hold a shared secret and can therefore do nothing with
 * Asana except create exactly one feedback task per request through this
 * script.
 *
 * Request: POST multipart/form-data, authenticated via
 * "Authorization: Bearer <sharedSecret>".
 * Fields:
 *   projectGid    required, numeric Asana project GID
 *   name          required task name
 *   notes         optional task notes
 *   assigneeGid   optional, numeric Asana user GID
 *   sectionGid    optional, numeric Asana section GID
 *   sectionNames  optional JSON array of section names, used to resolve the
 *                 target section when no sectionGid is given
 * Files:
 *   screenshot    required image attachment (png/jpeg)
 *   video         optional screencast attachment (webm/mp4/mov/mkv)
 *
 * Response: JSON {success, taskGid, taskUrl, warnings} or
 * {success: false, errorCode, message}.
 */

const ASANA_API_BASE_URI = 'https://app.asana.com/api/1.0';

const ALLOWED_SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg'];
const ALLOWED_VIDEO_MIME_TYPES = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];
const MIME_TYPE_EXTENSIONS = [
    'image/png' => 'png',
    'image/jpeg' => 'jpg',
    'video/webm' => 'webm',
    'video/mp4' => 'mp4',
    'video/quicktime' => 'mov',
    'video/x-matroska' => 'mkv',
];

function respond(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function fail(int $statusCode, string $errorCode, string $message, array $additionalPayload = []): void
{
    respond($statusCode, array_merge(
        ['success' => false, 'errorCode' => $errorCode, 'message' => $message],
        $additionalPayload
    ));
}

/**
 * Executes a request against the Asana API and returns the decoded "data"
 * part of the response. Throws a RuntimeException on every failure.
 *
 * @param array|null $body JSON body, or multipart fields when $multipart is true
 */
function asanaRequest(string $accessToken, string $method, string $path, ?array $body = null, bool $multipart = false): array
{
    $curlHandle = curl_init(ASANA_API_BASE_URI . $path);
    $headers = [
        'Authorization: Bearer ' . $accessToken,
        'Accept: application/json',
    ];

    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_CONNECTTIMEOUT => 10,
    ];

    if ($body !== null) {
        if ($multipart) {
            // curl sets the multipart/form-data content type including boundary itself
            $options[CURLOPT_POSTFIELDS] = $body;
        } else {
            $headers[] = 'Content-Type: application/json';
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
        }
    }

    $options[CURLOPT_HTTPHEADER] = $headers;
    curl_setopt_array($curlHandle, $options);

    $responseBody = curl_exec($curlHandle);
    $curlError = curl_error($curlHandle);
    $statusCode = (int)curl_getinfo($curlHandle, CURLINFO_RESPONSE_CODE);
    curl_close($curlHandle);

    if ($responseBody === false) {
        throw new RuntimeException(sprintf('Asana API request "%s %s" failed on transport level: %s', $method, $path, $curlError));
    }

    $decodedResponse = json_decode((string)$responseBody, true);
    if ($statusCode < 200 || $statusCode >= 300) {
        $asanaErrorMessage = $decodedResponse['errors'][0]['message'] ?? mb_substr((string)$responseBody, 0, 300);
        throw new RuntimeException(sprintf('Asana API request "%s %s" returned status %d: %s', $method, $path, $statusCode, $asanaErrorMessage));
    }
    if (!is_array($decodedResponse) || !array_key_exists('data', $decodedResponse)) {
        throw new RuntimeException(sprintf('Asana API request "%s %s" returned an unexpected response body.', $method, $path));
    }

    return $decodedResponse['data'];
}

/**
 * Validates an uploaded attachment: real upload, no transfer error and a
 * MIME type (sniffed from the file content, never taken from the client)
 * inside the allowlist.
 *
 * @return array{path: string, mimeType: string, extension: string}
 */
function validateUpload(array $file, array $allowedMimeTypes, string $fieldName): array
{
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string)$file['tmp_name'])) {
        fail(400, 'validation', sprintf('The "%s" upload failed.', $fieldName));
    }

    $fileInfo = new finfo(FILEINFO_MIME_TYPE);
    $detectedMimeType = (string)$fileInfo->file((string)$file['tmp_name']);
    if (!in_array($detectedMimeType, $allowedMimeTypes, true)) {
        fail(400, 'validation', sprintf('The "%s" file type "%s" is not allowed.', $fieldName, $detectedMimeType));
    }

    return [
        'path' => (string)$file['tmp_name'],
        'mimeType' => $detectedMimeType,
        'extension' => MIME_TYPE_EXTENSIONS[$detectedMimeType],
    ];
}

// ---------------------------------------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'methodNotAllowed', 'Only POST requests are accepted.');
}

if (!is_file(__DIR__ . '/config.php')) {
    fail(500, 'configuration', 'The relay is not configured yet (config.php is missing).');
}
$config = require __DIR__ . '/config.php';
$asanaAccessToken = (string)($config['asanaAccessToken'] ?? '');
$sharedSecret = (string)($config['sharedSecret'] ?? '');
if ($asanaAccessToken === '' || $sharedSecret === '') {
    fail(500, 'configuration', 'The relay configuration is incomplete.');
}

// authenticate the caller with a constant time comparison
$providedSecret = '';
if (preg_match('/^Bearer\s+(.+)$/i', (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''), $matches) === 1) {
    $providedSecret = trim($matches[1]);
}
if ($providedSecret === '' || !hash_equals($sharedSecret, $providedSecret)) {
    fail(401, 'unauthorized', 'Missing or invalid access token.');
}

$projectGid = trim((string)($_POST['projectGid'] ?? ''));
if (preg_match('/^\d+$/', $projectGid) !== 1) {
    fail(400, 'validation', 'A numeric "projectGid" is required.');
}

$allowedProjectGids = array_map('strval', (array)($config['allowedProjectGids'] ?? []));
if ($allowedProjectGids !== [] && !in_array($projectGid, $allowedProjectGids, true)) {
    fail(403, 'forbidden', 'The requested Asana project is not allowed.');
}

$name = trim((string)($_POST['name'] ?? ''));
if ($name === '' || mb_strlen($name) > 1024) {
    fail(400, 'validation', 'A task "name" of at most 1024 characters is required.');
}

$notes = (string)($_POST['notes'] ?? '');
if (mb_strlen($notes) > 65536) {
    fail(400, 'validation', 'The task "notes" exceed the allowed length.');
}

$assigneeGid = trim((string)($_POST['assigneeGid'] ?? ''));
if ($assigneeGid !== '' && preg_match('/^\d+$/', $assigneeGid) !== 1) {
    fail(400, 'validation', 'The "assigneeGid" must be numeric.');
}

$sectionGid = trim((string)($_POST['sectionGid'] ?? ''));
if ($sectionGid !== '' && preg_match('/^\d+$/', $sectionGid) !== 1) {
    fail(400, 'validation', 'The "sectionGid" must be numeric.');
}

$sectionNames = json_decode((string)($_POST['sectionNames'] ?? '[]'), true);
if (!is_array($sectionNames)) {
    $sectionNames = [];
}

$screenshotFile = validateUpload($_FILES['screenshot'] ?? [], ALLOWED_SCREENSHOT_MIME_TYPES, 'screenshot');
$videoFile = null;
if (isset($_FILES['video']) && ($_FILES['video']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
    $videoFile = validateUpload($_FILES['video'], ALLOWED_VIDEO_MIME_TYPES, 'video');
}

try {
    // resolve the target section by name when no fixed GID was requested
    if ($sectionGid === '') {
        $sections = asanaRequest($asanaAccessToken, 'GET', sprintf('/projects/%s/sections?opt_fields=name', urlencode($projectGid)));
        foreach ($sectionNames as $candidateName) {
            foreach ($sections as $section) {
                if (mb_strtolower(trim((string)($section['name'] ?? ''))) === mb_strtolower(trim((string)$candidateName))) {
                    $sectionGid = (string)$section['gid'];
                    break 2;
                }
            }
        }
        if ($sectionGid === '') {
            fail(400, 'configuration', 'None of the requested section names exists in the Asana project.');
        }
    }

    $taskData = [
        'projects' => [$projectGid],
        'memberships' => [
            ['project' => $projectGid, 'section' => $sectionGid],
        ],
        'name' => $name,
        'notes' => $notes,
    ];
    if ($assigneeGid !== '') {
        $taskData['assignee'] = $assigneeGid;
    }

    $task = asanaRequest($asanaAccessToken, 'POST', '/tasks?opt_fields=permalink_url', ['data' => $taskData]);
    $taskGid = (string)$task['gid'];
    $taskUrl = (string)($task['permalink_url'] ?? '');
} catch (RuntimeException $exception) {
    error_log('asana-feedback relay: ' . $exception->getMessage());
    fail(502, 'asana', 'The Asana task could not be created.');
}

// the screenshot is a mandatory part of the report: without it the
// submission counts as failed even though the task already exists
try {
    asanaRequest($asanaAccessToken, 'POST', '/attachments', [
        'parent' => $taskGid,
        'file' => new CURLFile($screenshotFile['path'], $screenshotFile['mimeType'], 'screenshot.' . $screenshotFile['extension']),
    ], true);
} catch (RuntimeException $exception) {
    error_log('asana-feedback relay: task ' . $taskGid . ' created but screenshot upload failed: ' . $exception->getMessage());
    fail(502, 'attachmentFailed', 'The task was created but the screenshot could not be attached.', [
        'taskGid' => $taskGid,
        'taskUrl' => $taskUrl,
    ]);
}

$warnings = [];
if ($videoFile !== null) {
    try {
        asanaRequest($asanaAccessToken, 'POST', '/attachments', [
            'parent' => $taskGid,
            'file' => new CURLFile($videoFile['path'], $videoFile['mimeType'], 'screencast.' . $videoFile['extension']),
        ], true);
    } catch (RuntimeException $exception) {
        // a failed optional screencast should not invalidate the report
        error_log('asana-feedback relay: task ' . $taskGid . ' created but screencast upload failed: ' . $exception->getMessage());
        $warnings[] = 'videoUploadFailed';
    }
}

respond(200, [
    'success' => true,
    'taskGid' => $taskGid,
    'taskUrl' => $taskUrl,
    'warnings' => $warnings,
]);
