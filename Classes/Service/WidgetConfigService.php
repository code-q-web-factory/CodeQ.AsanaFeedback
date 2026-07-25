<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use Neos\Flow\Annotations as Flow;
use Neos\Flow\I18n\Locale;
use Neos\Flow\I18n\Translator;

/**
 * Builds the user specific bootstrap configuration of the widget. Used by
 * the Fusion integration (website frontend) and the config endpoint (Neos
 * backend toolbar plugin). Contains no secrets: no token, no GIDs of
 * project, section or users.
 *
 * @Flow\Scope("singleton")
 */
class WidgetConfigService
{
    protected const TRANSLATION_KEYS = [
        'buttonLabel', 'panelTitle', 'introText', 'captureScreenshot', 'capturing',
        'annotateTitle', 'toolSelect', 'toolPen', 'toolRect', 'toolArrow', 'toolText',
        'undo', 'redo', 'deleteAnnotation', 'continueButton', 'retakeScreenshot',
        'titleLabel', 'titlePlaceholder',
        'descriptionLabel', 'descriptionPlaceholder', 'authorLabel', 'authorPlaceholder',
        'assigneeLabel', 'assigneeNone', 'submit', 'cancel', 'back', 'sending', 'sendingVideo',
        'successTitle', 'successMessage', 'openTask', 'errorTitle', 'errorGeneric',
        'errorValidation', 'errorDescriptionRequired', 'errorMediaRequired', 'errorRateLimit',
        'errorConfiguration', 'errorAttachment', 'errorScreenshot', 'errorForbidden', 'fileTooLarge',
        'newFeedback', 'close', 'screenshotPreviewAlt', 'editAnnotations',
        'recordScreencast', 'recording', 'stopRecording', 'screencastNotSupported',
        'screencastTooLarge', 'screencastAudioRequired', 'removeScreencast', 'screencastAttached', 'videoUploadFailed',
    ];

    /**
     * @Flow\Inject
     * @var UserContextService
     */
    protected $userContextService;

    /**
     * @Flow\Inject
     * @var Translator
     */
    protected $translator;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback", path="limits")
     * @var array
     */
    protected $limits;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback", path="media")
     * @var array
     */
    protected $media;

    public function buildConfig(string $requestedLanguage, string $prepareUrl): array
    {
        // the widget is available in German and English, everything else falls back to English
        $locale = strtolower(substr($requestedLanguage, 0, 2)) === 'de' ? 'de' : 'en';
        $userContext = $this->userContextService->getCurrentUserContext();

        $labels = [];
        foreach (self::TRANSLATION_KEYS as $key) {
            $labels[$key] = $this->translator->translateById($key, [], null, new Locale($locale), 'Main', 'CodeQ.AsanaFeedback')
                ?? $this->translator->translateById($key, [], null, new Locale('en'), 'Main', 'CodeQ.AsanaFeedback')
                ?? $key;
        }

        return [
            'locale' => $locale,
            'prepareUrl' => $prepareUrl,
            'user' => [
                'authenticated' => $userContext['authenticated'],
                'authorName' => $userContext['authorName'],
                'isTeamMember' => $userContext['isTeamMember'],
            ],
            'assignees' => $this->userContextService->getAssigneesForWidget($userContext['isTeamMember']),
            'limits' => [
                'fileBytes' => min(95000000, max(1, (int)($this->limits['fileBytes'] ?? 95000000))),
                'screenshotBytes' => min(
                    95000000,
                    max(1, (int)($this->limits['fileBytes'] ?? 95000000)),
                    max(1, (int)($this->limits['screenshotBytes'] ?? 95000000))
                ),
                'descriptionCharacters' => (int)($this->limits['descriptionCharacters'] ?? 10000),
            ],
            'media' => [
                'screenshot' => [
                    'mimeTypes' => array_values(array_map('strval', $this->media['screenshot']['mimeTypes'] ?? ['image/jpeg', 'image/png'])),
                    'quality' => (float)($this->media['screenshot']['quality'] ?? 0.8),
                ],
                'video' => [
                    'width' => (int)($this->media['video']['width'] ?? 1280),
                    'height' => (int)($this->media['video']['height'] ?? 720),
                    'idealFrameRate' => (int)($this->media['video']['idealFrameRate'] ?? 20),
                    'maximumFrameRate' => (int)($this->media['video']['maximumFrameRate'] ?? 24),
                    'videoBitsPerSecond' => (int)($this->media['video']['videoBitsPerSecond'] ?? 2000000),
                    'audioBitsPerSecond' => (int)($this->media['video']['audioBitsPerSecond'] ?? 96000),
                    'maximumDurationSeconds' => (int)($this->media['video']['maximumDurationSeconds'] ?? 90),
                ],
            ],
            'labels' => $labels,
        ];
    }
}
