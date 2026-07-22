<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use CodeQ\AsanaFeedback\Exception\ValidationException;
use CodeQ\AsanaFeedback\RemoteService\UploadGrantCodec;
use Neos\Flow\Annotations as Flow;

/**
 * Issues short-lived browser upload grants. The encrypted grant carries all
 * trusted Asana routing and user claims, while the separately signed CORS
 * policy contains only an opaque project namespace, the request origin and
 * expiry.
 *
 * @Flow\Scope("singleton")
 */
class UploadGrantService
{
    private const DEFAULT_GRANT_LIFETIME_SECONDS = 600;
    private const MAXIMUM_FILE_BYTES = 95_000_000;
    private const MAXIMUM_UPLOAD_GRANT_BYTES = 512_000;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback")
     * @var array
     */
    protected $settings;

    /**
     * @return array{uploadUrl: string, uploadToken: string, idempotencyKey: string}
     */
    public function createGrant(array $preparedSubmission, string $requestOrigin, ?int $now = null): array
    {
        $serviceSettings = $this->settings['feedbackService'] ?? [];
        $limits = $this->settings['limits'] ?? [];

        $endpoint = trim((string)($serviceSettings['endpoint'] ?? ''));
        if (filter_var($endpoint, FILTER_VALIDATE_URL) === false || parse_url($endpoint, PHP_URL_SCHEME) !== 'https') {
            throw new ConfigurationException('A valid HTTPS feedback service endpoint is required.', 1752130040);
        }
        $sharedSecret = (string)($serviceSettings['grantSecret'] ?? '');
        if (strlen($sharedSecret) < 32) {
            throw new ConfigurationException('No sufficiently strong feedback service grant secret is configured.', 1752130041);
        }

        $codec = new UploadGrantCodec($sharedSecret);
        $requestOrigin = trim($requestOrigin);
        if (!$codec->isOriginAllowed($requestOrigin, [$requestOrigin])) {
            throw new ConfigurationException('The feedback request origin is invalid.', 1752130043);
        }

        $submissionId = (string)($preparedSubmission['submissionId'] ?? '');
        $taskFingerprint = (string)($preparedSubmission['taskFingerprint'] ?? '');
        if (
            $submissionId === ''
            || preg_match('/^[a-f0-9]{64}$/', $taskFingerprint) !== 1
            || !isset($preparedSubmission['task'])
            || !is_array($preparedSubmission['task'])
        ) {
            throw new \InvalidArgumentException('The prepared feedback submission is incomplete.');
        }

        $projectGid = trim((string)($this->settings['asanaProjectGid'] ?? ''));
        if (preg_match('/^\d+$/', $projectGid) !== 1) {
            throw new ConfigurationException('No valid Asana project GID is configured.', 1752130042);
        }
        if ((string)($preparedSubmission['task']['projectGid'] ?? '') !== $projectGid) {
            throw new \InvalidArgumentException('The prepared feedback project does not match the configured project.');
        }

        $siteId = $codec->deriveSiteId($projectGid);
        $expiresAt = ($now ?? time()) + self::DEFAULT_GRANT_LIFETIME_SECONDS;
        $maximumFileBytes = min(
            self::MAXIMUM_FILE_BYTES,
            max(1, (int)($limits['fileBytes'] ?? self::MAXIMUM_FILE_BYTES))
        );
        $screenshotBytes = min(
            $maximumFileBytes,
            max(1, (int)($limits['screenshotBytes'] ?? self::MAXIMUM_FILE_BYTES))
        );

        $commonClaims = [
            'expiresAt' => $expiresAt,
            'siteId' => $siteId,
            'allowedOrigins' => [$requestOrigin],
        ];
        $uploadToken = $codec->encodeGrant($commonClaims + [
            'submissionId' => $submissionId,
            'taskFingerprint' => $taskFingerprint,
            'includeTaskUrl' => ($preparedSubmission['includeTaskUrl'] ?? false) === true,
            'limits' => [
                'screenshotBytes' => $screenshotBytes,
                'videoBytes' => $maximumFileBytes,
            ],
            'task' => $preparedSubmission['task'],
        ]);
        if (strlen($uploadToken) > self::MAXIMUM_UPLOAD_GRANT_BYTES) {
            throw new ValidationException('The feedback metadata is too large to authorize safely.', 1752130045);
        }
        $corsPolicy = $codec->encodeCorsPolicy($commonClaims);
        $separator = str_contains($endpoint, '?') ? '&' : '?';

        return [
            'uploadUrl' => $endpoint . $separator . 'action=upload&site=' . rawurlencode($siteId) . '&cors=' . rawurlencode($corsPolicy),
            'uploadToken' => $uploadToken,
            'idempotencyKey' => $submissionId,
        ];
    }
}
