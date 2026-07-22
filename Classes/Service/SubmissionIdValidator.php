<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use Neos\Flow\Annotations as Flow;

/**
 * Validates the browser-generated idempotency key before it becomes part of
 * an upload grant or a relay state-file identifier.
 *
 * @Flow\Scope("singleton")
 */
class SubmissionIdValidator
{
    protected const SUBMISSION_ID_PATTERN = '/^[A-Za-z0-9-]{8,64}$/';

    public function isValid(string $submissionId): bool
    {
        return preg_match(self::SUBMISSION_ID_PATTERN, $submissionId) === 1;
    }
}
