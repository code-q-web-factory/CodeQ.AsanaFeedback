<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\RemoteService\UploadGrantCodec;
use CodeQ\AsanaFeedback\Service\UploadGrantService;
use PHPUnit\Framework\TestCase;

class UploadGrantServiceTest extends TestCase
{
    public function testCreatesAnOpaqueDirectUploadGrantFromProjectConfiguration(): void
    {
        $service = new UploadGrantService();
        $settings = [
            'feedbackService' => [
                'endpoint' => 'https://feedback.example/',
                'grantSecret' => str_repeat('s', 64),
            ],
            'asanaProjectGid' => '1216274953146548',
            'limits' => [
                'screenshotBytes' => 10_000_000,
                'fileBytes' => 95_000_000,
            ],
        ];
        $property = new \ReflectionProperty(UploadGrantService::class, 'settings');
        $property->setAccessible(true);
        $property->setValue($service, $settings);

        $grant = $service->createGrant([
            'submissionId' => '70ba5883-9047-4e4f-8c47-043141190832',
            'includeTaskUrl' => false,
            'taskFingerprint' => str_repeat('a', 64),
            'task' => [
                'projectGid' => '1216274953146548',
                'name' => 'Website-Feedback: Broken navigation',
            ],
        ], 'https://www.ilf.com', 1_800_000_000);

        self::assertSame('70ba5883-9047-4e4f-8c47-043141190832', $grant['idempotencyKey']);
        self::assertStringNotContainsString('1216274953146548', $grant['uploadUrl']);
        self::assertStringNotContainsString('1216274953146548', $grant['uploadToken']);

        parse_str((string)parse_url($grant['uploadUrl'], PHP_URL_QUERY), $query);
        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $query['site']);
        $codec = new UploadGrantCodec(str_repeat('s', 64));
        $claims = $codec->decodeGrant($grant['uploadToken'], 1_800_000_001);
        $corsPolicy = $codec->decodeCorsPolicy($query['cors'], 1_800_000_001);
        self::assertSame($query['site'], $claims['siteId']);
        self::assertSame(['https://www.ilf.com'], $corsPolicy['allowedOrigins']);
        self::assertSame(1_800_000_600, $claims['expiresAt']);
        self::assertSame(95_000_000, $claims['limits']['videoBytes']);
        self::assertSame('1216274953146548', $claims['task']['projectGid']);
    }

    public function testRejectsAnUnencryptedRelayEndpoint(): void
    {
        $service = new UploadGrantService();
        $property = new \ReflectionProperty(UploadGrantService::class, 'settings');
        $property->setAccessible(true);
        $property->setValue($service, [
            'feedbackService' => [
                'endpoint' => 'http://feedback.example/',
                'grantSecret' => str_repeat('s', 64),
            ],
        ]);

        $this->expectException(\CodeQ\AsanaFeedback\Exception\ConfigurationException::class);
        $service->createGrant([], 'https://www.ilf.com');
    }

    public function testRejectsAnInvalidRequestOrigin(): void
    {
        $service = new UploadGrantService();
        $property = new \ReflectionProperty(UploadGrantService::class, 'settings');
        $property->setAccessible(true);
        $property->setValue($service, [
            'feedbackService' => [
                'endpoint' => 'https://feedback.example/',
                'grantSecret' => str_repeat('s', 64),
            ],
            'asanaProjectGid' => '1216274953146548',
        ]);

        $this->expectException(\CodeQ\AsanaFeedback\Exception\ConfigurationException::class);
        $service->createGrant([], 'https://attacker.example/path');
    }

    public function testRejectsAPreparedProjectThatDoesNotMatchConfiguration(): void
    {
        $service = new UploadGrantService();
        $property = new \ReflectionProperty(UploadGrantService::class, 'settings');
        $property->setAccessible(true);
        $property->setValue($service, [
            'feedbackService' => [
                'endpoint' => 'https://feedback.example/',
                'grantSecret' => str_repeat('s', 64),
            ],
            'asanaProjectGid' => '1216274953146548',
        ]);

        $this->expectException(\InvalidArgumentException::class);
        $service->createGrant([
            'submissionId' => '70ba5883-9047-4e4f-8c47-043141190832',
            'taskFingerprint' => str_repeat('a', 64),
            'task' => ['projectGid' => '9876543210123456'],
        ], 'https://www.ilf.com');
    }
}
