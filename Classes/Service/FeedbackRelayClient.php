<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use CodeQ\AsanaFeedback\Exception\AsanaApiException;
use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use Neos\Flow\Annotations as Flow;

/**
 * Client for the Asana feedback relay service (see RemoteService/ in this
 * package). The Neos project never talks to Asana directly and never holds
 * the Asana access token: it authenticates against the relay with a shared
 * secret whose only capability is creating one feedback task per request.
 *
 * @Flow\Scope("singleton")
 */
class FeedbackRelayClient
{
    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback", path="feedbackService")
     * @var array
     */
    protected $serviceSettings;

    /**
     * Sends one feedback submission to the relay, which resolves the target
     * section, creates the task and attaches the files in a single request.
     *
     * @param array{projectGid: string, sectionGid: string, sectionNames: array<string>, name: string, notes: string, assigneeGid: ?string} $task
     * @param array{path: string, mimeType: string, extension: string} $screenshotFile
     * @param array{path: string, mimeType: string, extension: string}|null $videoFile
     * @return array{taskGid: string, taskUrl: string, warnings: array<string>}
     * @throws ConfigurationException|AsanaApiException
     */
    public function createTask(array $task, array $screenshotFile, ?array $videoFile): array
    {
        $endpoint = trim((string)($this->serviceSettings['endpoint'] ?? ''));
        if ($endpoint === '') {
            throw new ConfigurationException('No feedback service endpoint is configured.', 1752130030);
        }
        $accessToken = (string)($this->serviceSettings['accessToken'] ?? '');
        if ($accessToken === '') {
            throw new ConfigurationException('No feedback service access token is configured.', 1752130001);
        }

        $postFields = [
            'projectGid' => $task['projectGid'],
            'sectionGid' => $task['sectionGid'],
            'sectionNames' => json_encode($task['sectionNames'], JSON_THROW_ON_ERROR),
            'name' => $task['name'],
            'notes' => $task['notes'],
            'assigneeGid' => (string)($task['assigneeGid'] ?? ''),
            'screenshot' => new \CURLFile($screenshotFile['path'], $screenshotFile['mimeType'], 'screenshot.' . $screenshotFile['extension']),
        ];
        if ($videoFile !== null) {
            $postFields['video'] = new \CURLFile($videoFile['path'], $videoFile['mimeType'], 'screencast.' . $videoFile['extension']);
        }

        $curlHandle = curl_init($endpoint);
        curl_setopt_array($curlHandle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            // curl sets the multipart/form-data content type including boundary itself
            CURLOPT_POSTFIELDS => $postFields,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $accessToken,
                'Accept: application/json',
            ],
            // the relay itself uploads to Asana, so allow for both transfers
            CURLOPT_TIMEOUT => 300,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);

        $responseBody = curl_exec($curlHandle);
        $curlError = curl_error($curlHandle);
        $statusCode = (int)curl_getinfo($curlHandle, CURLINFO_RESPONSE_CODE);
        curl_close($curlHandle);

        if ($responseBody === false) {
            throw new AsanaApiException(sprintf('The feedback service request failed on transport level: %s', $curlError), 1752130031);
        }

        $decodedResponse = json_decode((string)$responseBody, true);
        if (!is_array($decodedResponse)) {
            throw new AsanaApiException(sprintf('The feedback service returned an unexpected response (status %d).', $statusCode), 1752130032);
        }

        if (($decodedResponse['success'] ?? false) !== true) {
            $errorCode = (string)($decodedResponse['errorCode'] ?? 'unknown');
            $message = (string)($decodedResponse['message'] ?? 'Unknown feedback service error.');

            if ($errorCode === 'attachmentFailed') {
                // preserved error code: the controller reports this partial
                // failure ("task exists, screenshot missing") to the widget
                throw new AsanaApiException($message, 1752130016);
            }
            if (in_array($errorCode, ['configuration', 'unauthorized', 'forbidden'], true)) {
                throw new ConfigurationException(sprintf('The feedback service rejected the request (%s): %s', $errorCode, $message), 1752130033);
            }

            throw new AsanaApiException(sprintf('The feedback service returned status %d (%s): %s', $statusCode, $errorCode, $message), 1752130034);
        }

        return [
            'taskGid' => (string)($decodedResponse['taskGid'] ?? ''),
            'taskUrl' => (string)($decodedResponse['taskUrl'] ?? ''),
            'warnings' => array_map('strval', (array)($decodedResponse['warnings'] ?? [])),
        ];
    }
}
