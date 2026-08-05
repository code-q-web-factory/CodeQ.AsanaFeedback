import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFontEmbedCss } from '../../Resources/Private/JavaScript/src/fonts.js';

test('waits for and embeds fonts from the document being captured', async () => {
    const originalCssRule = globalThis.CSSRule;
    const originalDocument = globalThis.document;
    let resolveFonts;
    const styleSheet = { cssRules: [] };
    const capturedDocument = {
        baseURI: 'https://preview.example.test/',
        fonts: {
            ready: new Promise((resolve) => {
                resolveFonts = resolve;
            }),
        },
        styleSheets: [styleSheet],
    };

    globalThis.CSSRule = { FONT_FACE_RULE: 5 };
    globalThis.document = {
        baseURI: 'https://manager.example.test/',
        styleSheets: [{
            cssRules: [{ type: 5, cssText: '@font-face { font-family: "Manager Font"; src: local("Arial"); }' }],
        }],
    };

    try {
        let settled = false;
        const fontEmbedCssPromise = buildFontEmbedCss(capturedDocument).then((fontEmbedCss) => {
            settled = true;
            return fontEmbedCss;
        });

        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);

        styleSheet.cssRules.push({
            type: 5,
            cssText: '@font-face { font-family: "Preview Font"; src: local("Preview Font"); }',
        });
        resolveFonts();

        const fontEmbedCss = await fontEmbedCssPromise;

        assert.match(fontEmbedCss, /Preview Font/);
        assert.doesNotMatch(fontEmbedCss, /Manager Font/);
    } finally {
        if (originalCssRule === undefined) {
            delete globalThis.CSSRule;
        } else {
            globalThis.CSSRule = originalCssRule;
        }
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
    }
});
