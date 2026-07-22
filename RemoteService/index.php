<?php

declare(strict_types=1);

/**
 * Standalone browser-to-Asana feedback relay.
 *
 * The browser sends a multipart upload directly to this endpoint. Trusted
 * task routing and identity are carried in a short-lived encrypted grant
 * issued by the Neos package; the Asana token remains in config.php here.
 */

use CodeQ\AsanaFeedback\RemoteService\CurlAsanaClient;
use CodeQ\AsanaFeedback\RemoteService\RelayApplication;
use CodeQ\AsanaFeedback\RemoteService\RelayRequest;
use CodeQ\AsanaFeedback\RemoteService\RelayResponse;

require_once __DIR__ . '/RelayApplication.php';

function sendRelayResponse(RelayResponse $response): void
{
    http_response_code($response->statusCode);
    header('Cache-Control: no-store');
    foreach ($response->headers as $name => $value) {
        header($name . ': ' . $value);
    }
    if ($response->statusCode !== 204) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($response->payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }
    exit;
}

function relayError(int $statusCode, string $errorCode, string $message): void
{
    sendRelayResponse(new RelayResponse($statusCode, [], [
        'success' => false,
        'errorCode' => $errorCode,
        'message' => $message,
    ]));
}

if (!is_file(__DIR__ . '/config.php')) {
    relayError(500, 'configuration', 'The relay is not configured yet.');
}

try {
    $config = require __DIR__ . '/config.php';
    if (!is_array($config)) {
        throw new RuntimeException('config.php must return an array.');
    }

    $headers = function_exists('getallheaders') ? (array)getallheaders() : [];
    if (!isset($headers['X-Idempotency-Key']) && isset($_SERVER['HTTP_X_IDEMPOTENCY_KEY'])) {
        $headers['X-Idempotency-Key'] = (string)$_SERVER['HTTP_X_IDEMPOTENCY_KEY'];
    }

    $contentLength = isset($_SERVER['CONTENT_LENGTH']) && ctype_digit((string)$_SERVER['CONTENT_LENGTH'])
        ? (int)$_SERVER['CONTENT_LENGTH']
        : null;
    $request = new RelayRequest(
        (string)($_SERVER['REQUEST_METHOD'] ?? ''),
        (string)($_SERVER['HTTP_ORIGIN'] ?? ''),
        $headers,
        $_GET,
        $_POST,
        $_FILES,
        (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'),
        $contentLength
    );
    $asanaClient = new CurlAsanaClient(
        (string)($config['asanaAccessToken'] ?? ''),
        (array)($config['timeouts'] ?? []),
        (string)($config['asanaApiBaseUri'] ?? 'https://app.asana.com/api/1.0')
    );
    $application = new RelayApplication($config, $asanaClient);
    sendRelayResponse($application->handle($request));
} catch (Throwable $exception) {
    error_log('asana-feedback relay: unhandled error: ' . $exception->getMessage());
    relayError(500, 'configuration', 'The relay is not configured correctly.');
}
