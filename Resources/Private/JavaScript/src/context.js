/**
 * Collects technical context about the browser environment. Parsed from
 * native APIs only, so no additional library is required; the raw user
 * agent is included as diagnostic fallback.
 */
export function collectTechnicalContext({ contentCanvasUrl = '' } = {}) {
    const userAgent = navigator.userAgent || '';

    const context = {
        browser: detectBrowser(userAgent),
        operatingSystem: detectOperatingSystem(userAgent),
        viewport: `${window.innerWidth} × ${window.innerHeight}`,
        screen: `${window.screen.width} × ${window.screen.height}`,
        devicePixelRatio: String(window.devicePixelRatio || 1),
        language: navigator.language || '',
        userAgent,
    };
    if (contentCanvasUrl) {
        context.contentCanvasUrl = contentCanvasUrl;
    }

    return context;
}

/**
 * The Neos content canvas has no src attribute because the UI navigates its
 * window directly. Read the live URL while the same-origin frame is loaded.
 */
export function getNeosContentCanvasUrl(documentReference = document) {
    const contentCanvas = documentReference.querySelector('iframe[name="neos-content-main"]');
    if (!contentCanvas) {
        return '';
    }

    try {
        const url = contentCanvas.contentWindow.location.href;
        return /^https?:\/\//.test(url) ? url : '';
    } catch (crossOriginError) {
        return '';
    }
}

function detectBrowser(userAgent) {
    // order matters: Edge and Opera also contain "Chrome", Chrome contains "Safari"
    const rules = [
        ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
        ['Opera', /OPR\/([\d.]+)/],
        ['Firefox', /Firefox\/([\d.]+)/],
        ['Chrome', /Chrome\/([\d.]+)/],
        ['Safari', /Version\/([\d.]+).*Safari/],
    ];
    for (const [name, pattern] of rules) {
        const match = userAgent.match(pattern);
        if (match) {
            return `${name} ${match[1]}`;
        }
    }
    return 'Unknown';
}

function detectOperatingSystem(userAgent) {
    if (/Windows NT 10/.test(userAgent)) return 'Windows 10/11';
    if (/Windows/.test(userAgent)) return 'Windows';
    if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
    if (/Mac OS X ([\d_]+)/.test(userAgent)) {
        return 'macOS ' + (userAgent.match(/Mac OS X ([\d_]+)/)[1] || '').replace(/_/g, '.');
    }
    if (/Android ([\d.]+)/.test(userAgent)) return 'Android ' + userAgent.match(/Android ([\d.]+)/)[1];
    if (/Linux/.test(userAgent)) return 'Linux';
    return 'Unknown';
}
