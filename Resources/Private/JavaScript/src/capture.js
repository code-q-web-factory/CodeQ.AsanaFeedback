import { toSvg } from 'html-to-image';

import { buildFontEmbedCss } from './fonts';

const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const IMAGE_PLACEHOLDER = SVG_DATA_URL_PREFIX + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#dddddd"/></svg>'
);

/**
 * Captures the currently visible viewport as a canvas through a sanitized
 * html-to-image SVG. Web fonts are embedded before rendering so the browser
 * keeps the live document's text and image layout. Elements carrying a
 * data-codeq-feedback attribute (the widget itself) are excluded.
 *
 * With "includeIframes" the visible same-origin iframes are rendered
 * separately and composited into the result. Their contents must not also
 * be flattened into the parent document, where fixed elements would use
 * the backend viewport instead of the iframe viewport.
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
        includeIframes
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

async function renderDocument(documentElement, width, height, fontEmbedCss = '', excludeIframeContents = false) {
    return { image: await renderDocumentToImage(documentElement, width, height, fontEmbedCss, excludeIframeContents), scale: 1 };
}

async function renderDocumentToImage(documentElement, width, height, fontEmbedCss, excludeIframeContents) {
    const objectImages = captureObjectImages(documentElement);
    const svgStyles = captureSvgStyles(documentElement);
    const zeroFontSelectors = captureZeroFontSelectors(documentElement);
    const fixedPositions = captureFixedPositions(documentElement, width, height);
    const svgDataUrl = await toSvg(documentElement, {
        width,
        height,
        // Exclude feedback and browser-extension UI. html-to-image flattens
        // shadow roots: ElevenReader's [data-icon] !important rule would then
        // resize Neos icons to 36px. Keep the extension's entire subtree out
        // rather than stripping styles needed by the site's web components.
        // Keep the iframe's sized shell in the layout, but leave its foreign
        // document's descendants to compositeVisibleIframes. html-to-image
        // otherwise clones them into the parent, leaking fixed elements and CSS.
        // SVG rendering disables scripts, which would expose noscript fallbacks.
        filter: (node) => (!excludeIframeContents || node.ownerDocument === documentElement.ownerDocument) &&
            // HTML debug comments can contain double hyphens, which are invalid XML.
            node.nodeType !== Node.COMMENT_NODE &&
            !(node.dataset && node.dataset.codeqFeedback !== undefined) &&
            node.nodeName !== 'NOSCRIPT' &&
            // A zero-sized video produces an invalid data:, image in html-to-image.
            (node.nodeName !== 'VIDEO' || (node.clientWidth > 0 && node.clientHeight > 0)) &&
            node.id !== 'elevenreader-extension-container',
        // precomputed web-font CSS; passing it (even empty) stops html-to-image
        // from scanning the live stylesheets and erroring on cross-origin sheets
        fontEmbedCSS: fontEmbedCss,
        // external images without CORS headers would otherwise abort the capture
        imagePlaceholder: IMAGE_PLACEHOLDER,
        onImageErrorHandler: (event) => {
            const image = event.target;
            if (image?.tagName !== 'IMG' || image.parentElement?.tagName !== 'PICTURE') {
                throw event;
            }
            // The cloned picture's sources can override the embedded fallback.
            // Only alter this failed clone, never the live responsive image.
            return new Promise((resolve, reject) => {
                image.onload = resolve;
                image.onerror = () => reject(new Error('The fallback image could not be loaded.'));
                image.parentElement.querySelectorAll('source').forEach(source => source.remove());
                image.src = IMAGE_PLACEHOLDER;
            });
        },
        // Next.js serves every optimized image through /_next/image and uses
        // only the query string to identify the source. Stripping it makes
        // unrelated images share one html-to-image cache entry.
        includeQueryParams: true,
    });

    const sanitizedMarkup = await sanitizeSvgMarkup(
        decodeURIComponent(svgDataUrl.substring(SVG_DATA_URL_PREFIX.length)), documentElement.ownerDocument.baseURI,
        objectImages, svgStyles, zeroFontSelectors, fixedPositions
    );

    return loadImage(SVG_DATA_URL_PREFIX + encodeURIComponent(sanitizedMarkup));
}

/**
 * Frontend frameworks like Alpine.js use attribute names ("x-on:click",
 * "@click", ":class") that are invalid XML. Inside the serialized SVG
 * foreignObject they would be treated as undefined namespace prefixes and
 * the whole image would refuse to load, so they are stripped. Attribute
 * values are XML-escaped by the serializer, quotes cannot occur inside.
 */
/** Preserve loaded SVG object styles before turning the object into an image. */
function captureObjectImages(documentElement) {
    const images = new Map();
    for (const object of documentElement.querySelectorAll('object[type="image/svg+xml"][data]')) {
        try {
            const svg = object.contentDocument?.documentElement;
            if (svg?.localName !== 'svg') continue;
            const clone = svg.cloneNode(true);
            const originals = [svg, ...svg.querySelectorAll('*')];
            const copies = [clone, ...clone.querySelectorAll('*')];
            originals.forEach((element, index) => {
                const style = object.contentDocument.defaultView.getComputedStyle(element);
                copies[index].setAttribute('style', Array.from(style)
                    .map(property => `${property}:${style.getPropertyValue(property)}`).join(';'));
            });
            images.set(new URL(object.getAttribute('data'), object.ownerDocument.baseURI).href,
                SVG_DATA_URL_PREFIX + encodeURIComponent(new XMLSerializer().serializeToString(clone)));
        } catch (objectError) {
            // Cross-origin objects fall back to fetching their image resource.
        }
    }
    return images;
}

function svgStyleKey(svg) {
    return JSON.stringify([svg.getAttribute('id'), svg.getAttribute('class'), svg.getAttribute('viewBox'),
        Array.from(svg.querySelectorAll('path')).map(path => path.getAttribute('d'))]);
}

/** html-to-image deep-clones SVG children without their computed CSS. */
function captureSvgStyles(documentElement) {
    const snapshots = new Map();
    for (const svg of documentElement.querySelectorAll('svg')) {
        if (svg.closest('[data-codeq-feedback], #elevenreader-extension-container')) continue;
        const key = svgStyleKey(svg);
        const styles = Array.from(svg.querySelectorAll('*')).map(element => {
            const style = element.ownerDocument.defaultView.getComputedStyle(element);
            return Array.from(style).map(property => `${property}:${style.getPropertyValue(property)}`).join(';');
        });
        if (!snapshots.has(key)) snapshots.set(key, []);
        snapshots.get(key).push(styles);
    }
    return snapshots;
}

/** html-to-image rounds 0px to an invalid negative font size, exposing icon labels. */
function captureZeroFontSelectors(documentElement) {
    const selectors = new Set();
    const view = documentElement.ownerDocument.defaultView;
    const selectorFor = element => element.localName + (element.id
        ? `#${CSS.escape(element.id)}`
        : Array.from(element.classList).map(name => `.${CSS.escape(name)}`).join(''));
    for (const element of documentElement.querySelectorAll('*')) {
        if (view.getComputedStyle(element).fontSize !== '0px') continue;
        let selector = selectorFor(element);
        let ancestor = element.parentElement;
        while (!Array.from(documentElement.querySelectorAll(selector))
            .every(match => view.getComputedStyle(match).fontSize === '0px')) {
            if (!ancestor) { selector = null; break; }
            selector = `${selectorFor(ancestor)} > ${selector}`;
            ancestor = ancestor.parentElement;
        }
        if (selector) selectors.add(selector);
    }
    return selectors;
}

function captureFixedPositions(documentElement, width, height) {
    const positions = new Map();
    const view = documentElement.ownerDocument.defaultView;
    const offsets = {
        top: view.scrollY, left: view.scrollX,
        bottom: height - documentElement.clientHeight - view.scrollY,
        right: width - documentElement.clientWidth - view.scrollX,
    };
    const selectorFor = element => element.localName + (element.id
        ? `#${CSS.escape(element.id)}`
        : Array.from(element.classList).map(name => `.${CSS.escape(name)}`).join(''));
    for (const element of documentElement.querySelectorAll('*')) {
        const style = view.getComputedStyle(element);
        if (style.position !== 'fixed' || element.closest('[data-codeq-feedback], #elevenreader-extension-container')) continue;
        let ancestor = element.parentElement;
        let transformedParent = false;
        while (ancestor) {
            const parentStyle = view.getComputedStyle(ancestor);
            if (parentStyle.transform !== 'none' || parentStyle.perspective !== 'none' || parentStyle.filter !== 'none') {
                transformedParent = true;
                break;
            }
            ancestor = ancestor.parentElement;
        }
        if (transformedParent) continue;
        let selector = selectorFor(element);
        ancestor = element.parentElement;
        while (documentElement.querySelectorAll(selector).length > 1 && ancestor) {
            selector = `${selectorFor(ancestor)} > ${selector}`;
            ancestor = ancestor.parentElement;
        }
        if (documentElement.querySelectorAll(selector).length !== 1) continue;
        const insets = {};
        for (const [property, offset] of Object.entries(offsets)) {
            const value = Number.parseFloat(style.getPropertyValue(property));
            if (Number.isFinite(value)) insets[property] = `${value + offset}px`;
        }
        positions.set(selector, insets);
    }
    return positions;
}

async function sanitizeSvgMarkup(svgMarkup, baseURI, objectImages, svgStyles, zeroFontSelectors, fixedPositions) {
    // Legacy rich text can contain control characters that XML cannot represent.
    let sanitizedMarkup = svgMarkup.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
        .replace(/\s(?:x-[\w-]+:|@|:)[^\s=]*="[^"]*"/g, ' ');

    let parsed = new DOMParser().parseFromString(sanitizedMarkup, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) {
        // last resort: strip every attribute with an unknown namespace prefix
        sanitizedMarkup = sanitizedMarkup.replace(/\s(?!xml:|xmlns:|xmlns=|xlink:)[\w-]+:[\w.-]+="[^"]*"/g, ' ');
        parsed = new DOMParser().parseFromString(sanitizedMarkup, 'image/svg+xml');
    }

    // Responsive sources must not override the embedded img inside the SVG.
    if (!parsed.querySelector('parsererror')) {
        // The full-page SVG has no scroll offset and a taller fixed-position viewport.
        for (const [selector, insets] of fixedPositions) {
            for (const element of parsed.querySelectorAll(selector)) {
                for (const [property, value] of Object.entries(insets)) element.style?.setProperty(property, value);
            }
        }
        for (const selector of zeroFontSelectors) {
            parsed.querySelectorAll(selector).forEach(element => element.style?.setProperty('font-size', '0px'));
        }
        for (const svg of parsed.querySelectorAll('foreignObject svg')) {
            const styles = svgStyles.get(svgStyleKey(svg))?.shift();
            const elements = Array.from(svg.querySelectorAll('*'));
            if (styles?.length === elements.length) elements.forEach((element, index) => {
                if (styles[index]) element.setAttribute('style', styles[index]);
            });
        }
        parsed.querySelectorAll('picture > source').forEach(source => source.remove());
        await embedExternalSvgSymbols(parsed, baseURI);
        // SVG foreignObject cannot display HTML object images; embed an img instead.
        for (const object of parsed.querySelectorAll('object[type^="image/"][data]')) {
            const image = parsed.createElementNS('http://www.w3.org/1999/xhtml', 'img');
            for (const attribute of object.attributes) {
                if (!['data', 'type'].includes(attribute.name)) image.setAttribute(attribute.name, attribute.value);
            }
            let source = IMAGE_PLACEHOLDER;
            try {
                const url = new URL(object.getAttribute('data'), baseURI);
                const embedded = objectImages.get(url.href);
                if (embedded) {
                    source = embedded;
                } else {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error('The object image could not be fetched.');
                    const blob = await response.blob();
                    source = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                }
            } catch (imageError) {
                // Missing local media uses the same fallback as regular images.
            }
            image.setAttribute('src', source);
            object.replaceWith(image);
        }
        return new XMLSerializer().serializeToString(parsed);
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

async function embedExternalSvgSymbols(parsed, baseURI) {
    const resources = new Map();
    let symbolIndex = 0;
    for (const use of parsed.querySelectorAll('use')) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href');
        if (!href || href.startsWith('#')) continue;
        try {
            const url = new URL(href, baseURI);
            if (url.origin !== new URL(baseURI).origin || !url.hash) throw new Error('Unsupported SVG symbol URL.');
            const symbolId = decodeURIComponent(url.hash.substring(1));
            url.hash = '';
            if (!resources.has(url.href)) {
                resources.set(url.href, fetch(url).then(async response => {
                    if (!response.ok) throw new Error('The SVG sprite could not be fetched.');
                    return new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
                }));
            }
            const resource = await resources.get(url.href);
            const definition = resource.getElementById(symbolId);
            const svg = use.closest('svg');
            if (!definition || !svg || resource.querySelector('parsererror')) throw new Error('The SVG symbol is missing.');
            const copy = parsed.importNode(definition, true);
            let id;
            do { id = `codeq-capture-symbol-${symbolIndex++}`; } while (parsed.getElementById(id));
            copy.setAttribute('id', id);
            const defs = parsed.createElementNS('http://www.w3.org/2000/svg', 'defs');
            defs.appendChild(copy);
            svg.appendChild(defs);
            use.setAttribute('href', `#${id}`);
            use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${id}`);
        } catch (symbolError) {
            // An unavailable icon must not prevent the rest of the page capture.
            use.remove();
        }
    }
}
