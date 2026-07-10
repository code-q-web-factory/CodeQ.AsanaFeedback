<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Eel;

use CodeQ\AsanaFeedback\Service\UserContextService;
use Neos\Eel\ProtectedContextAwareInterface;
use Neos\Flow\Annotations as Flow;
use Neos\Flow\I18n\Locale;
use Neos\Flow\I18n\Translator;

/**
 * Eel helper used by the Fusion integration to decide whether the widget is
 * rendered and to assemble its bootstrap configuration. Both methods are
 * user specific and may only be used inside uncached Fusion segments.
 */
class FeedbackHelper implements ProtectedContextAwareInterface
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

    public function isWidgetEnabled(): bool
    {
        return $this->userContextService->isWidgetEnabledForCurrentUser();
    }

    /**
     * Builds the JSON configuration embedded into the page for the widget.
     * Contains no secrets: no token, no GIDs of project, section or users.
     */
    public function widgetConfig(string $dimensionLanguage, string $submitUrl): string
    {
        // the widget is available in German and English, everything else falls back to English
        $locale = strtolower(substr($dimensionLanguage, 0, 2)) === 'de' ? 'de' : 'en';
        $userContext = $this->userContextService->getCurrentUserContext();

        $labels = [];
        foreach (self::TRANSLATION_KEYS as $key) {
            $labels[$key] = $this->translator->translateById($key, [], null, new Locale($locale), 'Main', 'CodeQ.AsanaFeedback')
                ?? $this->translator->translateById($key, [], null, new Locale('en'), 'Main', 'CodeQ.AsanaFeedback')
                ?? $key;
        }

        $config = [
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

        // HEX flags keep the JSON safe for embedding inside a <script> tag
        return json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
    }

    public function allowsCallOfMethod($methodName): bool
    {
        return true;
    }
}
