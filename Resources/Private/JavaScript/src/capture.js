import { toSvg } from 'html-to-image';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/**
 * Captures the currently visible viewport as a canvas. The whole document
 * is rendered DOM-based via html-to-image into an SVG, sanitized (see
 * below), rasterized and then cropped to the visible area. Elements
 * carrying a data-codeq-feedback attribute (the widget itself) are
 * excluded through the render filter.
 *
 * With "includeIframes" the visible same-origin iframes are rendered
 * separately and composited into the result — SVG foreignObject rendering
 * leaves iframes blank, but the Neos backend draws its whole content
 * area inside one.
 */
export async function captureViewport({ includeIframes = false } = {}) {
    const pageImage = await renderDocumentToImage(
        document.documentElement,
        Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
        Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight)
    );

    // clamp the pixel ratio so large pages stay below browser canvas limits
    let pixelRatio = window.devicePixelRatio || 1;
    const maximumCanvasArea = 200000000;
    if (window.innerWidth * window.innerHeight * pixelRatio * pixelRatio > maximumCanvasArea) {
        pixelRatio = 1;
    }

    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = Math.round(window.innerWidth * pixelRatio);
    viewportCanvas.height = Math.round(window.innerHeight * pixelRatio);

    const context = viewportCanvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, viewportCanvas.width, viewportCanvas.height);
    // source coordinates are CSS pixels of the SVG, the vector content is
    // rasterized sharply at the scaled target size
    context.drawImage(
        pageImage,
        Math.round(window.scrollX),
        Math.round(window.scrollY),
        window.innerWidth,
        window.innerHeight,
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
            const frameImage = await renderDocumentToImage(
                frameDocument.documentElement,
                Math.max(frameDocument.documentElement.scrollWidth, frameDocument.documentElement.clientWidth),
                Math.max(frameDocument.documentElement.scrollHeight, frameDocument.documentElement.clientHeight)
            );
            context.fillStyle = '#ffffff';
            context.fillRect(rect.left * pixelRatio, rect.top * pixelRatio, rect.width * pixelRatio, rect.height * pixelRatio);
            context.drawImage(
                frameImage,
                Math.round(frameWindow.scrollX),
                Math.round(frameWindow.scrollY),
                rect.width,
                rect.height,
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

async function renderDocumentToImage(documentElement, width, height) {
    const svgDataUrl = await toSvg(documentElement, {
        width,
        height,
        // the widget must never be part of the screenshot
        filter: (node) => !(node.dataset && node.dataset.codeqFeedback !== undefined),
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
