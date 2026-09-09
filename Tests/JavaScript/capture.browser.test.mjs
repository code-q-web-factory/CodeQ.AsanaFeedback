import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from '../../Resources/Private/JavaScript/node_modules/esbuild/lib/main.js';
import { chromium } from '../../Resources/Private/JavaScript/node_modules/playwright/index.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDirectory, '../..');
const widgetDirectory = resolve(packageRoot, 'Resources/Private/JavaScript');
const captureModule = resolve(widgetDirectory, 'src/capture.js');
const fontFile = resolve(
    widgetDirectory,
    'node_modules/@fontsource/roboto-condensed/files/roboto-condensed-latin-400-normal.woff2'
);

for (const includeIframes of [false, true]) {
    test(`preserves page icons with ElevenReader injected (${includeIframes ? 'iframe' : 'document'})`, { timeout: 15000 }, async () => {
        const bundle = await build({
            absWorkingDir: widgetDirectory,
            bundle: true,
            format: 'iife',
            platform: 'browser',
            stdin: {
                contents: `import { captureViewport } from ${JSON.stringify(captureModule)}; window.captureViewport = captureViewport;`,
                resolveDir: widgetDirectory,
            },
            write: false,
        });
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 320, height: 200 } });
        try {
            const fixture = `<!doctype html><style>
                body { margin: 0; background: white; font-size: 14px; }
                svg { display: inline-block; height: 1em; overflow: visible; }
            </style><svg data-icon="fixture" viewBox="0 0 448 512"><path fill="#e02020" d="M0 0H448V512H0Z"/></svg>`;
            await page.setContent(includeIframes
                ? '<style>body { margin: 0; } iframe { border: 0; width: 320px; height: 200px; }</style><iframe></iframe>'
                : fixture);
            const target = includeIframes ? page.frames()[1] : page;
            if (includeIframes) {
                await target.setContent(fixture);
            }
            await target.evaluate(() => {
                const extension = document.createElement('div');
                extension.id = 'elevenreader-extension-container';
                // Actual ElevenReader rule: isolated in the page, global when
                // html-to-image flattens the extension's shadow root.
                extension.attachShadow({ mode: 'open' }).innerHTML =
                    '<style>[data-icon],[data-icon]>*{width:36px!important;height:36px!important}</style>';
                document.body.append(extension);
                const component = document.createElement('site-component');
                component.attachShadow({ mode: 'open' }).innerHTML =
                    '<style>#component-path { fill: #2040e0; }</style><svg style="position:absolute;left:80px;top:20px;width:20px;height:20px" viewBox="0 0 20 20"><path id="component-path" d="M0 0H20V20H0Z"/></svg>';
                document.body.append(component);
            });
            const original = await target.locator('svg[data-icon]').boundingBox();
            await page.addScriptTag({ content: bundle.outputFiles[0].text });
            const result = await page.evaluate(async (includeIframes) => {
                const canvas = await window.captureViewport({ includeIframes });
                const context = canvas.getContext('2d');
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                let right = -1;
                let bottom = -1;
                for (let y = 0; y < canvas.height; y += 1) {
                    for (let x = 0; x < canvas.width; x += 1) {
                        const offset = (y * canvas.width + x) * 4;
                        if (pixels[offset] > 160 && pixels[offset + 1] < 80 && pixels[offset + 2] < 80) {
                            right = Math.max(right, x);
                            bottom = Math.max(bottom, y);
                        }
                    }
                }
                return { right, bottom, componentPixel: Array.from(context.getImageData(180, 60, 1, 1).data) };
            }, includeIframes);
            assert.ok(result.right >= 0, 'page icon must remain visible');
            assert.ok(result.right < (original.x + original.width) * 2 + 1,
                `captured icon extends to x=${result.right}, live right=${(original.x + original.width) * 2}`);
            assert.ok(result.bottom < (original.y + original.height) * 2 + 1,
                `captured icon extends to y=${result.bottom}, live bottom=${(original.y + original.height) * 2}`);
            assert.deepEqual(result.componentPixel, [32, 64, 224, 255], 'site shadow content must keep its styles');
            assert.deepEqual(await target.locator('svg[data-icon]').boundingBox(), original, 'capture must not change the live icon');
        } finally {
            await browser.close();
        }
    });
}

test('captures iframe text with the web font used by the live document', { timeout: 15000 }, async () => {
    const bundle = await build({
        absWorkingDir: widgetDirectory,
        bundle: true,
        format: 'iife',
        platform: 'browser',
        stdin: {
            contents: `import { captureViewport } from ${JSON.stringify(captureModule)}; window.captureViewport = captureViewport;`,
            resolveDir: widgetDirectory,
        },
        write: false,
    });
    const font = await readFile(fontFile);
    const browser = await chromium.launch({ headless: true });
    const deviceScaleFactor = 2;
    const page = await browser.newPage({ deviceScaleFactor, viewport: { width: 800, height: 400 } });

    await page.route('http://fonts.test/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/font.woff2') {
            await route.fulfill({
                body: font,
                contentType: 'font/woff2',
                headers: { 'Access-Control-Allow-Origin': '*' },
            });
            return;
        }
        await route.fulfill({
            contentType: 'text/css',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: `@font-face {
                font-family: 'Capture Probe';
                src: url('http://fonts.test/font.woff2') format('woff2');
                font-style: normal;
                font-weight: 400;
            }`,
        });
    });

    await page.route('http://capture.test/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/bundle.js') {
            await route.fulfill({ body: bundle.outputFiles[0].text, contentType: 'text/javascript' });
            return;
        }
        if (pathname === '/image.svg') {
            const variant = new URL(route.request().url()).searchParams.get('variant');
            await route.fulfill({
                contentType: 'image/svg+xml',
                body: variant === 'decoy'
                    ? `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="400" height="160" fill="#20c040"/></svg>`
                    : `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect width="200" height="160" fill="#e02020"/><rect x="200" width="200" height="160" fill="#2040e0"/></svg>`,
            });
            return;
        }
        if (pathname === '/frame') {
            await route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html>
                    <link rel="stylesheet" href="http://fonts.test/kit.css">
                    <style>
                        html, body { margin: 0; background: white; }
                        #target {
                            display: block;
                            margin: 20px;
                            color: black;
                            font: 400 40px/48px 'Capture Probe', sans-serif;
                        }
                        #sentence {
                            position: absolute;
                            left: 20px;
                            top: 180px;
                            color: black;
                            font: 400 20px/30px 'Capture Probe', sans-serif;
                        }
                        #portrait {
                            position: absolute;
                            left: 600px;
                            top: 20px;
                            width: 100px;
                            height: 160px;
                            object-fit: cover;
                            object-position: right center;
                        }
                    </style>
                    <span id="target">Business Areas</span>
                    <span id="sentence">ILF Consulting Engineers was founded by Pius Lasser in 1967.</span>
                    <img id="portrait" alt="" src="/image.svg?variant=portrait">`,
            });
            return;
        }
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html>
                <style>html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; }</style>
                <script src="/bundle.js"></script>
                <iframe src="/frame"></iframe>`,
        });
    });

    try {
        await page.goto('http://capture.test/', { waitUntil: 'commit' });
        const frame = await (await page.waitForSelector('iframe')).contentFrame();
        await frame.waitForURL('**/frame');
        await page.waitForFunction(() => typeof window.captureViewport === 'function');
        const target = await frame.evaluate(async () => {
            await document.fonts.load('400 40px "Capture Probe"');
            const text = document.querySelector('#target');
            const measure = (fontFamily) => {
                const probe = text.cloneNode(true);
                probe.style.cssText = `position:absolute;visibility:hidden;width:max-content;margin:0;font-family:${fontFamily}`;
                document.body.append(probe);
                const width = probe.getBoundingClientRect().width;
                probe.remove();
                return width;
            };
            const webFontWidth = measure('"Capture Probe"');
            const fallbackWidth = measure('sans-serif');
            text.style.width = `${Math.floor((webFontWidth + fallbackWidth) / 2)}px`;
            const rect = text.getBoundingClientRect();
            const sentence = document.querySelector('#sentence');
            const sentenceText = sentence.firstChild;
            const spaceRects = [];
            for (let index = 0; index < sentenceText.data.length; index += 1) {
                if (sentenceText.data[index] !== ' ') {
                    continue;
                }
                const range = document.createRange();
                range.setStart(sentenceText, index);
                range.setEnd(sentenceText, index + 1);
                const spaceRect = range.getBoundingClientRect();
                spaceRects.push({ x: spaceRect.x, y: spaceRect.y, width: spaceRect.width, height: spaceRect.height });
            }
            return {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                lineHeight: 48, webFontWidth, fallbackWidth, spaceRects,
            };
        });
        assert(target.webFontWidth < target.fallbackWidth, 'fixture font must be narrower than its fallback');
        assert.equal(target.height, target.lineHeight, 'fixture must be one line before capture');

        const captureResult = await page.evaluate(async ({ target, deviceScaleFactor }) => {
            const canvas = await window.captureViewport({ includeIframes: true });
            const context = canvas.getContext('2d');
            const pixels = context.getImageData(
                Math.floor(target.x * deviceScaleFactor),
                Math.floor((target.y + target.lineHeight) * deviceScaleFactor),
                Math.ceil(target.width * deviceScaleFactor),
                target.lineHeight * deviceScaleFactor
            ).data;
            let darkPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index] < 80 && pixels[index + 1] < 80 && pixels[index + 2] < 80 && pixels[index + 3] > 0) {
                    darkPixels += 1;
                }
            }
            const spaceDarkPixels = target.spaceRects.slice(0, 5).map((rect) => {
                const inset = Math.min(rect.width / 4, 1);
                const spacePixels = context.getImageData(
                    Math.floor((rect.x + inset) * deviceScaleFactor),
                    Math.floor((rect.y + 2) * deviceScaleFactor),
                    Math.max(1, Math.floor((rect.width - inset * 2) * deviceScaleFactor)),
                    Math.max(1, Math.floor((rect.height - 4) * deviceScaleFactor))
                ).data;
                let count = 0;
                for (let index = 0; index < spacePixels.length; index += 4) {
                    if (spacePixels[index] < 80 && spacePixels[index + 1] < 80 && spacePixels[index + 2] < 80) {
                        count += 1;
                    }
                }
                return count;
            });
            const portraitPixel = Array.from(context.getImageData(
                625 * deviceScaleFactor,
                100 * deviceScaleFactor,
                1,
                1
            ).data);
            const portrait = document.querySelector('iframe').contentDocument.querySelector('#portrait');
            const imageLoaded = new Promise((resolve) => { portrait.onload = resolve; });
            portrait.src = '/image.svg?variant=decoy';
            await imageLoaded;
            const secondCanvas = await window.captureViewport({ includeIframes: true });
            const cacheProbePixel = Array.from(secondCanvas.getContext('2d').getImageData(
                625 * deviceScaleFactor,
                100 * deviceScaleFactor,
                1,
                1
            ).data);
            return { darkPixels, spaceDarkPixels, portraitPixel, cacheProbePixel };
        }, { target, deviceScaleFactor });

        assert.equal(captureResult.darkPixels, 0, 'captured text wrapped because the web font was replaced');
        assert.ok(
            captureResult.spaceDarkPixels.every((count) => count <= 8),
            `captured words overlap their spaces: ${captureResult.spaceDarkPixels.join(', ')}`
        );
        assert.ok(
            captureResult.portraitPixel[2] > 180 && captureResult.portraitPixel[0] < 80,
            `captured image ignored object-fit/object-position: ${captureResult.portraitPixel.join(', ')}`
        );
        assert.ok(
            captureResult.cacheProbePixel[1] > 160 && captureResult.cacheProbePixel[2] < 100,
            `captured images with distinct query strings shared a cache entry: ${captureResult.cacheProbePixel.join(', ')}`
        );
    } finally {
        await browser.close();
    }
});
