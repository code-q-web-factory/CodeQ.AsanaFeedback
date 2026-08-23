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
                    </style>
                    <span id="target">Business Areas</span>
                    <span id="sentence">ILF Consulting Engineers was founded by Pius Lasser in 1967.</span>`,
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
            return { darkPixels, spaceDarkPixels };
        }, { target, deviceScaleFactor });

        assert.equal(captureResult.darkPixels, 0, 'captured text wrapped because the web font was replaced');
        assert.ok(
            captureResult.spaceDarkPixels.every((count) => count <= 8),
            `captured words overlap their spaces: ${captureResult.spaceDarkPixels.join(', ')}`
        );
    } finally {
        await browser.close();
    }
});
