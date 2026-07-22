<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\Service\SubmissionIdValidator;
use PHPUnit\Framework\TestCase;

/**
 * Guards the submission id validation that protects the cache key against
 * malformed client input.
 */
class SubmissionIdValidatorTest extends TestCase
{
    protected SubmissionIdValidator $validator;

    protected function setUp(): void
    {
        $this->validator = new SubmissionIdValidator();
    }

    public function testAcceptsUuidAndFallbackIds(): void
    {
        self::assertTrue($this->validator->isValid('70ba5883-9047-4e4f-8c47-043141190832'));
        self::assertTrue($this->validator->isValid('cqaf-lq9k2z-abcd1234ef'));
    }

    public function testRejectsEmptyTooShortOrUnsafeIds(): void
    {
        self::assertFalse($this->validator->isValid(''));
        self::assertFalse($this->validator->isValid('short'));
        self::assertFalse($this->validator->isValid('has spaces and/slashes'));
        self::assertFalse($this->validator->isValid(str_repeat('a', 65)));
    }
}
