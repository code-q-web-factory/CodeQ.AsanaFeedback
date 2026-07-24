<?php

declare(strict_types=1);

// Compatibility loader for Neos installations that resolve the exception
// through the package-wide Composer namespace.
require_once dirname(__DIR__, 2) . '/RemoteService/RelayConfigurationException.php';
