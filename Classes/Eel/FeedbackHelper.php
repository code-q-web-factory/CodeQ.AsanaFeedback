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
    private array $assetVersions = [];

    /**
     * @Flow\Inject
     * @var WidgetConfigService
     */
    protected $widgetConfigService;

    public function widgetConfig(string $dimensionLanguage, string $prepareUrl): string
    {
        $config = $this->widgetConfigService->buildConfig($dimensionLanguage, $prepareUrl);

        // HEX flags keep the JSON safe for embedding inside a <script> tag
        return json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
    }

    public function assetVersion(string $resourceUri): string
    {
        if (!isset($this->assetVersions[$resourceUri])) {
            $hash = sha1_file($resourceUri);
            if ($hash === false) {
                throw new \RuntimeException(sprintf('Could not hash feedback widget asset "%s".', $resourceUri));
            }
            $this->assetVersions[$resourceUri] = $hash;
        }

        return $this->assetVersions[$resourceUri];
    }

    public function allowsCallOfMethod($methodName): bool
    {
        return true;
    }
}
