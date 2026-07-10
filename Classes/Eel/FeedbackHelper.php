<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Eel;

use CodeQ\AsanaFeedback\Service\WidgetConfigService;
use Neos\Eel\ProtectedContextAwareInterface;
use Neos\Flow\Annotations as Flow;

/**
 * Eel helper used by the Fusion integration to assemble the widget
 * bootstrap configuration. The result is user specific and may only be
 * used inside uncached Fusion segments.
 */
class FeedbackHelper implements ProtectedContextAwareInterface
{
    /**
     * @Flow\Inject
     * @var WidgetConfigService
     */
    protected $widgetConfigService;

    public function widgetConfig(string $dimensionLanguage, string $submitUrl): string
    {
        $config = $this->widgetConfigService->buildConfig($dimensionLanguage, $submitUrl);

        // HEX flags keep the JSON safe for embedding inside a <script> tag
        return json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
    }

    public function allowsCallOfMethod($methodName): bool
    {
        return true;
    }
}
