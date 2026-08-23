<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\Eel\FeedbackHelper;
use PHPUnit\Framework\TestCase;

final class FeedbackHelperTest extends TestCase
{
    /** @test */
    public function itReturnsTheContentHashOfAnAsset(): void
    {
        $asset = tempnam(sys_get_temp_dir(), 'asana-feedback-asset-');
        self::assertIsString($asset);
        file_put_contents($asset, 'widget contents');

        try {
            self::assertSame(sha1('widget contents'), (new FeedbackHelper())->assetVersion($asset));
        } finally {
            unlink($asset);
        }
    }
}
