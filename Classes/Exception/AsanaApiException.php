<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Exception;

/**
 * Thrown when the Asana REST API returns an error or is unreachable,
 * so Asana failures stay distinguishable from validation or network issues.
 */
class AsanaApiException extends \RuntimeException
{
}
