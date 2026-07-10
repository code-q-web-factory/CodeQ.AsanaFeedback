<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\Service;

use CodeQ\AsanaFeedback\Exception\TooManyRequestsException;
use Neos\Cache\Frontend\VariableFrontend;
use Neos\Flow\Annotations as Flow;

/**
 * Simple cache backed rate limiter that counts submissions per client IP
 * in sliding one-minute and one-hour windows.
 *
 * @Flow\Scope("singleton")
 */
class RateLimiter
{
    /**
     * @var VariableFrontend
     */
    protected $cache;

    /**
     * @Flow\InjectConfiguration(package="CodeQ.AsanaFeedback", path="rateLimit")
     * @var array
     */
    protected $rateLimitSettings;

    public function setCache(VariableFrontend $cache): void
    {
        $this->cache = $cache;
    }

    /**
     * @throws TooManyRequestsException when one of the limits is exceeded
     */
    public function countRequestOrDeny(string $clientIp): void
    {
        $this->incrementWindow($clientIp, 'minute', 60, (int)($this->rateLimitSettings['maxPerMinute'] ?? 5));
        $this->incrementWindow($clientIp, 'hour', 3600, (int)($this->rateLimitSettings['maxPerHour'] ?? 20));
    }

    protected function incrementWindow(string $clientIp, string $windowName, int $windowSeconds, int $limit): void
    {
        // the cache identifier must only contain safe characters, so the IP is hashed
        $cacheIdentifier = sprintf('%s_%s_%d', $windowName, sha1($clientIp), intdiv(time(), $windowSeconds));
        $currentCount = (int)($this->cache->get($cacheIdentifier) ?: 0);

        if ($currentCount >= $limit) {
            throw new TooManyRequestsException(
                sprintf('Rate limit of %d requests per %s exceeded.', $limit, $windowName),
                1752130005
            );
        }

        $this->cache->set($cacheIdentifier, $currentCount + 1, [], $windowSeconds);
    }
}
