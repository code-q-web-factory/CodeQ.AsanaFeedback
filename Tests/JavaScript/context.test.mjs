import assert from 'node:assert/strict';
import test from 'node:test';

import { collectTechnicalContext, getNeosContentCanvasUrl } from '../../Resources/Private/JavaScript/src/context.js';

test('reads the live URL from the Neos content canvas', () => {
    const contentCanvas = {
        contentWindow: {
            location: {
                href: 'https://example.com/de/content-page?foo=bar',
            },
        },
    };
    const document = {
        querySelector(selector) {
            assert.equal(selector, 'iframe[name="neos-content-main"]');
            return contentCanvas;
        },
    };

    assert.equal(
        getNeosContentCanvasUrl(document),
        'https://example.com/de/content-page?foo=bar'
    );
});

test('does not add a content canvas URL outside the Neos backend', () => {
    const document = {
        querySelector() {
            return null;
        },
    };

    assert.equal(getNeosContentCanvasUrl(document), '');
});

test('adds the content canvas URL to the collected technical context', (context) => {
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            userAgent: 'Mozilla/5.0 Firefox/141.0',
            language: 'de-AT',
        },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            innerWidth: 1280,
            innerHeight: 800,
            screen: { width: 1920, height: 1080 },
            devicePixelRatio: 2,
        },
    });
    context.after(() => {
        delete globalThis.navigator;
        delete globalThis.window;
    });

    const technicalContext = collectTechnicalContext({
        contentCanvasUrl: 'https://example.com/de/content-page',
    });

    assert.equal(technicalContext.contentCanvasUrl, 'https://example.com/de/content-page');
});
