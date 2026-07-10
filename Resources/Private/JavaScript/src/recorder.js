/**
 * Optional screencast recording via the native Screen Capture API and
 * MediaRecorder. No external library is required; support is feature
 * detected because browsers differ (especially Safari).
 */
const MAXIMUM_DURATION_SECONDS = 90;

export function isScreencastSupported() {
    return Boolean(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
        typeof window.MediaRecorder === 'function'
    );
}

function pickMimeType() {
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || '';
}

/**
 * Starts a screen recording and resolves with a handle exposing stop().
 * The returned promise from stop() (or an automatic stop on the duration
 * cap or when the user ends sharing) resolves with the recorded blob.
 */
export async function startScreencast({ onAutoStop }) {
    // the user explicitly picks screen/window/tab; audio is included when
    // the browser offers tab or system audio in the picker
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

    const mimeType = pickMimeType();
    const recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            chunks.push(event.data);
        }
    };

    let resolveBlob;
    const blobPromise = new Promise((resolve) => {
        resolveBlob = resolve;
    });

    const finish = () => {
        stream.getTracks().forEach((track) => track.stop());
        clearTimeout(durationTimeout);
        resolveBlob(new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' }));
    };
    recorder.onstop = finish;

    // hard cap so recordings stay uploadable within the Asana limits
    const durationTimeout = setTimeout(() => {
        if (recorder.state === 'recording') {
            recorder.stop();
            if (onAutoStop) {
                onAutoStop();
            }
        }
    }, MAXIMUM_DURATION_SECONDS * 1000);

    // stop automatically when the user ends sharing via the browser UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (recorder.state === 'recording') {
            recorder.stop();
            if (onAutoStop) {
                onAutoStop();
            }
        }
    });

    recorder.start(1000);

    return {
        mimeType,
        stop() {
            if (recorder.state === 'recording') {
                recorder.stop();
            }
            return blobPromise;
        },
        blobPromise,
    };
}

export function fileExtensionForMimeType(mimeType) {
    return (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
}
