<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Controller;

use CodeQ\AsanaFeedback\Exception\AsanaApiException;
use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use CodeQ\AsanaFeedback\Exception\TooManyRequestsException;
use CodeQ\AsanaFeedback\Exception\ValidationException;
use CodeQ\AsanaFeedback\Service\FeedbackService;
use CodeQ\AsanaFeedback\Service\RateLimiter;
use CodeQ\AsanaFeedback\Service\UserContextService;
use CodeQ\AsanaFeedback\Service\WidgetConfigService;
use Neos\Flow\Annotations as Flow;
use Neos\Flow\Mvc\Controller\ActionController;
use Psr\Log\LoggerInterface;

/**
 * Public HTTP endpoint the feedback widget submits to. All Asana
 * communication is triggered from here and happens exclusively server side.
 */
class FeedbackController extends ActionController
{
    /**
     * @var array
     */
    protected $supportedMediaTypes = ['application/json', 'multipart/form-data'];

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

        return $this->widgetConfigJson($locale);
    }

    protected function widgetConfigJson(string $locale): string
    {
        $submitUrl = $this->uriBuilder->reset()->setFormat('json')->uriFor('submit', [], 'Feedback', 'CodeQ.AsanaFeedback');

        return json_encode(
            $this->widgetConfigService->buildConfig($locale, $submitUrl),
            JSON_THROW_ON_ERROR
        );
    }

    /**
     * Accepts one feedback submission as multipart/form-data and creates
     * the Asana task. CSRF protection is skipped because the page markup is
     * content cached and therefore cannot carry per-session tokens; the
     * endpoint is rate limited and validates everything server side instead.
     *
     * @Flow\SkipCsrfProtection
     */
    public function submitAction(): string
    {
        $httpRequest = $this->request->getHttpRequest();
        $this->response->setContentType('application/json');

        // anonymous submissions are only accepted when explicitly enabled
        if (!$this->userContextService->isWidgetEnabledForCurrentUser()) {
            return $this->jsonError(403, 'forbidden', 'The feedback widget is not enabled for anonymous users.');
        }

        try {
            $clientIp = (string)($httpRequest->getAttribute('clientIpAddress') ?? $httpRequest->getServerParams()['REMOTE_ADDR'] ?? 'unknown');
            $this->rateLimiter->countRequestOrDeny($clientIp);

            $parsedBody = $httpRequest->getParsedBody();
            $uploadedFiles = $httpRequest->getUploadedFiles();

            $technicalContext = [];
            if (!empty($parsedBody['technicalContext'])) {
                $decodedContext = json_decode((string)$parsedBody['technicalContext'], true);
                if (is_array($decodedContext)) {
                    $technicalContext = $decodedContext;
                }
            }

            $result = $this->feedbackService->submit(
                [
                    'title' => (string)($parsedBody['title'] ?? ''),
                    'description' => (string)($parsedBody['description'] ?? ''),
                    'authorName' => (string)($parsedBody['authorName'] ?? ''),
                    'assigneeKey' => (string)($parsedBody['assigneeKey'] ?? ''),
                    'pageUrl' => (string)($parsedBody['pageUrl'] ?? ''),
                    'technicalContext' => $technicalContext,
                ],
                $uploadedFiles['screenshot'] ?? null,
                $uploadedFiles['video'] ?? null
            );

            // the Asana task link is internal and only shown to team members
            $isTeamMember = $this->userContextService->getCurrentUserContext()['isTeamMember'];

            return json_encode([
                'success' => true,
                'taskUrl' => $isTeamMember ? $result['taskUrl'] : null,
                'warnings' => $result['warnings'],
            ], JSON_THROW_ON_ERROR);
        } catch (ValidationException $exception) {
            $this->logger->warning('CodeQ.AsanaFeedback: Rejected feedback submission: ' . $exception->getMessage());
            return $this->jsonError(400, 'validation', $exception->getMessage());
        } catch (TooManyRequestsException $exception) {
            $this->logger->warning('CodeQ.AsanaFeedback: ' . $exception->getMessage());
            return $this->jsonError(429, 'rateLimit', 'Too many requests, please try again later.');
        } catch (ConfigurationException $exception) {
            $this->logger->critical('CodeQ.AsanaFeedback: Configuration error: ' . $exception->getMessage());
            return $this->jsonError(500, 'configuration', $exception->getMessage());
        } catch (AsanaApiException $exception) {
            // 1752130016 marks the partial failure "task created, screenshot upload failed"
            $errorCode = $exception->getCode() === 1752130016 ? 'attachmentFailed' : 'asana';
            $this->logger->error('CodeQ.AsanaFeedback: Asana error: ' . $exception->getMessage());
            return $this->jsonError(502, $errorCode, 'The Asana task could not be created completely.');
        } catch (\Throwable $exception) {
            $this->logger->error('CodeQ.AsanaFeedback: Unexpected error: ' . $exception->getMessage(), ['exception' => $exception]);
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
