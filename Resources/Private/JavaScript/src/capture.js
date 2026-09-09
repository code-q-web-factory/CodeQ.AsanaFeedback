import { toSvg } from 'html-to-image';

import { buildFontEmbedCss } from './fonts';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/**
 * Captures the currently visible viewport as a canvas through a sanitized
 * html-to-image SVG. Web fonts are embedded before rendering so the browser
 * keeps the live document's text and image layout. Elements carrying a
 * data-codeq-feedback attribute (the widget itself) are excluded.
 *
 * With "includeIframes" the visible same-origin iframes are rendered
 * separately and composited into the result — SVG foreignObject rendering
 * leaves iframes blank, but the Neos backend draws its whole content
 * area inside one.
 */
export async function captureViewport({ includeIframes = false } = {}) {
    // clamp the pixel ratio so large pages stay below browser canvas limits
    let pixelRatio = window.devicePixelRatio || 1;
    const maximumCanvasArea = 200000000;
    if (window.innerWidth * window.innerHeight * pixelRatio * pixelRatio > maximumCanvasArea) {
        pixelRatio = 1;
    }

    // Precompute the web-font CSS once and hand it to html-to-image so it
    // never scans the live stylesheets (which floods the console for the
    // cross-origin Adobe Fonts kit and leaves the brand font unembedded).
    const fontEmbedCss = await buildFontEmbedCss();

    const pageRender = await renderDocument(
        document.documentElement,
        Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
        Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        fontEmbedCss
    );

    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = Math.round(window.innerWidth * pixelRatio);
    viewportCanvas.height = Math.round(window.innerHeight * pixelRatio);

    const context = viewportCanvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, viewportCanvas.width, viewportCanvas.height);
    // Source coordinates follow the renderer's scale. The target canvas is
    // device-pixel sized, so text and icons are never upscaled from a 1x bitmap.
    context.drawImage(
        pageRender.image,
        Math.round(window.scrollX * pageRender.scale),
        Math.round(window.scrollY * pageRender.scale),
        window.innerWidth * pageRender.scale,
        window.innerHeight * pageRender.scale,
        0,
        0,
        viewportCanvas.width,
        viewportCanvas.height
    );

    if (includeIframes) {
        await compositeVisibleIframes(context, pixelRatio);
    }

    return viewportCanvas;
}

/** Renders every visible, accessible iframe over its blank placeholder. */
async function compositeVisibleIframes(context, pixelRatio) {
    for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
        const rect = iframe.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
            rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth;
        let frameDocument = null;
        try {
            frameDocument = iframe.contentDocument;
        } catch (crossOriginError) {
            // cross-origin frames stay blank
        }
        if (!isVisible || !frameDocument || !frameDocument.documentElement) {
            continue;
        }

        try {
            const frameWindow = iframe.contentWindow;
            const frameFontEmbedCss = await buildFontEmbedCss(frameDocument);
            const frameRender = await renderDocument(
                frameDocument.documentElement,
                Math.max(frameDocument.documentElement.scrollWidth, frameDocument.documentElement.clientWidth),
                Math.max(frameDocument.documentElement.scrollHeight, frameDocument.documentElement.clientHeight),
                frameFontEmbedCss
            );
            context.fillStyle = '#ffffff';
            context.fillRect(rect.left * pixelRatio, rect.top * pixelRatio, rect.width * pixelRatio, rect.height * pixelRatio);
            context.drawImage(
                frameRender.image,
                Math.round(frameWindow.scrollX * frameRender.scale),
                Math.round(frameWindow.scrollY * frameRender.scale),
                rect.width * frameRender.scale,
                rect.height * frameRender.scale,
                Math.round(rect.left * pixelRatio),
                Math.round(rect.top * pixelRatio),
                Math.round(rect.width * pixelRatio),
                Math.round(rect.height * pixelRatio)
            );
        } catch (renderError) {
            // a frame that cannot be rendered keeps its blank placeholder
            console.warn('CodeQ.AsanaFeedback: could not composite iframe', renderError);
        }
    }
}

async function renderDocument(documentElement, width, height, fontEmbedCss = '') {
    return { image: await renderDocumentToImage(documentElement, width, height, fontEmbedCss), scale: 1 };
}

async function renderDocumentToImage(documentElement, width, height, fontEmbedCss) {
    const svgDataUrl = await toSvg(documentElement, {
        width,
        height,
        // Exclude feedback and browser-extension UI. html-to-image flattens
        // shadow roots: ElevenReader's [data-icon] !important rule would then
        // resize Neos icons to 36px. Keep the extension's entire subtree out
        // rather than stripping styles needed by the site's web components.
        filter: (node) => !(node.dataset && node.dataset.codeqFeedback !== undefined) &&
            node.id !== 'elevenreader-extension-container',
        // precomputed web-font CSS; passing it (even empty) stops html-to-image
        // from scanning the live stylesheets and erroring on cross-origin sheets
        fontEmbedCSS: fontEmbedCss,
        // external images without CORS headers would otherwise abort the capture
        imagePlaceholder:
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#dddddd"/></svg>'),
        // Next.js serves every optimized image through /_next/image and uses
        // only the query string to identify the source. Stripping it makes
        // unrelated images share one html-to-image cache entry.
        includeQueryParams: true,
    });

    const sanitizedMarkup = sanitizeSvgMarkup(decodeURIComponent(svgDataUrl.substring(SVG_DATA_URL_PREFIX.length)));

    return loadImage(SVG_DATA_URL_PREFIX + encodeURIComponent(sanitizedMarkup));
}

/**
 * Frontend frameworks like Alpine.js use attribute names ("x-on:click",
 * "@click", ":class") that are invalid XML. Inside the serialized SVG
 * foreignObject they would be treated as undefined namespace prefixes and
 * the whole image would refuse to load, so they are stripped. Attribute
 * values are XML-escaped by the serializer, quotes cannot occur inside.
 */
function sanitizeSvgMarkup(svgMarkup) {
    let sanitizedMarkup = svgMarkup.replace(/\s(?:x-[\w-]+:|@|:)[^\s=]*="[^"]*"/g, ' ');

    const parsed = new DOMParser().parseFromString(sanitizedMarkup, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) {
        // last resort: strip every attribute with an unknown namespace prefix
        sanitizedMarkup = sanitizedMarkup.replace(/\s(?!xml:|xmlns:|xmlns=|xlink:)[\w-]+:[\w.-]+="[^"]*"/g, ' ');
    }

    return sanitizedMarkup;
}

function loadImage(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('The rendered page image could not be loaded.'));
        image.src = source;
    });
}
