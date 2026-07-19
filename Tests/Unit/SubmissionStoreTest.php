<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\Service\SubmissionStore;
use PHPUnit\Framework\TestCase;

/**
 * Guards the submission id validation that protects the cache key against
 * malformed client input.
 */
class SubmissionStoreTest extends TestCase
{
    protected SubmissionStore $submissionStore;

    protected function setUp(): void
    {
        $this->submissionStore = new SubmissionStore();
    }

    public function testAcceptsUuidAndFallbackIds(): void
    {
        self::assertTrue($this->submissionStore->isValidSubmissionId('70ba5883-9047-4e4f-8c47-043141190832'));
        self::assertTrue($this->submissionStore->isValidSubmissionId('cqaf-lq9k2z-abcd1234ef'));
    }

    public function testRejectsEmptyTooShortOrUnsafeIds(): void
    {
        self::assertFalse($this->submissionStore->isValidSubmissionId(''));
        self::assertFalse($this->submissionStore->isValidSubmissionId('short'));
        self::assertFalse($this->submissionStore->isValidSubmissionId('has spaces and/slashes'));
        self::assertFalse($this->submissionStore->isValidSubmissionId(str_repeat('a', 65)));
    }
}
