import assert from 'node:assert/strict';
import test from 'node:test';

import { startScreencast } from '../../Resources/Private/JavaScript/src/recorder.js';

function createTrack(kind) {
    return {
        kind,
        stopped: false,
        addEventListener() {},
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

    class FakeMediaRecorder {
        static isTypeSupported() {
            return true;
        }

        constructor(stream) {
            this.stream = stream;
            this.state = 'inactive';
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
    context.after(() => {
        delete globalThis.navigator;
        delete globalThis.window;
    });

    const handle = await startScreencast({
        onStreamSelected: () => events.push('modal-hidden'),
    });

    assert.equal(displayOptions.audio, true);
    assert.equal(displayOptions.systemAudio, 'include');
    assert.deepEqual(microphoneOptions, { audio: true });
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
