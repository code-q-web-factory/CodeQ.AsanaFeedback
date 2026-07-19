<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use Neos\Cache\Frontend\VariableFrontend;
use Neos\Flow\Annotations as Flow;

/**
 * Remembers the result of a completed feedback submission keyed by the
 * client generated submission id. When a slow submission times out on an
 * upstream proxy the widget retries with the same id; this store lets the
 * server return the already created task instead of creating a duplicate.
 *
 * @Flow\Scope("singleton")
 */
class SubmissionStore
{
    // completed submissions are remembered for a day; long enough to cover
    // any manual retry, short enough to keep the cache small
    protected const RESULT_LIFETIME_SECONDS = 86400;

    // accept only the ids the widget generates (UUIDs and the fallback form)
    protected const SUBMISSION_ID_PATTERN = '/^[A-Za-z0-9-]{8,64}$/';

    /**
     * @var VariableFrontend
     */
    protected $cache;

    public function setCache(VariableFrontend $cache): void
    {
        $this->cache = $cache;
    }

    public function isValidSubmissionId(string $submissionId): bool
    {
        return preg_match(self::SUBMISSION_ID_PATTERN, $submissionId) === 1;
    }

    /**
     * @return array{success: bool, taskUrl: ?string, warnings: array<string>}|null
     */
    public function getResult(string $submissionId): ?array
    {
        if (!$this->isValidSubmissionId($submissionId)) {
            return null;
        }

        $cached = $this->cache->get($this->cacheIdentifier($submissionId));

        return is_array($cached) ? $cached : null;
    }

    /**
     * @param array{success: bool, taskUrl: ?string, warnings: array<string>} $result
     */
    public function storeResult(string $submissionId, array $result): void
    {
        if (!$this->isValidSubmissionId($submissionId)) {
            return;
        }

        $this->cache->set($this->cacheIdentifier($submissionId), $result, [], self::RESULT_LIFETIME_SECONDS);
    }

    protected function cacheIdentifier(string $submissionId): string
    {
        // the raw id may not be a legal cache identifier, so it is hashed
        return 'submission_' . sha1($submissionId);
    }
}
