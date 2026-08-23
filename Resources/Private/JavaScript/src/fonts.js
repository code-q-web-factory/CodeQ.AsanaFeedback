/**
 * Builds embedded @font-face CSS for the document capture renderer.
 *
 * html-to-image otherwise reads `cssRules` of every stylesheet to collect
 * @font-face rules. Cross-origin sheets — here the Adobe Fonts (Typekit) kit
 * loaded via a plain <link> — throw a SecurityError on that access; the
 * library logs the error, its fetch fallback and the kit's @import tracking
 * beacon get blocked by ad blockers, and the brand font is never embedded, so
 * the screenshot renders the text in a fallback typeface.
 *
 * The kit CSS and its font files are served with Access-Control-Allow-Origin,
 * so we can read what same-origin rules expose directly and fetch the
 * cross-origin @font-face rules over CORS ourselves, inlining every font file
 * as a data URI so the cloned document uses the real typeface. The @import
 * tracking beacon is left out on purpose. Anything unreachable (e.g. blocked
 * by an ad blocker or lacking CORS headers) is skipped silently.
 */

const FONT_FACE_BLOCK = /@font-face\s*\{[^}]*\}/gi;
const URL_TOKEN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

// font files stay stable for a session, so a retake reuses the fetched data
const dataUrlByFontUrl = new Map();

/** Waits for and inlines the font faces available to one rendered document. */
export async function buildFontEmbedCss(sourceDocument = document) {
    try {
        await sourceDocument.fonts?.ready;
    } catch (fontLoadError) {
        // Failed font loads must not prevent the remaining document from being captured.
    }

    const inlinedFontFaces = [];
    for (const styleSheet of Array.from(sourceDocument.styleSheets)) {
        const baseHref = styleSheet.href || sourceDocument.baseURI;
        for (const fontFaceCss of await readFontFaceTexts(styleSheet)) {
            inlinedFontFaces.push(inlineFontUrls(fontFaceCss, baseHref));
        }
    }

    const resolved = await Promise.all(inlinedFontFaces);
    return resolved.filter(Boolean).join('\n');
}

/** Extracts the raw @font-face rule texts of one stylesheet. */
async function readFontFaceTexts(styleSheet) {
    // same-origin sheets expose their parsed rules directly
    let rules = null;
    try {
        rules = styleSheet.cssRules;
    } catch (crossOriginError) {
        rules = null;
    }
    if (rules) {
        return Array.from(rules)
            .filter((rule) => rule.type === CSSRule.FONT_FACE_RULE)
            .map((rule) => rule.cssText);
    }

    // cross-origin sheet: fetch the raw CSS over CORS and pull out the
    // @font-face blocks (the @import tracking beacon is deliberately dropped)
    if (!styleSheet.href) {
        return [];
    }
    try {
        const response = await fetch(styleSheet.href, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) {
            return [];
        }
        return (await response.text()).match(FONT_FACE_BLOCK) || [];
    } catch (unreachableError) {
        return [];
    }
}

/**
 * Rewrites a single @font-face rule so its src points at an embedded data
 * URI. Only one source is embedded (woff2 preferred) to keep the SVG small.
 * Returns null when the font file cannot be fetched, so the caller drops it.
 */
async function inlineFontUrls(fontFaceCss, baseHref) {
    const sources = [];
    fontFaceCss.replace(URL_TOKEN, (match, quote, rawUrl, offset) => {
        const after = fontFaceCss.slice(offset + match.length);
        const formatMatch = after.match(/^\s*format\(\s*(['"]?)([^'")]+)\1\s*\)/i);
        sources.push({ rawUrl, format: formatMatch ? formatMatch[2].toLowerCase() : '' });
        return match;
    });
    if (sources.length === 0) {
        // a local() only face has nothing to embed; keep it as-is
        return fontFaceCss;
    }

    const preferred = sources.find((source) => source.format.includes('woff2') || source.rawUrl.includes('woff2'));
    const chosen = preferred || sources[0];
    let dataUrl;
    try {
        dataUrl = await fetchFontAsDataUrl(new URL(chosen.rawUrl, baseHref).href);
    } catch (unreachableError) {
        return null;
    }

    const format = chosen.format || 'woff2';
    return fontFaceCss.replace(/src\s*:[^;}]*/i, `src:url("${dataUrl}") format("${format}")`);
}

function fetchFontAsDataUrl(url) {
    if (!dataUrlByFontUrl.has(url)) {
        dataUrlByFontUrl.set(url, (async () => {
            const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (!response.ok) {
                throw new Error(`Font request failed with status ${response.status}`);
            }
            return blobToDataUrl(await response.blob());
        })());
    }
    return dataUrlByFontUrl.get(url);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('The font file could not be read.'));
        reader.readAsDataURL(blob);
    });
}
