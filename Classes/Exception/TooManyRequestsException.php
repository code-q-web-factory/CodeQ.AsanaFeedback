<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Exception;

/**
 * Thrown when a client exceeds the configured submission rate limits.
 */
class TooManyRequestsException extends \RuntimeException
{
}
