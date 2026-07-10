import { toCanvas } from 'html-to-image';

/**
 * Captures the currently visible viewport as a canvas. The whole document
 * is rendered DOM-based via html-to-image and then cropped to the visible
 * area; the feedback widget itself is excluded through the render filter.
 */
export async function captureViewport(excludedRootElement) {
    const documentElement = document.documentElement;
    const fullWidth = Math.max(documentElement.scrollWidth, documentElement.clientWidth);
    const fullHeight = Math.max(documentElement.scrollHeight, documentElement.clientHeight);

    // clamp the pixel ratio so very long pages stay below browser canvas limits
    let pixelRatio = window.devicePixelRatio || 1;
    const maximumCanvasArea = 200000000;
    if (fullWidth * fullHeight * pixelRatio * pixelRatio > maximumCanvasArea) {
        pixelRatio = Math.max(1, Math.floor(Math.sqrt(maximumCanvasArea / (fullWidth * fullHeight)) * 10) / 10);
    }

    const fullCanvas = await toCanvas(documentElement, {
        width: fullWidth,
        height: fullHeight,
        pixelRatio,
        // the widget must never be part of the screenshot
        filter: (node) => node !== excludedRootElement,
        // external images without CORS headers would otherwise abort the capture
        imagePlaceholder:
            'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#dddddd"/></svg>'),
    });

    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = Math.round(window.innerWidth * pixelRatio);
    viewportCanvas.height = Math.round(window.innerHeight * pixelRatio);

    const context = viewportCanvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, viewportCanvas.width, viewportCanvas.height);
    context.drawImage(
        fullCanvas,
        Math.round(window.scrollX * pixelRatio),
        Math.round(window.scrollY * pixelRatio),
        viewportCanvas.width,
        viewportCanvas.height,
        0,
        0,
        viewportCanvas.width,
        viewportCanvas.height
    );

    return viewportCanvas;
}
