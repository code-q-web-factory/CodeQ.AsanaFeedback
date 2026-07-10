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
        'descriptionLabel', 'descriptionPlaceholder', 'authorLabel', 'authorPlaceholder',
        'assigneeLabel', 'assigneeNone', 'submit', 'cancel', 'back', 'sending',
        'successTitle', 'successMessage', 'openTask', 'errorTitle', 'errorGeneric',
        'errorValidation', 'errorDescriptionRequired', 'errorRateLimit',
        'errorConfiguration', 'errorAttachment', 'errorScreenshot', 'errorForbidden',
        'newFeedback', 'close', 'screenshotPreviewAlt', 'editAnnotations',
        'recordScreencast', 'recording', 'stopRecording', 'screencastNotSupported',
        'screencastTooLarge', 'removeScreencast', 'screencastAttached', 'videoUploadFailed',
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

    public function buildConfig(string $requestedLanguage, string $submitUrl): array
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
            'submitUrl' => $submitUrl,
            'user' => [
                'authenticated' => $userContext['authenticated'],
                'authorName' => $userContext['authorName'],
                'isTeamMember' => $userContext['isTeamMember'],
            ],
            'assignees' => $userContext['isTeamMember'] ? $this->userContextService->getAssigneesForWidget() : [],
            'limits' => [
                'screenshotBytes' => (int)($this->limits['screenshotBytes'] ?? 10485760),
                'videoBytes' => (int)($this->limits['videoBytes'] ?? 100000000),
                'descriptionCharacters' => (int)($this->limits['descriptionCharacters'] ?? 10000),
            ],
            'labels' => $labels,
        ];
    }
}
