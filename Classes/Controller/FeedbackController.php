<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Controller;

use CodeQ\AsanaFeedback\Eel\FeedbackHelper;
use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use CodeQ\AsanaFeedback\Exception\TooManyRequestsException;
use CodeQ\AsanaFeedback\Exception\ValidationException;
use CodeQ\AsanaFeedback\Service\FeedbackService;
use CodeQ\AsanaFeedback\Service\RateLimiter;
use CodeQ\AsanaFeedback\Service\UploadGrantService;
use CodeQ\AsanaFeedback\Service\UserContextService;
use CodeQ\AsanaFeedback\Service\WidgetConfigService;
use Neos\Flow\Annotations as Flow;
use Neos\Flow\Mvc\Controller\ActionController;
use Psr\Log\LoggerInterface;

/**
 * Public metadata endpoint for the feedback widget. Binary files are sent
 * directly from the browser to the separately deployed feedback relay.
 */
class FeedbackController extends ActionController
{
    /**
     * @var array
     */
    protected $supportedMediaTypes = ['application/json'];

    /**
     * @Flow\Inject
     * @var FeedbackService
     */
    protected $feedbackService;

    /**
     * @Flow\Inject
     * @var UserContextService
     */
    protected $userContextService;

    /**
     * @Flow\Inject
     * @var RateLimiter
     */
    protected $rateLimiter;

    /**
     * @Flow\Inject
     * @var WidgetConfigService
     */
    protected $widgetConfigService;

    /**
     * @Flow\Inject
     * @var FeedbackHelper
     */
    protected $feedbackHelper;

    /**
     * @Flow\Inject
     * @var UploadGrantService
     */
    protected $uploadGrantService;

    /**
     * @Flow\Inject(name="Neos.Flow:SystemLogger")
     * @var LoggerInterface
     */
    protected $logger;

    /**
     * Bootstrap configuration for the Neos backend toolbar plugin. Only
     * available to authenticated Neos users; the website frontend embeds
     * the same configuration through the Fusion integration instead.
     */
    public function configAction(string $locale = 'en'): string
    {
        $this->response->setContentType('application/json');

        if (!$this->userContextService->getCurrentUserContext()['authenticated']) {
            return $this->jsonError(403, 'forbidden', 'The feedback configuration requires a Neos backend session.');
        }

        return $this->widgetConfigJson($locale);
    }

    /**
     * Bootstrap configuration for frontend integrations that cannot render
     * the Fusion embed, such as static or headless frontends.
     */
    public function frontendConfigAction(string $locale = 'en'): string
    {
        $this->response->setContentType('application/json');

        if (!$this->userContextService->isWidgetEnabledForCurrentUser()) {
            return $this->jsonError(403, 'forbidden', 'The feedback widget is not enabled for frontend visitors.');
        }

        $prepareUrl = $this->uriBuilder->reset()->setFormat('json')->uriFor('prepare', [], 'Feedback', 'CodeQ.AsanaFeedback');
        $config = $this->widgetConfigService->buildConfig($locale, $prepareUrl);
        $config['assets'] = $this->feedbackHelper->frontendAssetUrls();

        return json_encode($config, JSON_THROW_ON_ERROR);
    }

    protected function widgetConfigJson(string $locale): string
    {
        $prepareUrl = $this->uriBuilder->reset()->setFormat('json')->uriFor('prepare', [], 'Feedback', 'CodeQ.AsanaFeedback');

        return json_encode(
            $this->widgetConfigService->buildConfig($locale, $prepareUrl),
            JSON_THROW_ON_ERROR
        );
    }

    /**
     * Validates the small metadata payload and returns a short-lived upload
     * grant. Screenshot and video bytes never pass through this endpoint.
     *
     * @Flow\SkipCsrfProtection
     */
    public function prepareAction(): string
    {
        $httpRequest = $this->request->getHttpRequest();
        $this->response->setContentType('application/json');

        if (!$this->userContextService->isWidgetEnabledForCurrentUser()) {
            return $this->jsonError(403, 'forbidden', 'The feedback widget is not enabled for anonymous users.');
        }

        try {
            $clientIp = (string)($httpRequest->getAttribute('clientIpAddress') ?? $httpRequest->getServerParams()['REMOTE_ADDR'] ?? 'unknown');
            $this->rateLimiter->countRequestOrDeny($clientIp);
            $parsedBody = $httpRequest->getParsedBody();
            if (!is_array($parsedBody)) {
                $parsedBody = json_decode((string)$httpRequest->getBody(), true);
            }
            if (!is_array($parsedBody)) {
                throw new ValidationException('The feedback metadata is malformed.', 1752130023);
            }
            $technicalContext = is_array($parsedBody['technicalContext'] ?? null)
                ? $parsedBody['technicalContext']
                : [];
            $preparedSubmission = $this->feedbackService->prepareSubmission([
                'submissionId' => (string)($parsedBody['submissionId'] ?? ''),
                'title' => (string)($parsedBody['title'] ?? ''),
                'description' => (string)($parsedBody['description'] ?? ''),
                'authorName' => (string)($parsedBody['authorName'] ?? ''),
                'assigneeKey' => (string)($parsedBody['assigneeKey'] ?? ''),
                'pageUrl' => (string)($parsedBody['pageUrl'] ?? ''),
                'technicalContext' => $technicalContext,
            ]);

            $requestUri = $httpRequest->getUri();
            $requestOrigin = $requestUri->getScheme() . '://' . $requestUri->getAuthority();

            return json_encode([
                'success' => true,
            ] + $this->uploadGrantService->createGrant($preparedSubmission, $requestOrigin), JSON_THROW_ON_ERROR);
        } catch (ValidationException $exception) {
            $this->logger->warning('CodeQ.AsanaFeedback: Rejected feedback metadata: ' . $exception->getMessage());
            return $this->jsonError(400, 'validation', $exception->getMessage());
        } catch (TooManyRequestsException $exception) {
            $this->logger->warning('CodeQ.AsanaFeedback: ' . $exception->getMessage());
            return $this->jsonError(429, 'rateLimit', 'Too many requests, please try again later.');
        } catch (ConfigurationException $exception) {
            // the detailed cause (e.g. a missing grant secret) is only logged;
            // the browser receives a stable, non-revealing message and the
            // widget maps the "configuration" code to a localized notice
            $this->logger->critical('CodeQ.AsanaFeedback: Configuration error: ' . $exception->getMessage());
            return $this->jsonError(500, 'configuration', 'The feedback service is not configured completely.');
        } catch (\Throwable $exception) {
            $this->logger->error('CodeQ.AsanaFeedback: Unexpected grant error: ' . $exception->getMessage(), ['exception' => $exception]);
            return $this->jsonError(500, 'internal', 'An unexpected error occurred.');
        }
    }

    protected function jsonError(int $statusCode, string $errorCode, string $message): string
    {
        $this->response->setStatusCode($statusCode);

        return json_encode([
            'success' => false,
            'errorCode' => $errorCode,
            'message' => $message,
        ], JSON_THROW_ON_ERROR);
    }
}
