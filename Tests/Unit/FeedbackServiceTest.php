<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\Exception\ValidationException;
use CodeQ\AsanaFeedback\Service\FeedbackService;
use PHPUnit\Framework\TestCase;

/**
 * Tests the pure validation and formatting logic of the FeedbackService.
 */
class FeedbackServiceTest extends TestCase
{
    protected FeedbackService $feedbackService;

    protected function setUp(): void
    {
        $this->feedbackService = new FeedbackService();
        $this->inject('settings', [
            'assignees' => [
                'roland' => ['label' => 'Roland', 'asanaUserGid' => '422230010221', 'visibleToClient' => true],
                'yurii' => ['label' => 'Yurii', 'asanaUserGid' => '510973132418883', 'visibleToClient' => false],
            ],
        ]);
    }

    protected function inject(string $propertyName, $value): void
    {
        $property = new \ReflectionProperty(FeedbackService::class, $propertyName);
        $property->setAccessible(true);
        $property->setValue($this->feedbackService, $value);
    }

    protected function invoke(string $methodName, array $arguments)
    {
        $method = new \ReflectionMethod(FeedbackService::class, $methodName);
        $method->setAccessible(true);
        return $method->invokeArgs($this->feedbackService, $arguments);
    }

    public function testClientVisibleAssigneeIsMappedForEveryone(): void
    {
        self::assertSame('422230010221', $this->invoke('resolveAssigneeGid', ['roland', false]));
        self::assertSame('422230010221', $this->invoke('resolveAssigneeGid', ['roland', true]));
    }

    public function testInternalAssigneeIsMappedForTeamMembersOnly(): void
    {
        self::assertSame('510973132418883', $this->invoke('resolveAssigneeGid', ['yurii', true]));

        $this->expectException(ValidationException::class);
        $this->invoke('resolveAssigneeGid', ['yurii', false]);
    }

    public function testUnknownAssigneeIsRejected(): void
    {
        $this->expectException(ValidationException::class);
        $this->invoke('resolveAssigneeGid', ['someone-else', true]);
    }

    public function testMissingAssigneeResolvesToNull(): void
    {
        self::assertNull($this->invoke('resolveAssigneeGid', ['', true]));
        self::assertNull($this->invoke('resolveAssigneeGid', [null, true]));
    }

    public function testSingleLineSanitizationRemovesControlCharactersAndTruncates(): void
    {
        $sanitized = $this->invoke('sanitizeSingleLine', ["Evil\nName\x00\x1B[31m", 200]);
        self::assertSame('Evil Name  [31m', $sanitized);

        $truncated = $this->invoke('sanitizeSingleLine', [str_repeat('a', 300), 200]);
        self::assertSame(200, mb_strlen($truncated));
    }

    public function testTaskNameUsesTitleWithoutPrefixWhenGiven(): void
    {
        self::assertSame('My custom title', $this->invoke('buildTaskName', ['My custom title', 'Some description']));
    }

    public function testTaskNameFallsBackToPrefixedDescriptionExcerpt(): void
    {
        self::assertSame('Website-Feedback: Some description', $this->invoke('buildTaskName', ['', 'Some description']));

        $longDescription = str_repeat('word ', 40);
        $fallbackName = $this->invoke('buildTaskName', ['', $longDescription]);
        self::assertStringStartsWith('Website-Feedback: word', $fallbackName);
        self::assertStringEndsWith('…', $fallbackName);
    }

    public function testTaskNotesContainAllMandatoryParts(): void
    {
        $notes = $this->invoke('buildTaskNotes', [
            "A description\nwith a second line",
            'Jane Doe',
            'https://example.com/de/page?query=1',
            ['browser' => 'Firefox 141', 'userAgent' => 'Mozilla/5.0', 'ignoredKey' => 'must not appear'],
        ]);

        self::assertStringContainsString('Autor: Jane Doe', $notes);
        self::assertStringContainsString('URL: https://example.com/de/page?query=1', $notes);
        self::assertStringContainsString('Erstellt am:', $notes);
        self::assertStringContainsString("A description\nwith a second line", $notes);
        self::assertStringContainsString('Browser: Firefox 141', $notes);
        self::assertStringContainsString('User-Agent: Mozilla/5.0', $notes);
        self::assertStringNotContainsString('must not appear', $notes);
    }
}
