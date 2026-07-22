import assert from 'node:assert/strict';
import test from 'node:test';

import { startScreencast } from '../../Resources/Private/JavaScript/src/recorder.js';

function createTrack(kind) {
    return {
        kind,
        stopped: false,
        appliedConstraints: null,
        addEventListener() {},
        async applyConstraints(constraints) {
            this.appliedConstraints = constraints;
        },
        stop() {
            this.stopped = true;
        },
    };
}

function createStream(tracks) {
    return {
        tracks,
        addTrack(track) {
            this.tracks.push(track);
        },
        getTracks() {
            return this.tracks;
        },
        getVideoTracks() {
            return this.tracks.filter((track) => track.kind === 'video');
        },
        getAudioTracks() {
            return this.tracks.filter((track) => track.kind === 'audio');
        },
    };
}

test('screen recording requests shared audio and falls back to microphone audio', async (context) => {
    const events = [];
    const displayStream = createStream([createTrack('video')]);
    const microphoneTrack = createTrack('audio');
    const microphoneStream = createStream([microphoneTrack]);
    let displayOptions;
    let microphoneOptions;
    let recorderOptions;
    let maximumDurationMilliseconds;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    class FakeMediaRecorder {
        static isTypeSupported() {
            return true;
        }

        constructor(stream, options) {
            this.stream = stream;
            recorderOptions = options;
            this.state = 'inactive';
            this.mimeType = options.mimeType;
        }

        start(timeslice) {
            this.state = 'recording';
            this.timeslice = timeslice;
        }

        stop() {
            this.state = 'inactive';
            this.ondataavailable({ data: new Blob(['recording'], { type: 'video/webm' }) });
            this.onstop();
        }
    }

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            mediaDevices: {
                async getDisplayMedia(options) {
                    events.push('display-selected');
                    displayOptions = options;
                    return displayStream;
                },
                async getUserMedia(options) {
                    events.push('microphone-selected');
                    microphoneOptions = options;
                    return microphoneStream;
                },
            },
        },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { MediaRecorder: FakeMediaRecorder },
    });
    globalThis.setTimeout = (callback, milliseconds) => {
        maximumDurationMilliseconds = milliseconds;
        return 1;
    };
    globalThis.clearTimeout = () => {};
    context.after(() => {
        delete globalThis.navigator;
        delete globalThis.window;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    });

    const handle = await startScreencast({
        onStreamSelected: () => events.push('modal-hidden'),
    });

    assert.equal(displayOptions.audio, true);
    assert.equal(displayOptions.systemAudio, 'include');
    assert.deepEqual(displayOptions.video, {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 20, max: 24 },
    });
    assert.deepEqual(displayStream.getVideoTracks()[0].appliedConstraints, displayOptions.video);
    assert.deepEqual(microphoneOptions, {
        audio: {
            channelCount: 1,
            sampleRate: 48000,
        },
    });
    assert.equal(recorderOptions.videoBitsPerSecond, 2_000_000);
    assert.equal(recorderOptions.audioBitsPerSecond, 96_000);
    assert.equal(maximumDurationMilliseconds, 90_000);
    assert.deepEqual(events, ['display-selected', 'modal-hidden', 'microphone-selected']);
    assert.deepEqual(displayStream.getAudioTracks(), [microphoneTrack]);

    const blob = await handle.stop();
    assert.equal(blob.type, 'video/webm');
    assert.equal(blob.size > 0, true);
    assert.equal(displayStream.getTracks().every((track) => track.stopped), true);
});

test('screen recording stops when no audio source is available', async (context) => {
    const videoTrack = createTrack('video');
    const displayStream = createStream([videoTrack]);

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            mediaDevices: {
                async getDisplayMedia() {
                    return displayStream;
                },
                async getUserMedia() {
                    throw new Error('Microphone permission denied');
                },
            },
        },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            MediaRecorder: class {
                static isTypeSupported() {
                    return true;
                }

                constructor() {
                    throw new Error('Recorder should not start without audio');
                }
            },
        },
    });
    context.after(() => {
        delete globalThis.navigator;
        delete globalThis.window;
    });

    await assert.rejects(
        startScreencast(),
        (error) => error.code === 'audioUnavailable'
    );
    assert.equal(videoTrack.stopped, true);
});

test('screen recording stops all tracks when MediaRecorder cannot start', async (context) => {
    const videoTrack = createTrack('video');
    const audioTrack = createTrack('audio');
    const displayStream = createStream([videoTrack, audioTrack]);

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { async getDisplayMedia() { return displayStream; } } },
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            MediaRecorder: class {
                constructor() {
                    this.mimeType = 'video/webm';
                    this.state = 'inactive';
                }

                start() {
                    throw new Error('Encoder unavailable');
                }
            },
        },
    });
    context.after(() => {
        delete globalThis.navigator;
        delete globalThis.window;
    });

    await assert.rejects(startScreencast(), /Encoder unavailable/);
    assert.equal(videoTrack.stopped, true);
    assert.equal(audioTrack.stopped, true);
});
