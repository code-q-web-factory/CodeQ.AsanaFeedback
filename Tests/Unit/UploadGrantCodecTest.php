<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\RemoteService\UploadGrantCodec;
use PHPUnit\Framework\TestCase;

class UploadGrantCodecTest extends TestCase
{
    public function testDerivesAnOpaqueStableNamespaceFromTheProjectGid(): void
    {
        $codec = new UploadGrantCodec(str_repeat('a', 64));

        $namespace = $codec->deriveSiteId('1216274953146548');

        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $namespace);
        self::assertStringNotContainsString('1216274953146548', $namespace);
        self::assertSame($namespace, $codec->deriveSiteId('1216274953146548'));
        self::assertNotSame($namespace, $codec->deriveSiteId('9876543210123456'));
        self::assertNotSame($namespace, (new UploadGrantCodec(str_repeat('b', 64)))->deriveSiteId('1216274953146548'));
    }

    public function testGrantIsOpaqueAndCanOnlyBeDecodedWithTheSigningSecret(): void
    {
        $codec = new UploadGrantCodec(str_repeat('a', 64));
        $claims = [
            'expiresAt' => 1_800_000_600,
            'siteId' => 'ilf-website',
            'submissionId' => '70ba5883-9047-4e4f-8c47-043141190832',
            'allowedOrigins' => ['https://www.ilf.com'],
            'task' => ['projectGid' => '1216274953146548'],
        ];

        $token = $codec->encodeGrant($claims);

        self::assertStringNotContainsString('1216274953146548', $token);
        self::assertSame($claims, $codec->decodeGrant($token, 1_800_000_000));

        $this->expectException(\InvalidArgumentException::class);
        (new UploadGrantCodec(str_repeat('b', 64)))->decodeGrant($token, 1_800_000_000);
    }

    public function testCorsPolicyAllowsOnlyTheExplicitSignedOrigin(): void
    {
        $codec = new UploadGrantCodec(str_repeat('a', 64));
        $token = $codec->encodeCorsPolicy([
            'expiresAt' => 1_800_000_600,
            'siteId' => 'ilf-website',
            'allowedOrigins' => ['https://www.ilf.com', 'https://ilfwebsite.ddev.site'],
        ]);

        $policy = $codec->decodeCorsPolicy($token, 1_800_000_000);

        self::assertTrue($codec->isOriginAllowed('https://www.ilf.com', $policy['allowedOrigins']));
        self::assertTrue($codec->isOriginAllowed('https://www.ilf.com', ['https://www.ilf.com:443']));
        self::assertTrue($codec->isOriginAllowed('http://localhost', ['http://localhost:80']));
        self::assertFalse($codec->isOriginAllowed('https://attacker.example', $policy['allowedOrigins']));
        self::assertFalse($codec->isOriginAllowed('https://user@www.ilf.com', $policy['allowedOrigins']));
        self::assertFalse($codec->isOriginAllowed('https://www.ilf.com/path', $policy['allowedOrigins']));
        self::assertFalse($codec->isOriginAllowed('null', $policy['allowedOrigins']));
        self::assertFalse($codec->isOriginAllowed('', $policy['allowedOrigins']));
    }
}
