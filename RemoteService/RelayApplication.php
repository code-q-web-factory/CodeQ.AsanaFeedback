<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\RemoteService;

require_once __DIR__ . '/UploadGrantCodec.php';

interface AsanaClientInterface
{
    public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string;

    /** @return array{taskGid: string, taskUrl: string} */
    public function createTask(array $task, string $sectionGid): array;

    /** @param array{path: string, mimeType: string, extension: string} $file */
    public function uploadAttachment(string $taskGid, array $file, string $fileName): void;
}

/** cURL adapter for the small subset of Asana used by the relay. */
final class CurlAsanaClient implements AsanaClientInterface
{
    private string $accessToken;
    private string $baseUri;
    private int $connectTimeoutSeconds;
    private int $requestTimeoutSeconds;
    private int $uploadTimeoutSeconds;

    public function __construct(string $accessToken, array $timeouts = [], string $baseUri = 'https://app.asana.com/api/1.0')
    {
        if ($accessToken === '') {
            throw new \InvalidArgumentException('The Asana access token is missing.');
        }
        $this->accessToken = $accessToken;
        $this->baseUri = rtrim($baseUri, '/');
        $this->connectTimeoutSeconds = (int)($timeouts['connectSeconds'] ?? 10);
        $this->requestTimeoutSeconds = (int)($timeouts['requestSeconds'] ?? 60);
        $this->uploadTimeoutSeconds = (int)($timeouts['uploadSeconds'] ?? 300);
    }

    public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
    {
        if ($sectionGid !== '') {
            return $sectionGid;
        }
        $sections = $this->request('GET', sprintf('/projects/%s/sections?opt_fields=name', rawurlencode($projectGid)));
        foreach ($sectionNames as $candidateName) {
            foreach ($sections as $section) {
                if (mb_strtolower(trim((string)($section['name'] ?? ''))) === mb_strtolower(trim((string)$candidateName))) {
                    return (string)$section['gid'];
                }
            }
        }

        throw new \RuntimeException('None of the configured section names exists in the Asana project.');
    }

    public function createTask(array $task, string $sectionGid): array
    {
        $taskData = [
            'projects' => [$task['projectGid']],
            'memberships' => [
                ['project' => $task['projectGid'], 'section' => $sectionGid],
            ],
            'name' => $task['name'],
            'notes' => $task['notes'],
        ];
        if ($task['assigneeGid'] !== '') {
            $taskData['assignee'] = $task['assigneeGid'];
        }
        $createdTask = $this->request('POST', '/tasks?opt_fields=permalink_url', ['data' => $taskData]);

        return [
            'taskGid' => (string)$createdTask['gid'],
            'taskUrl' => (string)($createdTask['permalink_url'] ?? ''),
        ];
    }

    public function uploadAttachment(string $taskGid, array $file, string $fileName): void
    {
        $this->request('POST', '/attachments', [
            'parent' => $taskGid,
            'file' => new \CURLFile($file['path'], $file['mimeType'], $fileName),
        ], true);
    }

    private function request(string $method, string $path, ?array $body = null, bool $multipart = false): array
    {
        $curlHandle = curl_init($this->baseUri . $path);
        $headers = [
            'Authorization: Bearer ' . $this->accessToken,
            'Accept: application/json',
        ];
        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_CONNECTTIMEOUT => $this->connectTimeoutSeconds,
            CURLOPT_TIMEOUT => $multipart ? $this->uploadTimeoutSeconds : $this->requestTimeoutSeconds,
            CURLOPT_LOW_SPEED_LIMIT => 1024,
            CURLOPT_LOW_SPEED_TIME => 30,
        ];
        if ($body !== null) {
            if ($multipart) {
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
            throw new \RuntimeException(sprintf('Asana request "%s %s" failed: %s', $method, $path, $curlError));
        }

        $decodedResponse = json_decode((string)$responseBody, true);
        if ($statusCode < 200 || $statusCode >= 300) {
            $message = $decodedResponse['errors'][0]['message'] ?? mb_substr((string)$responseBody, 0, 300);
            throw new \RuntimeException(sprintf('Asana request "%s %s" returned %d: %s', $method, $path, $statusCode, $message));
        }
        if (!is_array($decodedResponse) || !array_key_exists('data', $decodedResponse)) {
            throw new \RuntimeException(sprintf('Asana request "%s %s" returned an unexpected response.', $method, $path));
        }

        return $decodedResponse['data'];
    }
}

final class RelayRequest
{
    public string $method;
    public string $origin;
    public array $headers;
    public array $query;
    public array $fields;
    public array $files;
    public string $clientIp;
    public ?int $contentLength;

    public function __construct(
        string $method,
        string $origin,
        array $headers,
        array $query,
        array $fields,
        array $files,
        string $clientIp,
        ?int $contentLength
    ) {
        $this->method = strtoupper($method);
        $this->origin = $origin;
        $this->headers = array_change_key_case($headers, CASE_LOWER);
        $this->query = $query;
        $this->fields = $fields;
        $this->files = $files;
        $this->clientIp = $clientIp;
        $this->contentLength = $contentLength;
    }
}

final class RelayResponse
{
    public int $statusCode;
    public array $headers;
    public array $payload;

    public function __construct(int $statusCode, array $headers = [], array $payload = [])
    {
        $this->statusCode = $statusCode;
        $this->headers = $headers;
        $this->payload = $payload;
    }
}

/**
 * HTTP-independent relay module. The web entry point only adapts PHP
 * superglobals; CORS, authentication, validation, rate limiting and
 * idempotent Asana orchestration live behind this small interface.
 */
final class RelayApplication
{
    private const ALLOWED_REQUEST_HEADERS = ['content-type', 'x-idempotency-key'];
    private const MAXIMUM_FILE_BYTES = 95_000_000;
    private const MAXIMUM_REQUEST_BYTES = 191_000_000;
    private const MAXIMUM_UPLOAD_GRANT_BYTES = 512_000;
    private const SCREENSHOT_MIME_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
    private const VIDEO_MIME_TYPES = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];
    private const MIME_TYPE_EXTENSIONS = [
        'image/webp' => 'webp',
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'video/webm' => 'webm',
        'video/mp4' => 'mp4',
        'video/quicktime' => 'mov',
        'video/x-matroska' => 'mkv',
    ];

    private array $config;
    private AsanaClientInterface $asanaClient;
    private \Closure $now;
    private \Closure $isUploadedFile;
    private \Closure $detectMimeType;
    private UploadGrantCodec $codec;
    private string $stateDirectory;

    public function __construct(
        array $config,
        AsanaClientInterface $asanaClient,
        ?callable $now = null,
        ?callable $isUploadedFile = null,
        ?callable $detectMimeType = null
    ) {
        $this->config = $config;
        $this->asanaClient = $asanaClient;
        $this->now = \Closure::fromCallable($now ?? 'time');
        $this->isUploadedFile = \Closure::fromCallable($isUploadedFile ?? 'is_uploaded_file');
        $this->detectMimeType = \Closure::fromCallable($detectMimeType ?? static function (string $path): string {
            return (string)(new \finfo(FILEINFO_MIME_TYPE))->file($path);
        });
        $this->codec = new UploadGrantCodec((string)($config['grantSecret'] ?? ''));

        $this->stateDirectory = rtrim((string)($config['stateDirectory'] ?? ''), '/');
        if ($this->stateDirectory === '') {
            throw new \InvalidArgumentException('A persistent relay state directory must be configured.');
        }
        foreach ([$this->stateDirectory, $this->stateDirectory . '/idempotency', $this->stateDirectory . '/rate-limit'] as $directory) {
            if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
                throw new \RuntimeException(sprintf('The relay state directory "%s" could not be created.', $directory));
            }
        }
    }

    public function handle(RelayRequest $request): RelayResponse
    {
        if (($request->query['action'] ?? '') !== 'upload') {
            return $this->error(404, 'notFound', 'The requested relay operation does not exist.');
        }

        $siteId = trim((string)($request->query['site'] ?? ''));
        if (preg_match('/^[a-z0-9][a-z0-9-]{2,63}$/', $siteId) !== 1) {
            return $this->error(403, 'corsDenied', 'The upload site is invalid.', ['Vary' => 'Origin']);
        }
        $corsResult = $this->validateCors($request, $this->codec, $siteId);
        if ($corsResult instanceof RelayResponse) {
            return $corsResult;
        }
        $corsHeaders = $this->corsHeaders($request->origin);

        if ($request->method === 'OPTIONS') {
            $requestedMethod = strtoupper(trim((string)($request->headers['access-control-request-method'] ?? '')));
            $requestedHeaders = array_filter(array_map(
                static fn(string $header): string => strtolower(trim($header)),
                explode(',', (string)($request->headers['access-control-request-headers'] ?? ''))
            ));
            if ($requestedMethod !== 'POST' || array_diff($requestedHeaders, self::ALLOWED_REQUEST_HEADERS) !== []) {
                return $this->error(403, 'corsDenied', 'The requested CORS method or headers are not allowed.', ['Vary' => 'Origin']);
            }

            return new RelayResponse(204, $corsHeaders + [
                'Access-Control-Allow-Methods' => 'POST, OPTIONS',
                'Access-Control-Allow-Headers' => 'X-Idempotency-Key, Content-Type',
                'Access-Control-Max-Age' => '600',
            ]);
        }

        if ($request->method !== 'POST') {
            return $this->error(405, 'methodNotAllowed', 'Only POST and OPTIONS requests are accepted.', $corsHeaders);
        }

        return $this->handleUpload($request, $corsResult, $corsHeaders, $this->codec, $siteId);
    }

    private function handleUpload(
        RelayRequest $request,
        array $corsPolicy,
        array $corsHeaders,
        UploadGrantCodec $codec,
        string $siteId
    ): RelayResponse
    {
        if ($request->contentLength !== null && $request->contentLength > self::MAXIMUM_REQUEST_BYTES) {
            return $this->error(413, 'fileTooLarge', 'The upload exceeds the maximum request size.', $corsHeaders);
        }

        $grantFile = $request->files['uploadGrant'] ?? [];
        $grantPath = (string)($grantFile['tmp_name'] ?? '');
        $grantSize = $grantPath !== '' ? filesize($grantPath) : false;
        if (
            (int)($grantFile['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK
            || $grantPath === ''
            || !($this->isUploadedFile)($grantPath)
            || $grantSize === false
            || $grantSize <= 0
            || $grantSize > self::MAXIMUM_UPLOAD_GRANT_BYTES
            || (int)($grantFile['size'] ?? -1) > self::MAXIMUM_UPLOAD_GRANT_BYTES
        ) {
            return $this->error(401, 'unauthorized', 'The upload grant is missing or invalid.', $corsHeaders);
        }
        $rawGrant = file_get_contents($grantPath);
        if (!is_string($rawGrant)) {
            return $this->error(401, 'unauthorized', 'The upload grant is missing or invalid.', $corsHeaders);
        }
        $encodedGrant = trim($rawGrant);
        try {
            $grant = $codec->decodeGrant($encodedGrant, ($this->now)());
        } catch (\Throwable $exception) {
            return $this->error(401, 'unauthorized', 'The upload grant is invalid or expired.', $corsHeaders);
        }

        if (
            ($grant['siteId'] ?? null) !== $siteId
            || ($grant['siteId'] ?? null) !== ($corsPolicy['siteId'] ?? null)
            || !$codec->isOriginAllowed($request->origin, (array)($grant['allowedOrigins'] ?? []))
        ) {
            return $this->error(403, 'forbidden', 'The upload grant does not allow this site or origin.', $corsHeaders);
        }

        $idempotencyKey = trim((string)($request->headers['x-idempotency-key'] ?? ''));
        if (
            preg_match('/^[A-Za-z0-9-]{8,64}$/', $idempotencyKey) !== 1
            || $idempotencyKey !== (string)($grant['submissionId'] ?? '')
        ) {
            return $this->error(400, 'validation', 'A valid matching idempotency key is required.', $corsHeaders);
        }

        $rateLimitResponse = $this->countRequestOrDeny($siteId, $request->clientIp, $corsHeaders);
        if ($rateLimitResponse !== null) {
            return $rateLimitResponse;
        }
        $limits = is_array($grant['limits'] ?? null) ? $grant['limits'] : [];
        $screenshotFile = null;
        if (isset($request->files['screenshot']) && ($request->files['screenshot']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
            $screenshotResult = $this->validateUpload(
                $request->files['screenshot'],
                'screenshot',
                min(self::MAXIMUM_FILE_BYTES, (int)($limits['screenshotBytes'] ?? self::MAXIMUM_FILE_BYTES)),
                self::SCREENSHOT_MIME_TYPES,
                $corsHeaders
            );
            if ($screenshotResult instanceof RelayResponse) {
                return $screenshotResult;
            }
            $screenshotFile = $screenshotResult;
        }
        $videoFile = null;
        if (isset($request->files['video']) && ($request->files['video']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
            $videoResult = $this->validateUpload(
                $request->files['video'],
                'video',
                min(self::MAXIMUM_FILE_BYTES, (int)($limits['videoBytes'] ?? self::MAXIMUM_FILE_BYTES)),
                self::VIDEO_MIME_TYPES,
                $corsHeaders
            );
            if ($videoResult instanceof RelayResponse) {
                return $videoResult;
            }
            $videoFile = $videoResult;
        }
        if ($screenshotFile === null && $videoFile === null) {
            return $this->error(400, 'validation', 'A screenshot or screencast is required.', $corsHeaders);
        }
        $attachmentTypes = [
            'screenshot' => $screenshotFile !== null,
            'video' => $videoFile !== null,
        ];

        $task = $this->validateTask((array)($grant['task'] ?? []), $corsHeaders);
        if ($task instanceof RelayResponse) {
            return $task;
        }
        $taskFingerprint = (string)($grant['taskFingerprint'] ?? '');
        if (preg_match('/^[a-f0-9]{64}$/', $taskFingerprint) !== 1) {
            return $this->error(400, 'validation', 'The task fingerprint is invalid.', $corsHeaders);
        }
        $lock = $this->acquireSubmissionLock($siteId, $idempotencyKey);
        try {
            $state = $this->loadSubmissionState($lock['statePath']);
            if ($state !== null && ($state['taskFingerprint'] ?? '') !== $taskFingerprint) {
                return $this->error(409, 'idempotencyConflict', 'The idempotency key was already used for different feedback.', $corsHeaders);
            }
            if (
                $state !== null
                && isset($state['attachmentTypes'])
                && $state['attachmentTypes'] !== $attachmentTypes
            ) {
                return $this->error(409, 'idempotencyConflict', 'The idempotency key was already used with different attachments.', $corsHeaders);
            }
            if (($state['status'] ?? '') === 'completed' && is_array($state['response'] ?? null)) {
                return new RelayResponse(200, $corsHeaders, $state['response']);
            }

            if ($state === null) {
                try {
                    $sectionGid = $this->asanaClient->resolveSection(
                        $task['projectGid'],
                        $task['sectionGid'],
                        $task['sectionNames']
                    );
                    $createdTask = $this->asanaClient->createTask($task, $sectionGid);
                } catch (\Throwable $exception) {
                    error_log('asana-feedback relay: task creation failed: ' . $exception->getMessage());
                    return $this->error(502, 'asana', 'The Asana task could not be created.', $corsHeaders);
                }
                $state = [
                    'status' => 'taskCreated',
                    'taskFingerprint' => $taskFingerprint,
                    'attachmentTypes' => $attachmentTypes,
                    'taskGid' => (string)$createdTask['taskGid'],
                    'taskUrl' => (string)$createdTask['taskUrl'],
                    'screenshotUploaded' => $screenshotFile === null,
                    'videoUploaded' => $videoFile === null,
                ];
                $this->storeSubmissionState($lock['statePath'], $state);
            }

            if ($screenshotFile !== null && ($state['screenshotUploaded'] ?? false) !== true) {
                try {
                    $this->asanaClient->uploadAttachment(
                        (string)$state['taskGid'],
                        $screenshotFile,
                        'feedback-' . bin2hex(random_bytes(8)) . '.' . $screenshotFile['extension']
                    );
                    $state['screenshotUploaded'] = true;
                    $state['status'] = 'screenshotUploaded';
                    $this->storeSubmissionState($lock['statePath'], $state);
                } catch (\Throwable $exception) {
                    error_log('asana-feedback relay: screenshot upload failed for task ' . $state['taskGid'] . ': ' . $exception->getMessage());
                    $additionalPayload = [];
                    if (($grant['includeTaskUrl'] ?? false) === true) {
                        $additionalPayload['taskUrl'] = (string)$state['taskUrl'];
                    }
                    return $this->error(502, 'attachmentFailed', 'The task was created but the screenshot could not be attached.', $corsHeaders, $additionalPayload);
                }
            }

            $warnings = [];
            if ($videoFile !== null && ($state['videoUploaded'] ?? false) !== true) {
                try {
                    $this->asanaClient->uploadAttachment(
                        (string)$state['taskGid'],
                        $videoFile,
                        'feedback-' . bin2hex(random_bytes(8)) . '.' . $videoFile['extension']
                    );
                    $state['videoUploaded'] = true;
                } catch (\Throwable $exception) {
                    error_log('asana-feedback relay: video upload failed for task ' . $state['taskGid'] . ': ' . $exception->getMessage());
                    if ($screenshotFile === null) {
                        $additionalPayload = [];
                        if (($grant['includeTaskUrl'] ?? false) === true) {
                            $additionalPayload['taskUrl'] = (string)$state['taskUrl'];
                        }
                        return $this->error(502, 'attachmentFailed', 'The task was created but the screencast could not be attached.', $corsHeaders, $additionalPayload);
                    }
                    $warnings[] = 'videoUploadFailed';
                }
            }

            $responsePayload = [
                'success' => true,
                'taskUrl' => ($grant['includeTaskUrl'] ?? false) === true ? (string)$state['taskUrl'] : null,
                'warnings' => $warnings,
            ];
            $state['status'] = $warnings === [] ? 'completed' : 'videoFailed';
            $state['response'] = $responsePayload;
            $this->storeSubmissionState($lock['statePath'], $state);

            return new RelayResponse(200, $corsHeaders, $responsePayload);
        } finally {
            flock($lock['handle'], LOCK_UN);
            fclose($lock['handle']);
        }
    }

    /** @return array{path: string, mimeType: string, extension: string}|RelayResponse */
    private function validateUpload(
        array $file,
        string $fieldName,
        int $maximumBytes,
        array $allowedMimeTypes,
        array $corsHeaders
    ) {
        $uploadError = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if (in_array($uploadError, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)) {
            return $this->error(413, 'fileTooLarge', sprintf('The "%s" file exceeds the %s limit.', $fieldName, $this->formatBytes($maximumBytes)), $corsHeaders);
        }
        if ($uploadError !== UPLOAD_ERR_OK) {
            return $this->error(400, 'validation', sprintf('The "%s" upload failed.', $fieldName), $corsHeaders);
        }

        $path = (string)($file['tmp_name'] ?? '');
        if ($path === '' || !($this->isUploadedFile)($path)) {
            return $this->error(400, 'validation', sprintf('The "%s" upload is invalid.', $fieldName), $corsHeaders);
        }
        $reportedSize = (int)($file['size'] ?? -1);
        $actualSize = filesize($path);
        if ($reportedSize > $maximumBytes || $actualSize === false || $actualSize > $maximumBytes) {
            return $this->error(413, 'fileTooLarge', sprintf('The "%s" file exceeds the %s limit.', $fieldName, $this->formatBytes($maximumBytes)), $corsHeaders);
        }
        if ($actualSize <= 0) {
            return $this->error(400, 'validation', sprintf('The "%s" file is empty.', $fieldName), $corsHeaders);
        }

        $mimeType = (string)($this->detectMimeType)($path);
        if (!in_array($mimeType, $allowedMimeTypes, true)) {
            return $this->error(400, 'invalidFileType', sprintf('The "%s" file type is not allowed.', $fieldName), $corsHeaders);
        }

        return [
            'path' => $path,
            'mimeType' => $mimeType,
            'extension' => self::MIME_TYPE_EXTENSIONS[$mimeType],
        ];
    }

    /** @return array|RelayResponse */
    private function validateTask(array $task, array $corsHeaders)
    {
        $projectGid = trim((string)($task['projectGid'] ?? ''));
        $sectionGid = trim((string)($task['sectionGid'] ?? ''));
        $assigneeGid = trim((string)($task['assigneeGid'] ?? ''));
        $name = trim((string)($task['name'] ?? ''));
        $notes = (string)($task['notes'] ?? '');
        if (preg_match('/^\d+$/', $projectGid) !== 1) {
            return $this->error(400, 'validation', 'The task project is invalid.', $corsHeaders);
        }
        if ($sectionGid !== '' && preg_match('/^\d+$/', $sectionGid) !== 1) {
            return $this->error(400, 'validation', 'The task section is invalid.', $corsHeaders);
        }
        if ($assigneeGid !== '' && preg_match('/^\d+$/', $assigneeGid) !== 1) {
            return $this->error(400, 'validation', 'The task assignee is invalid.', $corsHeaders);
        }
        if ($name === '' || mb_strlen($name) > 1024 || mb_strlen($notes) > 65536) {
            return $this->error(400, 'validation', 'The task text is invalid.', $corsHeaders);
        }

        return [
            'projectGid' => $projectGid,
            'sectionGid' => $sectionGid,
            'sectionNames' => array_values(array_map('strval', (array)($task['sectionNames'] ?? []))),
            'name' => $name,
            'notes' => $notes,
            'assigneeGid' => $assigneeGid,
        ];
    }

    /** @return array{handle: resource, statePath: string} */
    private function acquireSubmissionLock(string $siteId, string $idempotencyKey): array
    {
        $identifier = hash('sha256', $siteId . "\0" . $idempotencyKey);
        $basePath = $this->stateDirectory . '/idempotency/' . $identifier;
        $handle = fopen($basePath . '.lock', 'c+');
        if ($handle === false || !flock($handle, LOCK_EX)) {
            throw new \RuntimeException('The idempotency lock could not be acquired.');
        }

        return ['handle' => $handle, 'statePath' => $basePath . '.json'];
    }

    private function loadSubmissionState(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $contents = file_get_contents($path);
        $state = $contents === false ? null : json_decode($contents, true);
        if (!is_array($state)) {
            // Never treat damaged state as a new submission: doing so could
            // create a duplicate Asana task for the same key.
            throw new \RuntimeException('The idempotency state is unreadable or damaged.');
        }

        return $state;
    }

    private function storeSubmissionState(string $path, array $state): void
    {
        $temporaryPath = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
        $encodedState = json_encode($state, JSON_THROW_ON_ERROR);
        $writtenBytes = file_put_contents($temporaryPath, $encodedState, LOCK_EX);
        if ($writtenBytes !== strlen($encodedState) || !rename($temporaryPath, $path)) {
            @unlink($temporaryPath);
            throw new \RuntimeException('The idempotency state could not be persisted.');
        }
    }

    private function countRequestOrDeny(string $siteId, string $clientIp, array $corsHeaders): ?RelayResponse
    {
        $limits = $this->config['rateLimit'] ?? [];
        foreach ([
            ['name' => 'minute', 'seconds' => 60, 'maximum' => (int)($limits['maxPerMinute'] ?? 5)],
            ['name' => 'hour', 'seconds' => 3600, 'maximum' => (int)($limits['maxPerHour'] ?? 40)],
        ] as $window) {
            $bucket = intdiv(($this->now)(), $window['seconds']);
            $path = $this->stateDirectory . '/rate-limit/' . hash('sha256', $siteId . "\0" . $clientIp . "\0" . $window['name'] . "\0" . $bucket);
            $handle = fopen($path, 'c+');
            if ($handle === false || !flock($handle, LOCK_EX)) {
                throw new \RuntimeException('The rate-limit state could not be locked.');
            }
            $contents = stream_get_contents($handle);
            $count = (int)($contents === false || $contents === '' ? 0 : $contents);
            if ($count >= $window['maximum']) {
                flock($handle, LOCK_UN);
                fclose($handle);
                return $this->error(429, 'rateLimit', 'Too many requests, please try again later.', $corsHeaders);
            }
            ftruncate($handle, 0);
            rewind($handle);
            fwrite($handle, (string)($count + 1));
            fflush($handle);
            flock($handle, LOCK_UN);
            fclose($handle);
        }

        return null;
    }

    /** @return array|RelayResponse */
    private function validateCors(
        RelayRequest $request,
        UploadGrantCodec $codec,
        string $siteId
    )
    {
        try {
            $policy = $codec->decodeCorsPolicy(
                (string)($request->query['cors'] ?? ''),
                ($this->now)()
            );
        } catch (\Throwable $exception) {
            return $this->error(403, 'corsDenied', 'The CORS policy is missing, invalid or expired.', ['Vary' => 'Origin']);
        }

        if (
            ($policy['siteId'] ?? null) !== $siteId
            || !$codec->isOriginAllowed($request->origin, $policy['allowedOrigins'])
        ) {
            return $this->error(403, 'corsDenied', 'The request origin is not allowed.', ['Vary' => 'Origin']);
        }

        return $policy;
    }

    private function formatBytes(int $bytes): string
    {
        $megabytes = $bytes / 1_000_000;

        return rtrim(rtrim(number_format($megabytes, 2, '.', ''), '0'), '.') . ' MB';
    }

    private function corsHeaders(string $origin): array
    {
        return [
            'Access-Control-Allow-Origin' => $origin,
            'Vary' => 'Origin',
        ];
    }

    private function error(
        int $statusCode,
        string $errorCode,
        string $message,
        array $headers = [],
        array $additionalPayload = []
    ): RelayResponse
    {
        return new RelayResponse($statusCode, $headers, [
            'success' => false,
            'errorCode' => $errorCode,
            'message' => $message,
        ] + $additionalPayload);
    }
}
