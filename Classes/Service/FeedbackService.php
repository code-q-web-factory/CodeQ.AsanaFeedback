<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use CodeQ\AsanaFeedback\Exception\AsanaApiException;
use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use CodeQ\AsanaFeedback\Exception\ValidationException;
use Neos\Flow\Annotations as Flow;
use Neos\Utility\Files;
use Psr\Http\Message\UploadedFileInterface;
use Psr\Log\LoggerInterface;

/**
 * Validates a feedback submission and turns it into exactly one Asana task
 * with the annotated screenshot (and optionally a screencast) attached.
 *
 * @Flow\Scope("singleton")
 */
class FeedbackService
{
    protected const ALLOWED_SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg'];
    protected const ALLOWED_VIDEO_MIME_TYPES = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];

    /**
     * Whitelisted technical context keys with the labels used in the task
     * notes; everything else sent by the browser is discarded.
     */
    protected const TECHNICAL_CONTEXT_LABELS = [
        'browser' => 'Browser',
        'operatingSystem' => 'Betriebssystem',
        'viewport' => 'Viewport',
        'screen' => 'Bildschirm',
        'devicePixelRatio' => 'Device Pixel Ratio',
        'language' => 'Sprache',
        'userAgent' => 'User-Agent',
    ];

    /**
     * @Flow\Inject
     * @var AsanaClient
     */
    protected $asanaClient;

    /**
     * @Flow\Inject
     * @var UserContextService
     */
    protected $userContextService;

    /**
     * @Flow\Inject(name="Neos.Flow:SystemLogger")
     * @var LoggerInterface
     */
    protected $logger;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback")
     * @var array
     */
    protected $settings;

    /**
     * Creates the Asana task for one feedback submission.
     *
     * @param array $submission ['description' => string, 'authorName' => ?string, 'assigneeKey' => ?string, 'pageUrl' => string, 'technicalContext' => array]
     * @return array{success: bool, taskUrl: ?string, warnings: array<string>}
     * @throws ValidationException|ConfigurationException|AsanaApiException
     */
    public function submit(array $submission, ?UploadedFileInterface $screenshot, ?UploadedFileInterface $video = null): array
    {
        $userContext = $this->userContextService->getCurrentUserContext();
        $limits = $this->settings['limits'] ?? [];

        $description = trim((string)($submission['description'] ?? ''));
        if ($description === '') {
            throw new ValidationException('The description must not be empty.', 1752130010);
        }
        if (mb_strlen($description) > (int)($limits['descriptionCharacters'] ?? 10000)) {
            throw new ValidationException('The description exceeds the allowed length.', 1752130011);
        }

        $pageUrl = trim((string)($submission['pageUrl'] ?? ''));
        $urlScheme = (string)parse_url($pageUrl, PHP_URL_SCHEME);
        if ($pageUrl === '' || mb_strlen($pageUrl) > 2000 || !in_array($urlScheme, ['http', 'https'], true)) {
            throw new ValidationException('The page URL is missing or invalid.', 1752130012);
        }

        // the server side identity always wins over anything sent by the browser
        if ($userContext['authenticated']) {
            $authorName = $userContext['authorName'] ?? $userContext['accountIdentifier'];
        } else {
            $authorName = $this->sanitizeSingleLine((string)($submission['authorName'] ?? ''), 200);
            if ($authorName === '') {
                $authorName = 'Anonym';
            }
        }

        $assigneeGid = $this->resolveAssigneeGid($submission['assigneeKey'] ?? null, $userContext['isTeamMember']);

        $title = $this->sanitizeSingleLine((string)($submission['title'] ?? ''), 200);

        if ($screenshot === null || $screenshot->getError() !== UPLOAD_ERR_OK) {
            throw new ValidationException('The screenshot is missing or the upload failed.', 1752130013);
        }
        $screenshotFile = $this->moveUploadToTemporaryFile(
            $screenshot,
            (int)($limits['screenshotBytes'] ?? 10485760),
            self::ALLOWED_SCREENSHOT_MIME_TYPES
        );

        $videoFile = null;
        if ($video !== null && $video->getError() === UPLOAD_ERR_OK) {
            $videoFile = $this->moveUploadToTemporaryFile(
                $video,
                (int)($limits['videoBytes'] ?? 100000000),
                self::ALLOWED_VIDEO_MIME_TYPES
            );
        }

        try {
            return $this->createAsanaTask($title, $description, $authorName, $pageUrl, $assigneeGid, $submission['technicalContext'] ?? [], $screenshotFile, $videoFile);
        } finally {
            // temporary files must disappear regardless of transfer success
            foreach ([$screenshotFile, $videoFile] as $temporaryFile) {
                if ($temporaryFile !== null && file_exists($temporaryFile['path'])) {
                    @unlink($temporaryFile['path']);
                }
            }
        }
    }

    /**
     * @param array{path: string, mimeType: string, extension: string} $screenshotFile
     * @param array{path: string, mimeType: string, extension: string}|null $videoFile
     * @return array{success: bool, taskUrl: ?string, warnings: array<string>}
     */
    protected function createAsanaTask(
        string $title,
        string $description,
        string $authorName,
        string $pageUrl,
        ?string $assigneeGid,
        array $technicalContext,
        array $screenshotFile,
        ?array $videoFile
    ): array {
        $projectGid = (string)($this->settings['asanaProjectGid'] ?? '');
        if ($projectGid === '') {
            throw new ConfigurationException('No Asana project GID is configured.', 1752130014);
        }

        $sectionGid = (string)($this->settings['asanaSectionGid'] ?? '');
        if ($sectionGid === '') {
            $sectionGid = (string)$this->asanaClient->resolveSectionGidByName(
                $projectGid,
                array_map('strval', $this->settings['asanaSectionNames'] ?? [])
            );
            if ($sectionGid === '') {
                throw new ConfigurationException(
                    'None of the configured section names exists in the Asana project.',
                    1752130015
                );
            }
        }

        $task = $this->asanaClient->createTask(
            $projectGid,
            $sectionGid,
            $this->buildTaskName($title, $description),
            $this->buildTaskNotes($description, $authorName, $pageUrl, $technicalContext),
            $assigneeGid
        );

        $this->logger->info(
            sprintf('CodeQ.AsanaFeedback: Created Asana task %s (%s) for feedback by "%s" on %s', $task['gid'], $task['permalinkUrl'], $authorName, $pageUrl)
        );

        // the screenshot is a mandatory part of the report: without it the
        // submission counts as failed even though the task already exists
        try {
            $this->asanaClient->uploadAttachment($task['gid'], $screenshotFile['path'], 'screenshot.' . $screenshotFile['extension'], $screenshotFile['mimeType']);
        } catch (AsanaApiException $exception) {
            $this->logger->error(
                sprintf('CodeQ.AsanaFeedback: Task %s was created but the screenshot upload failed: %s', $task['gid'], $exception->getMessage())
            );
            throw new AsanaApiException(
                'The task was created but the screenshot could not be attached.',
                1752130016,
                $exception
            );
        }

        $warnings = [];
        if ($videoFile !== null) {
            try {
                $this->asanaClient->uploadAttachment($task['gid'], $videoFile['path'], 'screencast.' . $videoFile['extension'], $videoFile['mimeType']);
            } catch (AsanaApiException $exception) {
                // a failed optional screencast should not invalidate the report
                $this->logger->error(
                    sprintf('CodeQ.AsanaFeedback: Task %s was created but the screencast upload failed: %s', $task['gid'], $exception->getMessage())
                );
                $warnings[] = 'videoUploadFailed';
            }
        }

        return [
            'success' => true,
            'taskUrl' => $task['permalinkUrl'] !== '' ? $task['permalinkUrl'] : null,
            'warnings' => $warnings,
        ];
    }

    /**
     * Validates the submitted assignee key against the configured allowlist
     * and maps it to the Asana user GID. Team members may pick every entry,
     * everyone else only those flagged with "visibleToClient".
     */
    protected function resolveAssigneeGid(?string $assigneeKey, bool $isTeamMember): ?string
    {
        $assigneeKey = trim((string)$assigneeKey);
        if ($assigneeKey === '') {
            return null;
        }

        $assignees = $this->settings['assignees'] ?? [];
        if (!isset($assignees[$assigneeKey]['asanaUserGid'])) {
            throw new ValidationException('The selected assignee is not allowed.', 1752130017);
        }
        if (!$isTeamMember && ($assignees[$assigneeKey]['visibleToClient'] ?? false) !== true) {
            throw new ValidationException('The selected assignee is not allowed.', 1752130021);
        }

        return (string)$assignees[$assigneeKey]['asanaUserGid'];
    }

    /**
     * Streams an upload to a temporary file with a server generated name and
     * verifies size and real MIME type (as detected from the file content).
     *
     * @return array{path: string, mimeType: string, extension: string}
     */
    protected function moveUploadToTemporaryFile(UploadedFileInterface $upload, int $maximumBytes, array $allowedMimeTypes): array
    {
        if ($upload->getSize() !== null && $upload->getSize() > $maximumBytes) {
            throw new ValidationException('The uploaded file exceeds the allowed size.', 1752130018);
        }

        // client supplied file names are never used for the temporary file
        $temporaryPath = Files::concatenatePaths([sys_get_temp_dir(), 'codeq-asana-feedback-' . bin2hex(random_bytes(16))]);
        $upload->moveTo($temporaryPath);

        if (filesize($temporaryPath) > $maximumBytes) {
            @unlink($temporaryPath);
            throw new ValidationException('The uploaded file exceeds the allowed size.', 1752130019);
        }

        $fileInfo = new \finfo(FILEINFO_MIME_TYPE);
        $detectedMimeType = (string)$fileInfo->file($temporaryPath);
        if (!in_array($detectedMimeType, $allowedMimeTypes, true)) {
            @unlink($temporaryPath);
            throw new ValidationException(sprintf('The file type "%s" is not allowed.', $detectedMimeType), 1752130020);
        }

        $extensionMap = [
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'video/webm' => 'webm',
            'video/mp4' => 'mp4',
            'video/quicktime' => 'mov',
            'video/x-matroska' => 'mkv',
        ];

        return [
            'path' => $temporaryPath,
            'mimeType' => $detectedMimeType,
            'extension' => $extensionMap[$detectedMimeType] ?? 'bin',
        ];
    }

    /**
     * A title given by a team member becomes the task name as-is; without
     * one the task is named after the description with a marker prefix.
     */
    protected function buildTaskName(string $title, string $description): string
    {
        if ($title !== '') {
            return $title;
        }

        return 'Website-Feedback: ' . $this->sanitizeSingleLine(mb_substr($description, 0, 80), 100)
            . (mb_strlen($description) > 80 ? '…' : '');
    }

    protected function buildTaskNotes(string $description, string $authorName, string $pageUrl, array $technicalContext): string
    {
        $createdAt = (new \DateTimeImmutable())->format('d.m.Y H:i:s T');

        $notes = "Autor: {$authorName}\n";
        $notes .= "URL: {$pageUrl}\n";
        $notes .= "Erstellt am: {$createdAt}\n";
        $notes .= "\nBeschreibung:\n" . $this->sanitizeMultiLine($description) . "\n";

        $contextLines = [];
        foreach (self::TECHNICAL_CONTEXT_LABELS as $key => $label) {
            if (!empty($technicalContext[$key])) {
                $contextLines[] = sprintf('%s: %s', $label, $this->sanitizeSingleLine((string)$technicalContext[$key], 500));
            }
        }
        if ($contextLines !== []) {
            $notes .= "\nTechnischer Kontext:\n" . implode("\n", $contextLines) . "\n";
        }

        $notes .= "\nErstellt über das CodeQ.AsanaFeedback Widget.";

        return $notes;
    }

    /**
     * Removes control characters and line breaks so user text cannot forge
     * additional lines in the task notes or log entries.
     */
    protected function sanitizeSingleLine(string $text, int $maximumLength): string
    {
        $text = (string)preg_replace('/[\x00-\x1F\x7F]/u', ' ', $text);

        return trim(mb_substr($text, 0, $maximumLength));
    }

    protected function sanitizeMultiLine(string $text): string
    {
        // keep line breaks but remove all other control characters
        return trim((string)preg_replace('/[^\P{C}\n\t]/u', ' ', $text));
    }
}
