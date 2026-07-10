<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Exception;

/**
 * Thrown when user supplied data does not pass the server side checks
 * (missing description, oversized upload, disallowed MIME type, ...).
 */
class ValidationException extends \RuntimeException
{
}
