import assert from 'node:assert/strict';
import test from 'node:test';

import { widgetOptionsForConfigElement } from '../../Resources/Private/JavaScript/src/bootstrap.js';

test('uses the regular frontend capture mode by default', () => {
    assert.deepEqual(widgetOptionsForConfigElement({ dataset: {} }), {
        floatingButton: true,
        includeIframes: false,
    });
});

test('allows static frontend hosts to include same-origin iframes', () => {
    assert.deepEqual(widgetOptionsForConfigElement({
        dataset: { includeIframes: 'true' },
    }), {
        floatingButton: true,
        includeIframes: true,
    });
});
