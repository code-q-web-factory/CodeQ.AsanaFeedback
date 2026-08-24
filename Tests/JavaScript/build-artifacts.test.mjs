import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const frontendBundle = new URL('../../Resources/Public/Scripts/Widget.js', import.meta.url);
const backendBundle = new URL('../../Resources/Public/Backend/Plugin.js', import.meta.url);
const fusionIntegration = new URL('../../Resources/Private/Fusion/Root.fusion', import.meta.url);
const frontendController = new URL('../../Classes/Controller/FeedbackController.php', import.meta.url);

test('ships the current capture renderer in both widget bundles', async () => {
    const [frontend, backend] = await Promise.all([
        readFile(frontendBundle, 'utf8'),
        readFile(backendBundle, 'utf8'),
    ]);

    for (const bundle of [frontend, backend]) {
        assert.match(bundle, /fontEmbedCSS/);
        assert.match(bundle, /foreignObject/);
        assert.doesNotMatch(bundle, /html2canvas/);
    }
});

test('cache-busts public widget assets with their content hashes', async () => {
    const [fusion, controller] = await Promise.all([
        readFile(fusionIntegration, 'utf8'),
        readFile(frontendController, 'utf8'),
    ]);

    assert.match(fusion, /AsanaFeedback\.assetVersion\('resource:\/\/CodeQ\.AsanaFeedback\/Public\/Styles\/Widget\.css'\)/);
    assert.match(fusion, /AsanaFeedback\.assetVersion\('resource:\/\/CodeQ\.AsanaFeedback\/Public\/Scripts\/Widget\.js'\)/);
    assert.match(fusion, /\?bust=/);
    assert.match(controller, /frontendAssetUrls\(\)/);
});
