import assert from 'node:assert/strict';
import test from 'node:test';

import {
    messageForSubmissionError,
    submitFeedbackDirect,
} from '../../Resources/Private/JavaScript/src/submission.js';

test('uses the relay error message for the user', () => {
    const message = messageForSubmissionError({
        errorCode: 'asanaConfiguration',
        message: 'The feedback relay has no Asana access token configured.',
    }, {
        errorGeneric: 'Generic error',
        errorConfiguration: 'Generic configuration error',
    });

    assert.equal(message, 'The feedback relay has no Asana access token configured.');
});

test('prepares metadata in Neos and uploads binary files directly to the relay', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
            return {
                ok: true,
                async json() {
                    return {
                        success: true,
                        uploadUrl: 'https://feedback.example/upload?action=upload&cors=policy',
                        uploadToken: 'opaque-upload-token',
                        idempotencyKey: 'submission-1234',
                    };
                },
            };
        }
        return {
            ok: true,
            async json() {
                return { success: true, taskUrl: null, warnings: [] };
            },
        };
    };

    const screenshot = {
        blob: new Blob(['webp-image'], { type: 'image/webp' }),
        fileName: 'screenshot.webp',
    };
    const video = {
        blob: new Blob(['webm-video'], { type: 'video/webm' }),
        fileName: 'screencast.webm',
    };

    const result = await submitFeedbackDirect({
        prepareUrl: '/codeq-asana-feedback/prepare',
        submission: { submissionId: 'submission-1234', description: 'Broken navigation' },
        screenshot,
        video,
        fetchImpl,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/codeq-asana-feedback/prepare');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        submissionId: 'submission-1234',
        description: 'Broken navigation',
    });
    assert.equal(calls[1].url, 'https://feedback.example/upload?action=upload&cors=policy');
    assert.equal(calls[1].options.credentials, 'omit');
    assert.equal(calls[1].options.mode, 'cors');
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(calls[1].options.headers['X-Idempotency-Key'], 'submission-1234');
    assert.equal(calls[1].options.body.get('uploadGrant').type, 'application/vnd.codeq.feedback-grant');
    assert.equal(await calls[1].options.body.get('uploadGrant').text(), 'opaque-upload-token');
    assert.equal(calls[1].options.body.get('screenshot').type, 'image/webp');
    assert.equal(calls[1].options.body.get('video').type, 'video/webm');
    assert.equal(calls[1].options.headers['Content-Type'], undefined);
});

test('submits screenshot-only feedback without adding an empty video part', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? {
                ok: true,
                async json() {
                    return {
                        success: true,
                        uploadUrl: 'https://feedback.example/upload?action=upload&cors=policy',
                        uploadToken: 'opaque-upload-token',
                        idempotencyKey: 'submission-5678',
                    };
                },
            }
            : { ok: true, async json() { return { success: true, warnings: [] }; } };
    };

    await submitFeedbackDirect({
        prepareUrl: '/codeq-asana-feedback/prepare',
        submission: { submissionId: 'submission-5678', description: 'Missing label' },
        screenshot: {
            blob: new Blob(['webp-image'], { type: 'image/webp' }),
            fileName: 'screenshot.webp',
        },
        fetchImpl,
    });

    assert.equal(calls[1].options.body.get('screenshot').type, 'image/webp');
    assert.equal(calls[1].options.body.has('video'), false);
});

test('submits video-only feedback without adding an empty screenshot part', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? {
                ok: true,
                async json() {
                    return {
                        success: true,
                        uploadUrl: 'https://feedback.example/upload?action=upload&cors=policy',
                        uploadToken: 'opaque-upload-token',
                        idempotencyKey: 'submission-9012',
                    };
                },
            }
            : { ok: true, async json() { return { success: true, warnings: [] }; } };
    };

    await submitFeedbackDirect({
        prepareUrl: '/codeq-asana-feedback/prepare',
        submission: { submissionId: 'submission-9012', description: 'Animation is broken' },
        video: {
            blob: new Blob(['webm-video'], { type: 'video/webm' }),
            fileName: 'screencast.webm',
        },
        fetchImpl,
    });

    assert.equal(calls[1].options.body.has('screenshot'), false);
    assert.equal(calls[1].options.body.get('video').type, 'video/webm');
});
