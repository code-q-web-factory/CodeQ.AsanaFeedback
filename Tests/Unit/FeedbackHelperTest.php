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

    /** @test */
    public function itReturnsVersionedFrontendAssetUrls(): void
    {
        $helper = new class () extends FeedbackHelper {
            public function assetVersion(string $resourceUri): string
            {
                return sha1($resourceUri);
            }
        };
        $urls = $helper->frontendAssetUrls();

        self::assertMatchesRegularExpression(
            '#^/_Resources/Static/Packages/CodeQ\.AsanaFeedback/Styles/Widget\.css\?bust=[a-f0-9]{40}$#',
            $urls['stylesheetUrl']
        );
        self::assertMatchesRegularExpression(
            '#^/_Resources/Static/Packages/CodeQ\.AsanaFeedback/Scripts/Widget\.js\?bust=[a-f0-9]{40}$#',
            $urls['scriptUrl']
        );
    }
}
