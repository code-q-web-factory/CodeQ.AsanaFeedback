<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use CodeQ\AsanaFeedback\Exception\AsanaApiException;
use CodeQ\AsanaFeedback\Exception\ConfigurationException;
use Neos\Flow\Annotations as Flow;

/**
 * Thin server side client for the Asana REST API. All communication with
 * Asana happens exclusively through this class so the access token never
 * leaves the server.
 *
 * @Flow\Scope("singleton")
 */
class AsanaClient
{
    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback", path="asana")
     * @var array
     */
    protected $asanaSettings;

    /**
     * Resolves the target section GID by comparing the project sections
     * against an ordered list of candidate names, case-insensitively.
     * The first candidate name that matches a section wins.
     */
    public function resolveSectionGidByName(string $projectGid, array $candidateNames): ?string
    {
        $sections = $this->request('GET', sprintf('/projects/%s/sections', urlencode($projectGid)) . '?opt_fields=name');

        foreach ($candidateNames as $candidateName) {
            foreach ($sections as $section) {
                if (mb_strtolower(trim((string)($section['name'] ?? ''))) === mb_strtolower(trim($candidateName))) {
                    return (string)$section['gid'];
                }
            }
        }

        return null;
    }

    /**
     * Creates a task inside the given project and section. Passing the
     * section via memberships places the task directly in the right column
     * without a second addTask request.
     *
     * @return array{gid: string, permalinkUrl: string}
     */
    public function createTask(
        string $projectGid,
        string $sectionGid,
        string $name,
        string $notes,
        ?string $assigneeGid = null
    ): array {
        $taskData = [
            'projects' => [$projectGid],
            'memberships' => [
                ['project' => $projectGid, 'section' => $sectionGid],
            ],
            'name' => $name,
            'notes' => $notes,
        ];
        if ($assigneeGid !== null) {
            $taskData['assignee'] = $assigneeGid;
        }

        $task = $this->request('POST', '/tasks?opt_fields=permalink_url', ['data' => $taskData]);

        return [
            'gid' => (string)$task['gid'],
            'permalinkUrl' => (string)($task['permalink_url'] ?? ''),
        ];
    }

    /**
     * Uploads a file from disk as attachment to the given task.
     */
    public function uploadAttachment(string $taskGid, string $filePath, string $fileName, string $mimeType): void
    {
        $curlFile = new \CURLFile($filePath, $mimeType, $fileName);
        $this->request('POST', '/attachments', [
            'parent' => $taskGid,
            'file' => $curlFile,
        ], true);
    }

    /**
     * Executes a request against the Asana API and returns the decoded
     * "data" part of the response.
     *
     * @param array|null $body JSON body, or multipart fields when $multipart is true
     */
    protected function request(string $method, string $path, ?array $body = null, bool $multipart = false): array
    {
        $accessToken = (string)($this->asanaSettings['accessToken'] ?? '');
        if ($accessToken === '') {
            throw new ConfigurationException('No Asana access token is configured.', 1752130001);
        }

        $curlHandle = curl_init($this->asanaSettings['apiBaseUri'] . $path);
        $headers = [
            'Authorization: Bearer ' . $accessToken,
            'Accept: application/json',
        ];

        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 10,
        ];

        if ($body !== null) {
            if ($multipart) {
                // curl sets the multipart/form-data content type including boundary itself
                $options[CURLOPT_POSTFIELDS] = $body;
            } else {
                $headers[] = 'Content-Type: application/json';
                $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
            }
        }

        $options[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($curlHandle, $options);

        $responseBody = curl_exec($curlHandle);
        $curlError = curl_error($curlHandle);
        $statusCode = (int)curl_getinfo($curlHandle, CURLINFO_RESPONSE_CODE);
        curl_close($curlHandle);

        if ($responseBody === false) {
            throw new AsanaApiException(sprintf('Asana API request "%s %s" failed on transport level: %s', $method, $path, $curlError), 1752130002);
        }

        $decodedResponse = json_decode((string)$responseBody, true);
        if ($statusCode < 200 || $statusCode >= 300) {
            $asanaErrorMessage = $decodedResponse['errors'][0]['message'] ?? mb_substr((string)$responseBody, 0, 300);
            throw new AsanaApiException(sprintf('Asana API request "%s %s" returned status %d: %s', $method, $path, $statusCode, $asanaErrorMessage), 1752130003);
        }
        if (!is_array($decodedResponse) || !array_key_exists('data', $decodedResponse)) {
            throw new AsanaApiException(sprintf('Asana API request "%s %s" returned an unexpected response body.', $method, $path), 1752130004);
        }

        return $decodedResponse['data'];
    }
}
