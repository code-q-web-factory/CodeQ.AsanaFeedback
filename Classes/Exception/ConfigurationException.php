<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Exception;

/**
 * Thrown when the package is not configured completely enough to create
 * a task (missing token, project GID or resolvable section).
 */
class ConfigurationException extends \RuntimeException
{
}
