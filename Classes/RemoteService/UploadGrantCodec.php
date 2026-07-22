<?php

declare(strict_types=1);

// Compatibility loader for installations whose Composer metadata still has
// only the package-wide CodeQ\AsanaFeedback\ namespace registered. The
// standalone relay loads the shared implementation directly.
require_once dirname(__DIR__, 2) . '/RemoteService/UploadGrantCodec.php';
