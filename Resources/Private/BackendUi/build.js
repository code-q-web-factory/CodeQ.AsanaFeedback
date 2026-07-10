const esbuild = require('esbuild');

// Bundles the Neos backend toolbar plugin; the extensibility alias map
// redirects react etc. to the instances provided by the Neos UI host.
esbuild.build({
    logLevel: 'info',
    bundle: true,
    minify: true,
    target: 'es2020',
    entryPoints: { Plugin: 'src/index.js' },
    loader: { '.js': 'jsx' },
    alias: require('@neos-project/neos-ui-extensibility/extensibilityMap.json'),
    outdir: '../../Public/Backend',
});
