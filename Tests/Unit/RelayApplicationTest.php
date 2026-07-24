<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Tests\Unit;

use CodeQ\AsanaFeedback\RemoteService\AsanaClientInterface;
use CodeQ\AsanaFeedback\RemoteService\AsanaClientException;
use CodeQ\AsanaFeedback\RemoteService\CurlAsanaClient;
use CodeQ\AsanaFeedback\RemoteService\RelayApplication;
use CodeQ\AsanaFeedback\RemoteService\RelayConfigurationException;
use CodeQ\AsanaFeedback\RemoteService\RelayRequest;
use CodeQ\AsanaFeedback\RemoteService\UploadGrantCodec;
use PHPUnit\Framework\TestCase;

class RelayApplicationTest extends TestCase
{
    private string $stateDirectory;
    private UploadGrantCodec $codec;

    protected function setUp(): void
    {
        $this->stateDirectory = sys_get_temp_dir() . '/cqaf-relay-test-' . bin2hex(random_bytes(8));
        mkdir($this->stateDirectory, 0700, true);
        $this->codec = new UploadGrantCodec(str_repeat('s', 64));
    }

    protected function tearDown(): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($this->stateDirectory, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($iterator as $entry) {
            $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
        }
        rmdir($this->stateDirectory);
    }

    public function testPreflightAllowsOnlyTheOriginSignedByTheWebsite(): void
    {
        $application = $this->createApplication();
        $corsToken = $this->codec->encodeCorsPolicy([
            'expiresAt' => 1_800_000_600,
            'siteId' => 'ilf-website',
            'allowedOrigins' => ['https://www.ilf.com'],
        ]);

        $allowed = $application->handle(new RelayRequest(
            'OPTIONS',
            'https://www.ilf.com',
            ['access-control-request-method' => 'POST', 'access-control-request-headers' => 'content-type,x-idempotency-key'],
            ['action' => 'upload', 'site' => 'ilf-website', 'cors' => $corsToken],
            [],
            [],
            '203.0.113.10',
            null
        ));
        self::assertSame(204, $allowed->statusCode);
        self::assertSame('https://www.ilf.com', $allowed->headers['Access-Control-Allow-Origin']);
        self::assertSame('Origin', $allowed->headers['Vary']);
        self::assertSame('POST, OPTIONS', $allowed->headers['Access-Control-Allow-Methods']);
        self::assertArrayNotHasKey('Access-Control-Allow-Credentials', $allowed->headers);

        $denied = $application->handle(new RelayRequest(
            'OPTIONS',
            'https://attacker.example',
            ['access-control-request-method' => 'POST', 'access-control-request-headers' => 'content-type,x-idempotency-key'],
            ['action' => 'upload', 'site' => 'ilf-website', 'cors' => $corsToken],
            [],
            [],
            '203.0.113.10',
            null
        ));
        self::assertSame(403, $denied->statusCode);
        self::assertArrayNotHasKey('Access-Control-Allow-Origin', $denied->headers);

        foreach (['', 'null'] as $invalidOrigin) {
            $invalid = $application->handle(new RelayRequest(
                'OPTIONS',
                $invalidOrigin,
                ['access-control-request-method' => 'POST'],
                ['action' => 'upload', 'site' => 'ilf-website', 'cors' => $corsToken],
                [],
                [],
                '203.0.113.10',
                null
            ));
            self::assertSame(403, $invalid->statusCode);
            self::assertArrayNotHasKey('Access-Control-Allow-Origin', $invalid->headers);
        }
    }

    public function testAWebsiteConfiguredOnlyInNeosCanUseTheSharedRelay(): void
    {
        $application = $this->createApplication($asanaClient);
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $request = $this->createUploadRequest(
            [
                'screenshot' => [
                    'error' => UPLOAD_ERR_OK,
                    'tmp_name' => $screenshotPath,
                    'size' => filesize($screenshotPath),
                ],
            ],
            'customer-site-submission',
            'The new site works.',
            'customer-website',
            'https://www.customer.example',
            '9876543210123456'
        );

        $response = $application->handle($request);

        self::assertSame(200, $response->statusCode);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame('9876543210123456', $asanaClient->lastCreatedTask['projectGid']);
    }

    public function testReportsAMissingAsanaTokenToTheBrowser(): void
    {
        $application = new RelayApplication(
            $this->baseConfig(),
            new CurlAsanaClient(''),
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path)
        );
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $request = $this->createUploadRequest([
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $screenshotPath,
                'size' => filesize($screenshotPath),
            ],
        ]);

        $response = $application->handle($request);

        self::assertSame(500, $response->statusCode);
        self::assertSame('asanaConfiguration', $response->payload['errorCode']);
        self::assertSame(
            'The feedback relay has no Asana access token configured.',
            $response->payload['message']
        );
        self::assertSame('https://www.ilf.com', $response->headers['Access-Control-Allow-Origin']);
    }

    public function testReportsAMissingRelayGrantSecretClearly(): void
    {
        $this->expectException(RelayConfigurationException::class);
        $this->expectExceptionMessage('The feedback relay grant secret is missing or shorter than 32 characters.');

        new RelayApplication(
            ['stateDirectory' => $this->stateDirectory],
            new CurlAsanaClient('unused')
        );
    }

    public function testReportsAMissingStateDirectoryAfterCorsPreflight(): void
    {
        $application = $this->createApplication($asanaClient, null, ['stateDirectory' => '']);
        $corsToken = $this->codec->encodeCorsPolicy([
            'expiresAt' => 1_800_000_600,
            'siteId' => 'ilf-website',
            'allowedOrigins' => ['https://www.ilf.com'],
        ]);
        $preflight = $application->handle(new RelayRequest(
            'OPTIONS',
            'https://www.ilf.com',
            [
                'access-control-request-method' => 'POST',
                'access-control-request-headers' => 'content-type,x-idempotency-key',
            ],
            ['action' => 'upload', 'site' => 'ilf-website', 'cors' => $corsToken],
            [],
            [],
            '203.0.113.10',
            null
        ));

        $upload = $application->handle($this->createUploadRequest([]));

        self::assertSame(204, $preflight->statusCode);
        self::assertSame(500, $upload->statusCode);
        self::assertSame('configuration', $upload->payload['errorCode']);
        self::assertSame(
            'The feedback relay state directory is not configured.',
            $upload->payload['message']
        );
        self::assertSame('https://www.ilf.com', $upload->headers['Access-Control-Allow-Origin']);
    }

    public function testReportsASpecificAsanaAttachmentErrorToTheBrowser(): void
    {
        $asanaClient = new class implements AsanaClientInterface {
            public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
            {
                return $sectionGid;
            }

            public function createTask(array $task, string $sectionGid): array
            {
                return ['taskGid' => '1', 'taskUrl' => 'https://app.asana.com/0/1/1'];
            }

            public function uploadAttachment(string $taskGid, array $file, string $fileName): void
            {
                throw new AsanaClientException(
                    502,
                    'asanaPermission',
                    'The feedback relay is not allowed to upload attachments to this Asana task.',
                    'Asana returned 403 for an attachment request.'
                );
            }
        };
        $application = new RelayApplication(
            $this->baseConfig(),
            $asanaClient,
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path)
        );
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';

        $response = $application->handle($this->createUploadRequest([
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $screenshotPath,
                'size' => filesize($screenshotPath),
            ],
        ]));

        self::assertSame(502, $response->statusCode);
        self::assertSame('asanaPermission', $response->payload['errorCode']);
        self::assertSame(
            'The feedback relay is not allowed to upload attachments to this Asana task.',
            $response->payload['message']
        );
    }

    public function testMapsAnAsanaPermissionFailureToASafeUserMessage(): void
    {
        $exception = AsanaClientException::fromHttpResponse(
            403,
            'Asana request "POST /tasks" returned 403: project details'
        );

        self::assertSame(502, $exception->statusCode);
        self::assertSame('asanaPermission', $exception->errorCode);
        self::assertSame(
            'The feedback relay does not have permission for the requested Asana operation.',
            $exception->publicMessage
        );
        self::assertStringContainsString('project details', $exception->getMessage());
        self::assertStringNotContainsString('project details', $exception->publicMessage);
    }

    public function testRejectsAnOversizedFileBeforeCreatingAnAsanaTask(): void
    {
        $application = $this->createApplication($asanaClient);
        $request = $this->createUploadRequest([
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg',
                'size' => 95_000_001,
            ],
        ]);

        $response = $application->handle($request);

        self::assertSame(413, $response->statusCode);
        self::assertSame('fileTooLarge', $response->payload['errorCode']);
        self::assertStringContainsString('95 MB', $response->payload['message']);
        self::assertSame(0, $asanaClient->createTaskCalls);
    }

    public function testRejectsAnOversizedRequestBeforeReadingMultipartFields(): void
    {
        $application = $this->createApplication($asanaClient);
        $request = $this->createUploadRequest([]);
        $request->fields = [];
        $request->contentLength = 191_000_001;

        $response = $application->handle($request);

        self::assertSame(413, $response->statusCode);
        self::assertSame('fileTooLarge', $response->payload['errorCode']);
        self::assertSame(0, $asanaClient->createTaskCalls);
    }

    public function testRejectsAnOversizedUploadGrantBeforeDecodingIt(): void
    {
        $application = $this->createApplication($asanaClient);
        $request = $this->createUploadRequest([]);
        $grantPath = (string)$request->files['uploadGrant']['tmp_name'];
        file_put_contents($grantPath, str_repeat('a', 512_001));
        $request->files['uploadGrant']['size'] = 512_001;

        $response = $application->handle($request);

        self::assertSame(401, $response->statusCode);
        self::assertSame('unauthorized', $response->payload['errorCode']);
        self::assertSame(0, $asanaClient->createTaskCalls);
    }

    public function testRejectsAnInvalidMimeTypeBeforeCreatingAnAsanaTask(): void
    {
        $application = $this->createApplication($asanaClient, static fn(string $path): string => 'text/plain');
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $request = $this->createUploadRequest([
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $screenshotPath,
                'size' => filesize($screenshotPath),
            ],
        ]);

        $response = $application->handle($request);

        self::assertSame(400, $response->statusCode);
        self::assertSame('invalidFileType', $response->payload['errorCode']);
        self::assertSame(0, $asanaClient->createTaskCalls);
    }

    public function testRepeatedIdempotencyKeyReturnsTheSameResultWithoutCreatingAnotherTask(): void
    {
        $application = $this->createApplication($asanaClient);
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $files = [
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $screenshotPath,
                'size' => filesize($screenshotPath),
            ],
        ];

        $first = $application->handle($this->createUploadRequest($files, '70ba5883-9047-4e4f-8c47-043141190832', 'Created at: first'));
        // A real UI retry obtains a fresh grant and therefore fresh task
        // notes, but carries the same stable signed task fingerprint.
        $second = $application->handle($this->createUploadRequest($files, '70ba5883-9047-4e4f-8c47-043141190832', 'Created at: retry'));

        self::assertSame(200, $first->statusCode);
        self::assertSame($first->payload, $second->payload);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(1, $asanaClient->uploadAttachmentCalls);
    }

    public function testFeedbackWithVideoUploadsBothValidatedAttachments(): void
    {
        $application = $this->createApplication(
            $asanaClient,
            static fn(string $path): string => str_ends_with($path, 'felix.jpg') ? 'video/webm' : 'image/jpeg'
        );
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $videoPath = __DIR__ . '/../../Resources/Public/Images/Team/felix.jpg';
        $request = $this->createUploadRequest([
            'screenshot' => ['error' => UPLOAD_ERR_OK, 'tmp_name' => $screenshotPath, 'size' => filesize($screenshotPath)],
            'video' => ['error' => UPLOAD_ERR_OK, 'tmp_name' => $videoPath, 'size' => filesize($videoPath)],
        ]);

        $response = $application->handle($request);

        self::assertSame(200, $response->statusCode);
        self::assertSame([], $response->payload['warnings']);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(2, $asanaClient->uploadAttachmentCalls);
    }

    public function testVideoOnlyFeedbackCreatesOneTaskWithOneAttachment(): void
    {
        $application = $this->createApplication(
            $asanaClient,
            static fn(string $path): string => 'video/webm'
        );
        $videoPath = __DIR__ . '/../../Resources/Public/Images/Team/felix.jpg';
        $request = $this->createUploadRequest([
            'video' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $videoPath,
                'size' => filesize($videoPath),
            ],
        ]);

        $response = $application->handle($request);

        self::assertSame(200, $response->statusCode);
        self::assertSame([], $response->payload['warnings']);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(1, $asanaClient->uploadAttachmentCalls);
    }

    public function testFeedbackWithoutMediaIsRejectedBeforeTaskCreation(): void
    {
        $application = $this->createApplication($asanaClient);

        $response = $application->handle($this->createUploadRequest([]));

        self::assertSame(400, $response->statusCode);
        self::assertSame('validation', $response->payload['errorCode']);
        self::assertSame(0, $asanaClient->createTaskCalls);
        self::assertSame(0, $asanaClient->uploadAttachmentCalls);
    }

    public function testFailedOptionalVideoCanBeRetriedWithoutCreatingAnotherTask(): void
    {
        $asanaClient = new class implements AsanaClientInterface {
            public int $createTaskCalls = 0;
            public int $uploadAttachmentCalls = 0;

            public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
            {
                return $sectionGid;
            }

            public function createTask(array $task, string $sectionGid): array
            {
                $this->createTaskCalls++;
                return ['taskGid' => '1', 'taskUrl' => 'https://app.asana.com/0/1/1'];
            }

            public function uploadAttachment(string $taskGid, array $file, string $fileName): void
            {
                $this->uploadAttachmentCalls++;
                if ($this->uploadAttachmentCalls === 2) {
                    throw new \RuntimeException('Temporary video failure');
                }
            }
        };
        $application = new RelayApplication(
            $this->baseConfig(),
            $asanaClient,
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path),
            static fn(string $path): string => str_ends_with($path, 'felix.jpg') ? 'video/webm' : 'image/jpeg'
        );
        $files = [
            'screenshot' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg',
                'size' => filesize(__DIR__ . '/../../Resources/Public/Images/Team/roland.jpg'),
            ],
            'video' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => __DIR__ . '/../../Resources/Public/Images/Team/felix.jpg',
                'size' => filesize(__DIR__ . '/../../Resources/Public/Images/Team/felix.jpg'),
            ],
        ];

        $first = $application->handle($this->createUploadRequest($files));
        $second = $application->handle($this->createUploadRequest($files));
        $third = $application->handle($this->createUploadRequest($files));

        self::assertSame(['videoUploadFailed'], $first->payload['warnings']);
        self::assertSame([], $second->payload['warnings']);
        self::assertSame($second->payload, $third->payload);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(3, $asanaClient->uploadAttachmentCalls);
    }

    public function testFailedVideoOnlyAttachmentIsRetryableWithoutCreatingAnotherTask(): void
    {
        $asanaClient = new class implements AsanaClientInterface {
            public int $createTaskCalls = 0;
            public int $uploadAttachmentCalls = 0;

            public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
            {
                return $sectionGid;
            }

            public function createTask(array $task, string $sectionGid): array
            {
                $this->createTaskCalls++;
                return ['taskGid' => '1', 'taskUrl' => 'https://app.asana.com/0/1/1'];
            }

            public function uploadAttachment(string $taskGid, array $file, string $fileName): void
            {
                $this->uploadAttachmentCalls++;
                if ($this->uploadAttachmentCalls === 1) {
                    throw new \RuntimeException('Temporary video failure');
                }
            }
        };
        $application = new RelayApplication(
            $this->baseConfig(),
            $asanaClient,
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path),
            static fn(string $path): string => 'video/webm'
        );
        $videoPath = __DIR__ . '/../../Resources/Public/Images/Team/felix.jpg';
        $files = [
            'video' => [
                'error' => UPLOAD_ERR_OK,
                'tmp_name' => $videoPath,
                'size' => filesize($videoPath),
            ],
        ];

        $first = $application->handle($this->createUploadRequest($files));
        $second = $application->handle($this->createUploadRequest($files));
        $third = $application->handle($this->createUploadRequest($files));

        self::assertSame(502, $first->statusCode);
        self::assertSame('attachmentFailed', $first->payload['errorCode']);
        self::assertSame(200, $second->statusCode);
        self::assertSame([], $second->payload['warnings']);
        self::assertSame($second->payload, $third->payload);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(2, $asanaClient->uploadAttachmentCalls);
    }

    public function testRetryCannotChangeTheExpectedAttachmentTypes(): void
    {
        $asanaClient = new class implements AsanaClientInterface {
            public int $createTaskCalls = 0;
            public int $uploadAttachmentCalls = 0;

            public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
            {
                return $sectionGid;
            }

            public function createTask(array $task, string $sectionGid): array
            {
                $this->createTaskCalls++;
                return ['taskGid' => '1', 'taskUrl' => 'https://app.asana.com/0/1/1'];
            }

            public function uploadAttachment(string $taskGid, array $file, string $fileName): void
            {
                $this->uploadAttachmentCalls++;
                if ($this->uploadAttachmentCalls === 1) {
                    throw new \RuntimeException('Temporary video failure');
                }
            }
        };
        $application = new RelayApplication(
            $this->baseConfig(),
            $asanaClient,
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path),
            static fn(string $path): string => str_ends_with($path, 'felix.jpg') ? 'video/webm' : 'image/jpeg'
        );
        $videoPath = __DIR__ . '/../../Resources/Public/Images/Team/felix.jpg';
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $videoFiles = [
            'video' => ['error' => UPLOAD_ERR_OK, 'tmp_name' => $videoPath, 'size' => filesize($videoPath)],
        ];
        $screenshotFiles = [
            'screenshot' => ['error' => UPLOAD_ERR_OK, 'tmp_name' => $screenshotPath, 'size' => filesize($screenshotPath)],
        ];

        $failedVideo = $application->handle($this->createUploadRequest($videoFiles));
        $changedRetry = $application->handle($this->createUploadRequest($screenshotFiles));
        $matchingRetry = $application->handle($this->createUploadRequest($videoFiles));

        self::assertSame(502, $failedVideo->statusCode);
        self::assertSame(409, $changedRetry->statusCode);
        self::assertSame('idempotencyConflict', $changedRetry->payload['errorCode']);
        self::assertSame(200, $matchingRetry->statusCode);
        self::assertSame(1, $asanaClient->createTaskCalls);
        self::assertSame(2, $asanaClient->uploadAttachmentCalls);
    }

    public function testDirectUploadsUseTheRelayRateLimitPerSiteAndClientIp(): void
    {
        $application = $this->createApplication($asanaClient, null, [
            'rateLimit' => ['maxPerMinute' => 1, 'maxPerHour' => 10],
        ]);
        $screenshotPath = __DIR__ . '/../../Resources/Public/Images/Team/roland.jpg';
        $files = [
            'screenshot' => ['error' => UPLOAD_ERR_OK, 'tmp_name' => $screenshotPath, 'size' => filesize($screenshotPath)],
        ];

        $first = $application->handle($this->createUploadRequest($files, 'submission-first'));
        $second = $application->handle($this->createUploadRequest($files, 'submission-second'));

        self::assertSame(200, $first->statusCode);
        self::assertSame(429, $second->statusCode);
        self::assertSame('rateLimit', $second->payload['errorCode']);
        self::assertSame(1, $asanaClient->createTaskCalls);
    }

    private function createUploadRequest(
        array $files,
        string $submissionId = '70ba5883-9047-4e4f-8c47-043141190832',
        string $taskNotes = 'The navigation is broken.',
        string $siteId = 'ilf-website',
        string $origin = 'https://www.ilf.com',
        string $projectGid = '1216274953146548'
    ): RelayRequest
    {
        $commonClaims = [
            'expiresAt' => 1_800_000_600,
            'siteId' => $siteId,
            'allowedOrigins' => [$origin],
        ];
        $uploadToken = $this->codec->encodeGrant($commonClaims + [
            'submissionId' => $submissionId,
            'taskFingerprint' => hash('sha256', 'stable-feedback-task'),
            'includeTaskUrl' => false,
            'limits' => ['screenshotBytes' => 95_000_000, 'videoBytes' => 95_000_000],
            'task' => [
                'projectGid' => $projectGid,
                'sectionGid' => '1216274953146549',
                'sectionNames' => ['Todo'],
                'name' => 'Website-Feedback: Broken navigation',
                'notes' => $taskNotes,
                'assigneeGid' => '422230010221',
            ],
        ]);
        $grantPath = $this->stateDirectory . '/grant-' . hash('sha256', $uploadToken) . '.cqaf';
        file_put_contents($grantPath, $uploadToken);
        $files['uploadGrant'] = [
            'error' => UPLOAD_ERR_OK,
            'tmp_name' => $grantPath,
            'size' => filesize($grantPath),
        ];

        return new RelayRequest(
            'POST',
            $origin,
            [
                'x-idempotency-key' => $submissionId,
            ],
            [
                'action' => 'upload',
                'site' => $siteId,
                'cors' => $this->codec->encodeCorsPolicy($commonClaims),
            ],
            [],
            $files,
            '203.0.113.10',
            null
        );
    }

    private function createApplication(
        ?object &$asanaClient = null,
        ?callable $detectMimeType = null,
        array $config = []
    ): RelayApplication
    {
        $asanaClient = new class implements AsanaClientInterface {
            public int $createTaskCalls = 0;
            public int $uploadAttachmentCalls = 0;
            public array $lastCreatedTask = [];

            public function resolveSection(string $projectGid, string $sectionGid, array $sectionNames): string
            {
                return $sectionGid;
            }

            public function createTask(array $task, string $sectionGid): array
            {
                $this->createTaskCalls++;
                $this->lastCreatedTask = $task;
                return ['taskGid' => '1', 'taskUrl' => 'https://app.asana.com/0/1/1'];
            }

            public function uploadAttachment(string $taskGid, array $file, string $fileName): void
            {
                $this->uploadAttachmentCalls++;
            }
        };

        return new RelayApplication(
            $config + $this->baseConfig(),
            $asanaClient,
            static fn(): int => 1_800_000_000,
            static fn(string $path): bool => is_file($path),
            $detectMimeType
        );
    }

    private function baseConfig(): array
    {
        return [
            'grantSecret' => str_repeat('s', 64),
            'stateDirectory' => $this->stateDirectory,
        ];
    }
}
