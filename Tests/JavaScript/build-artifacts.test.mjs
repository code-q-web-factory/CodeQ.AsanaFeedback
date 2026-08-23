import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const frontendBundle = new URL('../../Resources/Public/Scripts/Widget.js', import.meta.url);
const backendBundle = new URL('../../Resources/Public/Backend/Plugin.js', import.meta.url);
const fusionIntegration = new URL('../../Resources/Private/Fusion/Root.fusion', import.meta.url);

test('ships the current capture renderer in both widget bundles', async () => {
    const [frontend, backend] = await Promise.all([
        readFile(frontendBundle, 'utf8'),
        readFile(backendBundle, 'utf8'),
    ]);

    assert.match(frontend, /codeqFeedbackFonts/);
    assert.match(backend, /codeqFeedbackFonts/);
});

test('cache-busts public widget assets with their content hashes', async () => {
    const fusion = await readFile(fusionIntegration, 'utf8');

    assert.match(fusion, /AsanaFeedback\.assetVersion\('resource:\/\/CodeQ\.AsanaFeedback\/Public\/Styles\/Widget\.css'\)/);
    assert.match(fusion, /AsanaFeedback\.assetVersion\('resource:\/\/CodeQ\.AsanaFeedback\/Public\/Scripts\/Widget\.js'\)/);
    assert.match(fusion, /\?bust=/);
});
