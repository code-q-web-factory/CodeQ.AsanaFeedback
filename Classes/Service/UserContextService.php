<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use Neos\Flow\Annotations as Flow;
use Neos\Flow\ResourceManagement\ResourceManager;
use Neos\Flow\Security\Context as SecurityContext;
use Neos\Neos\Domain\Service\UserService;

/**
 * Determines the identity of the current visitor server side: whether a
 * Neos backend session exists, the display name of the Neos user and
 * whether the user belongs to the internal Code Q team allowlist.
 *
 * @Flow\Scope("singleton")
 */
class UserContextService
{
    /**
     * @Flow\Inject
     * @var SecurityContext
     */
    protected $securityContext;

    /**
     * @Flow\Inject
     * @var UserService
     */
    protected $userService;

    /**
     * @Flow\Inject
     * @var ResourceManager
     */
    protected $resourceManager;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback")
     * @var array
     */
    protected $settings;

    /**
     * @return array{authenticated: bool, accountIdentifier: ?string, authorName: ?string, isTeamMember: bool}
     */
    public function getCurrentUserContext(): array
    {
        $context = [
            'authenticated' => false,
            'accountIdentifier' => null,
            'authorName' => null,
            'isTeamMember' => false,
        ];

        if (!$this->securityContext->canBeInitialized()) {
            return $context;
        }

        $account = $this->securityContext->getAccountByAuthenticationProviderName('Neos.Neos:Backend');
        if ($account === null) {
            return $context;
        }

        $context['authenticated'] = true;
        $context['accountIdentifier'] = $account->getAccountIdentifier();

        $user = $this->userService->getCurrentUser();
        if ($user !== null) {
            $context['authorName'] = $user->getLabel();
        }

        $teamAccountIdentifiers = array_map('strval', $this->settings['teamAccountIdentifiers'] ?? []);
        $context['isTeamMember'] = in_array($context['accountIdentifier'], $teamAccountIdentifiers, true);

        return $context;
    }

    /**
     * Whether the current visitor may submit feedback: authenticated Neos
     * users always (they use the backend toolbar button even when the
     * frontend widget is disabled), everyone else only when the frontend
     * widget is enabled by configuration.
     */
    public function isWidgetEnabledForCurrentUser(): bool
    {
        if (($this->settings['enableInFrontend'] ?? false) === true) {
            return true;
        }

        return $this->getCurrentUserContext()['authenticated'];
    }

    /**
     * Selectable assignees for the widget UI. Only labels, stable keys and
     * avatar URIs are exposed; Asana user GIDs stay on the server.
     *
     * @return array<int, array{key: string, label: string, avatarUri: ?string}>
     */
    public function getAssigneesForWidget(): array
    {
        $assignees = [];
        foreach (($this->settings['assignees'] ?? []) as $key => $assignee) {
            $avatarUri = null;
            if (!empty($assignee['avatar'])) {
                $avatarUri = $this->resourceManager->getPublicPackageResourceUriByPath($assignee['avatar']);
            }
            $assignees[] = [
                'key' => (string)$key,
                'label' => (string)($assignee['label'] ?? $key),
                'avatarUri' => $avatarUri,
            ];
        }

        return $assignees;
    }
}
