import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFileSize, createOptimizedScreenshot } from '../../Resources/Private/JavaScript/src/media.js';

test('encodes feedback screenshots as JPEG at quality 0.8', async () => {
    const calls = [];
    const canvas = {
        toBlob(callback, mimeType, quality) {
            calls.push({ mimeType, quality });
            callback(new Blob(['compressed'], { type: mimeType }));
        },
    };

    const screenshot = await createOptimizedScreenshot(canvas);

    assert.deepEqual(calls, [{ mimeType: 'image/jpeg', quality: 0.8 }]);
    assert.equal(screenshot.blob.type, 'image/jpeg');
    assert.equal(screenshot.fileName, 'screenshot.jpg');
});

test('falls back to PNG when the JPEG encoder is unavailable', async () => {
    const canvas = {
        toBlob(callback) {
            // simulate a browser whose canvas only produces PNG
            callback(new Blob(['fallback'], { type: 'image/png' }));
        },
    };

    const screenshot = await createOptimizedScreenshot(canvas);

    assert.equal(screenshot.blob.type, 'image/png');
    assert.equal(screenshot.fileName, 'screenshot.png');
});

test('rejects files above the client-side upload limit', () => {
    assert.throws(
        () => assertFileSize({ size: 95_000_001 }, 95_000_000),
        (error) => error.errorCode === 'fileTooLarge'
    );
});
