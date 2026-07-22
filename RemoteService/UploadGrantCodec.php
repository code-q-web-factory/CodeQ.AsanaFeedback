<?php

declare(strict_types=1);

namespace CodeQ\AsanaFeedback\RemoteService;

/**
 * Creates short-lived opaque upload grants for the browser and validates
 * them in the standalone relay. Only the shared server-side secret can read
 * or modify the embedded Asana routing and user authorization claims.
 */
final class UploadGrantCodec
{
    private const CIPHER = 'aes-256-gcm';
    private const VERSION = 'v1';
    private const ADDITIONAL_AUTHENTICATED_DATA = 'codeq-asana-feedback-upload-grant-v1';
    private const CORS_SIGNATURE_CONTEXT = 'codeq-asana-feedback-cors-policy-v1.';
    private const SITE_ID_CONTEXT = 'codeq-asana-feedback-site-id-v1.';
    private const NONCE_BYTES = 12;
    private const TAG_BYTES = 16;

    private string $key;

    public function __construct(string $sharedSecret)
    {
        if (strlen($sharedSecret) < 32) {
            throw new \InvalidArgumentException('The feedback relay shared secret must contain at least 32 characters.');
        }
        $this->key = hash('sha256', $sharedSecret, true);
    }

    public function encodeGrant(array $claims): string
    {
        $nonce = random_bytes(self::NONCE_BYTES);
        $tag = '';
        $ciphertext = openssl_encrypt(
            json_encode($claims, JSON_THROW_ON_ERROR),
            self::CIPHER,
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            self::ADDITIONAL_AUTHENTICATED_DATA,
            self::TAG_BYTES
        );
        if ($ciphertext === false) {
            throw new \RuntimeException('The upload grant could not be encrypted.');
        }

        return self::VERSION . '.' . $this->base64UrlEncode($nonce . $tag . $ciphertext);
    }

    /**
     * Derives a stable relay namespace without exposing the Asana project GID.
     */
    public function deriveSiteId(string $projectGid): string
    {
        if (preg_match('/^\d+$/', $projectGid) !== 1) {
            throw new \InvalidArgumentException('A numeric Asana project GID is required.');
        }

        return hash_hmac('sha256', self::SITE_ID_CONTEXT . $projectGid, $this->key);
    }

    public function decodeGrant(string $token, ?int $now = null): array
    {
        if (!str_starts_with($token, self::VERSION . '.')) {
            throw new \InvalidArgumentException('The upload grant has an unsupported version.');
        }
        $encodedPayload = substr($token, strlen(self::VERSION) + 1);
        $payload = $this->base64UrlDecode($encodedPayload);
        if (strlen($payload) <= self::NONCE_BYTES + self::TAG_BYTES) {
            throw new \InvalidArgumentException('The upload grant is malformed.');
        }

        $nonce = substr($payload, 0, self::NONCE_BYTES);
        $tag = substr($payload, self::NONCE_BYTES, self::TAG_BYTES);
        $ciphertext = substr($payload, self::NONCE_BYTES + self::TAG_BYTES);
        $json = openssl_decrypt(
            $ciphertext,
            self::CIPHER,
            $this->key,
            OPENSSL_RAW_DATA,
            $nonce,
            $tag,
            self::ADDITIONAL_AUTHENTICATED_DATA
        );
        if ($json === false) {
            throw new \InvalidArgumentException('The upload grant signature is invalid.');
        }

        $claims = json_decode($json, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($claims) || !isset($claims['expiresAt']) || !is_int($claims['expiresAt'])) {
            throw new \InvalidArgumentException('The upload grant claims are incomplete.');
        }
        if (($now ?? time()) > $claims['expiresAt']) {
            throw new \InvalidArgumentException('The upload grant has expired.');
        }

        return $claims;
    }

    /**
     * Signs a non-secret CORS policy for OPTIONS requests. The browser may
     * read the policy, but cannot add an origin or extend its lifetime.
     */
    public function encodeCorsPolicy(array $claims): string
    {
        $payload = $this->base64UrlEncode(json_encode($claims, JSON_THROW_ON_ERROR));
        $signature = hash_hmac('sha256', self::CORS_SIGNATURE_CONTEXT . $payload, $this->key, true);

        return self::VERSION . '.' . $payload . '.' . $this->base64UrlEncode($signature);
    }

    public function decodeCorsPolicy(string $token, ?int $now = null): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3 || $parts[0] !== self::VERSION) {
            throw new \InvalidArgumentException('The CORS policy has an unsupported format.');
        }
        [, $payload, $encodedSignature] = $parts;
        $expectedSignature = hash_hmac('sha256', self::CORS_SIGNATURE_CONTEXT . $payload, $this->key, true);
        if (!hash_equals($expectedSignature, $this->base64UrlDecode($encodedSignature))) {
            throw new \InvalidArgumentException('The CORS policy signature is invalid.');
        }

        $claims = json_decode($this->base64UrlDecode($payload), true, 16, JSON_THROW_ON_ERROR);
        if (
            !is_array($claims)
            || !isset($claims['expiresAt'], $claims['siteId'], $claims['allowedOrigins'])
            || !is_int($claims['expiresAt'])
            || !is_string($claims['siteId'])
            || !is_array($claims['allowedOrigins'])
        ) {
            throw new \InvalidArgumentException('The CORS policy claims are incomplete.');
        }
        if (($now ?? time()) > $claims['expiresAt']) {
            throw new \InvalidArgumentException('The CORS policy has expired.');
        }

        return $claims;
    }

    public function isOriginAllowed(string $origin, array $allowedOrigins): bool
    {
        $normalizedOrigin = $this->normalizeOrigin($origin);
        if ($normalizedOrigin === null) {
            return false;
        }

        foreach ($allowedOrigins as $allowedOrigin) {
            if (is_string($allowedOrigin) && $this->normalizeOrigin($allowedOrigin) === $normalizedOrigin) {
                return true;
            }
        }

        return false;
    }

    private function normalizeOrigin(string $origin): ?string
    {
        $origin = trim($origin);
        if ($origin === '' || $origin === 'null') {
            return null;
        }
        $parts = parse_url($origin);
        if (
            !is_array($parts)
            || !isset($parts['scheme'], $parts['host'])
            || !in_array(strtolower((string)$parts['scheme']), ['http', 'https'], true)
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || (isset($parts['path']) && $parts['path'] !== '' && $parts['path'] !== '/')
        ) {
            return null;
        }

        $scheme = strtolower((string)$parts['scheme']);
        $normalized = $scheme . '://' . strtolower((string)$parts['host']);
        if (isset($parts['port'])) {
            $port = (int)$parts['port'];
            if (!(($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80))) {
                $normalized .= ':' . $port;
            }
        }

        return $normalized;
    }

    private function base64UrlEncode(string $value): string
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private function base64UrlDecode(string $value): string
    {
        $padding = (4 - strlen($value) % 4) % 4;
        $decoded = base64_decode(strtr($value . str_repeat('=', $padding), '-_', '+/'), true);
        if ($decoded === false) {
            throw new \InvalidArgumentException('The upload grant encoding is invalid.');
        }

        return $decoded;
    }
}
