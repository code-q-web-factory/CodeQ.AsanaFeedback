<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\RemoteService;

final class RelayConfigurationException extends \RuntimeException
{
    public string $publicMessage;

    public function __construct(string $publicMessage, ?string $diagnosticMessage = null)
    {
        parent::__construct($diagnosticMessage ?? $publicMessage);
        $this->publicMessage = $publicMessage;
    }
}
