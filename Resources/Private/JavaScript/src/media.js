const DEFAULT_SCREENSHOT_OPTIONS = {
    mimeTypes: ['image/jpeg', 'image/png'],
    quality: 0.8,
};

const FILE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
};

function encodeCanvas(canvas, mimeType, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

/**
 * Encodes an opaque feedback screenshot in a compact browser-supported
 * format. The capture canvas has a white background, so JPEG does not
 * discard meaningful transparency. PNG remains the lossless fallback.
 */
export async function createOptimizedScreenshot(canvas, options = {}) {
    const mimeTypes = Array.isArray(options.mimeTypes) && options.mimeTypes.length > 0
        ? options.mimeTypes
        : DEFAULT_SCREENSHOT_OPTIONS.mimeTypes;
    const quality = Number.isFinite(options.quality) ? options.quality : DEFAULT_SCREENSHOT_OPTIONS.quality;

    for (const mimeType of mimeTypes) {
        const blob = await encodeCanvas(canvas, mimeType, quality);
        if (!blob || blob.size === 0 || blob.type !== mimeType) {
            continue;
        }

        return {
            blob,
            fileName: `screenshot.${FILE_EXTENSIONS[mimeType] || 'bin'}`,
        };
    }

    throw new Error('The screenshot canvas could not be encoded in a supported format.');
}

export function assertFileSize(blob, maximumBytes) {
    if (!blob || blob.size === 0) {
        const error = new Error('The generated file is empty.');
        error.errorCode = 'validation';
        throw error;
    }
    if (blob.size > maximumBytes) {
        const error = new Error('The generated file exceeds the configured upload limit.');
        error.errorCode = 'fileTooLarge';
        throw error;
    }
}
