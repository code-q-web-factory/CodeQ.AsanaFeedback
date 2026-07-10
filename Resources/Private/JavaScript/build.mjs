import * as esbuild from 'esbuild';

// Bundles the widget into self-contained assets that are committed to
// Resources/Public, so deployments do not need a node build step.
await esbuild.build({
    entryPoints: ['src/index.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome100', 'firefox100', 'safari15', 'edge100'],
    outfile: '../../Public/Scripts/Widget.js',
    legalComments: 'linked',
});

await esbuild.build({
    entryPoints: ['src/widget.css'],
    bundle: true,
    minify: true,
    outfile: '../../Public/Styles/Widget.css',
});

console.log('Widget assets built.');
