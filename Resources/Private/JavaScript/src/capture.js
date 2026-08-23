import { toSvg } from 'html-to-image';
import html2canvas from 'html2canvas';

import { buildFontEmbedCss } from './fonts';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/**
 * Captures the currently visible viewport as a canvas. Documents with web
 * fonts are rendered directly to canvas; other documents use a sanitized
 * html-to-image SVG (see below). Elements carrying a data-codeq-feedback
 * attribute (the widget itself) are excluded from both render paths.
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
        fontEmbedCss,
        pixelRatio
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
                frameFontEmbedCss,
                pixelRatio
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

async function renderDocument(documentElement, width, height, fontEmbedCss = '', scale = 1) {
    if (fontEmbedCss) {
        return renderDocumentWithWebFonts(documentElement, width, height, fontEmbedCss, scale);
    }

    return { image: await renderDocumentToImage(documentElement, width, height), scale: 1 };
}

/**
 * Browsers do not reliably use embedded web fonts when an SVG foreignObject
 * is rasterized. Render documents containing web fonts directly to canvas so
 * text metrics and line breaks match the live page.
 */
async function renderDocumentWithWebFonts(documentElement, width, height, fontEmbedCss, scale) {
    const sourceDocument = documentElement.ownerDocument;
    const embeddedFonts = sourceDocument.createElement('style');
    embeddedFonts.dataset.codeqFeedbackFonts = '';
    embeddedFonts.textContent = `${fontEmbedCss}\n*:not(svg):not(svg *) { letter-spacing: 0.0001px !important; }`;
    sourceDocument.head.appendChild(embeddedFonts);

    try {
        const image = await html2canvas(documentElement, {
            width,
            height,
            scale,
            backgroundColor: '#ffffff',
            logging: false,
            useCORS: true,
            ignoreElements: (node) => node.dataset && node.dataset.codeqFeedback !== undefined,
        });
        return { image, scale };
    } finally {
        embeddedFonts.remove();
    }
}

async function renderDocumentToImage(documentElement, width, height) {
    const svgDataUrl = await toSvg(documentElement, {
        width,
        height,
        // the widget must never be part of the screenshot
        filter: (node) => !(node.dataset && node.dataset.codeqFeedback !== undefined),
        // precomputed web-font CSS; passing it (even empty) stops html-to-image
        // from scanning the live stylesheets and erroring on cross-origin sheets
        fontEmbedCSS: '',
        // external images without CORS headers would otherwise abort the capture
        imagePlaceholder:
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#dddddd"/></svg>'),
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
