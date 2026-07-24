<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\RemoteService;

final class AsanaClientException extends \RuntimeException
{
    public int $statusCode;
    public string $errorCode;
    public string $publicMessage;

    public function __construct(int $statusCode, string $errorCode, string $publicMessage, string $diagnosticMessage)
    {
        parent::__construct($diagnosticMessage);
        $this->statusCode = $statusCode;
        $this->errorCode = $errorCode;
        $this->publicMessage = $publicMessage;
    }

    public static function fromHttpResponse(int $asanaStatusCode, string $diagnosticMessage): self
    {
        [$statusCode, $errorCode, $publicMessage] = match (true) {
            $asanaStatusCode === 401 => [
                502,
                'asanaAuthentication',
                'Asana rejected the configured access token. Please update it on the feedback relay.',
            ],
            $asanaStatusCode === 403 => [
                502,
                'asanaPermission',
                'The feedback relay does not have permission for the requested Asana operation.',
            ],
            $asanaStatusCode === 404 => [
                502,
                'asanaNotFound',
                'The configured Asana project, section, or task could not be found.',
            ],
            $asanaStatusCode === 429 => [
                503,
                'asanaRateLimit',
                'Asana is currently rate limiting feedback requests. Please try again later.',
            ],
            $asanaStatusCode >= 500 => [
                503,
                'asanaUnavailable',
                'Asana is currently unavailable. Please try again later.',
            ],
            default => [
                502,
                'asanaRejected',
                'Asana rejected the feedback request.',
            ],
        };

        return new self($statusCode, $errorCode, $publicMessage, $diagnosticMessage);
    }

    public static function fromConnectionFailure(string $diagnosticMessage): self
    {
        return new self(
            503,
            'asanaUnavailable',
            'The feedback relay could not connect to Asana. Please try again later.',
            $diagnosticMessage
        );
    }

    public static function fromUnexpectedResponse(string $diagnosticMessage): self
    {
        return new self(
            502,
            'asanaResponse',
            'Asana returned an invalid response to the feedback relay.',
            $diagnosticMessage
        );
    }
}
