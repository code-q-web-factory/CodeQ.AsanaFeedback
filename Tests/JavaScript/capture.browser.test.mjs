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

test('captures iframe text with the web font used by the live document', async () => {
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
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 800, height: 400 } });

    await page.route('http://capture.test/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/bundle.js') {
            await route.fulfill({ body: bundle.outputFiles[0].contents, contentType: 'text/javascript' });
            return;
        }
        if (pathname === '/font.woff2') {
            await route.fulfill({ body: font, contentType: 'font/woff2' });
            return;
        }
        if (pathname === '/frame') {
            await route.fulfill({
                contentType: 'text/html',
                body: `<!doctype html>
                    <style>
                        @font-face {
                            font-family: 'Capture Probe';
                            src: url('/font.woff2') format('woff2');
                            font-style: normal;
                            font-weight: 400;
                        }
                        html, body { margin: 0; background: white; }
                        #target {
                            display: block;
                            margin: 20px;
                            color: black;
                            font: 400 40px/48px 'Capture Probe', sans-serif;
                        }
                    </style>
                    <span id="target">Business Areas</span>`,
            });
            return;
        }
        await route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html>
                <style>html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; }</style>
                <iframe src="/frame"></iframe>
                <script src="/bundle.js"></script>`,
        });
    });

    try {
        await page.goto('http://capture.test/');
        const frame = page.frames().find((candidate) => candidate.url().endsWith('/frame'));
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
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, lineHeight: 48, webFontWidth, fallbackWidth };
        });
        assert(target.webFontWidth < target.fallbackWidth, 'fixture font must be narrower than its fallback');
        assert.equal(target.height, target.lineHeight, 'fixture must be one line before capture');

        const secondLinePixels = await page.evaluate(async ({ target }) => {
            const canvas = await window.captureViewport({ includeIframes: true });
            const context = canvas.getContext('2d');
            const pixels = context.getImageData(
                Math.floor(target.x),
                Math.floor(target.y + target.lineHeight),
                Math.ceil(target.width),
                target.lineHeight
            ).data;
            let darkPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index] < 80 && pixels[index + 1] < 80 && pixels[index + 2] < 80 && pixels[index + 3] > 0) {
                    darkPixels += 1;
                }
            }
            return darkPixels;
        }, { target });

        assert.equal(secondLinePixels, 0, 'captured text wrapped because the web font was replaced');
    } finally {
        await browser.close();
    }
});
