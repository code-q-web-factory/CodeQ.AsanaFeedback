import { toSvg } from 'html-to-image';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';

/**
 * Captures the currently visible viewport as a canvas. The whole document
 * is rendered DOM-based via html-to-image into an SVG, sanitized (see
 * below), rasterized and then cropped to the visible area; the feedback
 * widget itself is excluded through the render filter.
 */
export async function captureViewport(excludedRootElement) {
    const documentElement = document.documentElement;
    const fullWidth = Math.max(documentElement.scrollWidth, documentElement.clientWidth);
    const fullHeight = Math.max(documentElement.scrollHeight, documentElement.clientHeight);

    const svgDataUrl = await toSvg(documentElement, {
        width: fullWidth,
        height: fullHeight,
        // the widget must never be part of the screenshot
        filter: (node) => node !== excludedRootElement,
        // external images without CORS headers would otherwise abort the capture
        imagePlaceholder:
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#dddddd"/></svg>'),
    });

    const sanitizedMarkup = sanitizeSvgMarkup(decodeURIComponent(svgDataUrl.substring(SVG_DATA_URL_PREFIX.length)));
    const pageImage = await loadImage(SVG_DATA_URL_PREFIX + encodeURIComponent(sanitizedMarkup));

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

    return viewportCanvas;
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
