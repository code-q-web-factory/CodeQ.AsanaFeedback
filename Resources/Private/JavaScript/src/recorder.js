/**
 * Optional screencast recording via the native Screen Capture API and
 * MediaRecorder. No external library is required; support is feature
 * detected because browsers differ (especially Safari).
 */
const DEFAULT_VIDEO_OPTIONS = {
    width: 1280,
    height: 720,
    idealFrameRate: 20,
    maximumFrameRate: 24,
    videoBitsPerSecond: 2_000_000,
    audioBitsPerSecond: 96_000,
    maximumDurationSeconds: 90,
};

export function isScreencastSupported() {
    return Boolean(
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function' &&
        typeof window.MediaRecorder === 'function'
    );
}

export function pickMimeType() {
    if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
    ];
    return candidates.find((candidate) => window.MediaRecorder.isTypeSupported(candidate)) || '';
}

function stopStreamAndCreateAudioError(stream) {
    stream.getTracks().forEach((track) => track.stop());
    const error = new Error('No audio source is available for the screen recording.');
    error.code = 'audioUnavailable';
    return error;
}

/**
 * Starts a screen recording and resolves with a handle exposing stop().
 * The returned promise from stop() (or an automatic stop on the duration
 * cap or when the user ends sharing) resolves with the recorded blob.
 */
export async function startScreencast({ onAutoStop, onStreamSelected, media = {} } = {}) {
    const options = { ...DEFAULT_VIDEO_OPTIONS, ...media };
    const videoConstraints = {
        width: { ideal: options.width, max: options.width },
        height: { ideal: options.height, max: options.height },
        frameRate: { ideal: options.idealFrameRate, max: options.maximumFrameRate },
    };
    // the user explicitly picks screen/window/tab; compatible browsers are
    // asked to include tab or system audio in the selected surface
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
        systemAudio: 'include',
        surfaceSwitching: 'include',
    });
    if (onStreamSelected) {
        onStreamSelected();
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && typeof videoTrack.applyConstraints === 'function') {
        try {
            await videoTrack.applyConstraints(videoConstraints);
        } catch (error) {
            // Some browsers accept getDisplayMedia constraints but refuse to
            // re-apply them to the selected surface. Recording still works;
            // the configured bitrate remains the final size guard.
            console.warn('CodeQ.AsanaFeedback: video constraints could not be applied', error);
        }
    }

    // Browsers and operating systems do not expose shared audio for every
    // capture surface. Use the microphone when the selected stream has no
    // audio track so the recording still contains an explanation.
    if (stream.getAudioTracks().length === 0 && typeof navigator.mediaDevices.getUserMedia === 'function') {
        let microphoneStream;
        try {
            microphoneStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 48000,
                },
            });
        } catch (error) {
            throw stopStreamAndCreateAudioError(stream);
        }
        const microphoneTracks = microphoneStream.getAudioTracks();
        if (microphoneTracks.length === 0) {
            throw stopStreamAndCreateAudioError(stream);
        }
        microphoneTracks.forEach((track) => stream.addTrack(track));
    }
    if (stream.getAudioTracks().length === 0) {
        throw stopStreamAndCreateAudioError(stream);
    }

    const requestedMimeType = pickMimeType();
    const recorderOptions = {
        ...(requestedMimeType ? { mimeType: requestedMimeType } : {}),
        videoBitsPerSecond: options.videoBitsPerSecond,
        audioBitsPerSecond: options.audioBitsPerSecond,
    };
    let recorder;
    try {
        try {
            recorder = new window.MediaRecorder(stream, recorderOptions);
        } catch (error) {
            // Older Safari versions may support MediaRecorder but reject
            // bitrate hints. Fall back without disabling recording entirely.
            recorder = new window.MediaRecorder(stream, requestedMimeType ? { mimeType: requestedMimeType } : undefined);
        }
    } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        throw error;
    }
    const mimeType = recorder.mimeType || requestedMimeType || 'video/webm';
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
    }, options.maximumDurationSeconds * 1000);

    // stop automatically when the user ends sharing via the browser UI
    stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (recorder.state === 'recording') {
            recorder.stop();
            if (onAutoStop) {
                onAutoStop();
            }
        }
    });

    try {
        recorder.start(1000);
    } catch (error) {
        clearTimeout(durationTimeout);
        stream.getTracks().forEach((track) => track.stop());
        throw error;
    }

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
