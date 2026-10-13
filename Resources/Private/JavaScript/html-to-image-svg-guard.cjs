const { readFile } = require('node:fs/promises');

// html-to-image 1.11.13 treats external SVG URLs as CSS selectors.
// External symbols are embedded later in the isolated screenshot markup.
module.exports = {
    name: 'html-to-image-svg-guard',
    setup(build) {
        build.onLoad({ filter: /html-to-image\/es\/clone-node\.js$/ }, async ({ path }) => {
            const source = await readFile(path, 'utf8');
            const original = "if (id) {\n            const exist = clone.querySelector(id);";
            if (source.split(original).length !== 2) {
                throw new Error('Review the SVG selector guard after updating html-to-image.');
            }
            return {
                contents: source.replace(original,
                    "if (id && id.startsWith('#')) {\n            const exist = clone.querySelector(id);"),
                loader: 'js',
            };
        });
    },
};
