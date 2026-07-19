import { h, replaceChildren } from './dom';
import { icon } from './icons';
import { captureViewport } from './capture';
import { collectTechnicalContext, getNeosContentCanvasUrl } from './context';
import { Annotator } from './annotator';
import { isScreencastSupported, startScreencast, fileExtensionForMimeType } from './recorder';

/**
 * Core of the feedback widget driving the flow
 * capture -> annotate -> describe -> submit -> result.
 *
 * Used by the website frontend (with the floating button) and by the
 * Neos backend toolbar plugin (which opens it programmatically and
 * composites the content iframe into the screenshot).
 */
export function createFeedbackWidget(config, { floatingButton = true, includeIframes = false } = {}) {
    const labels = config.labels;

    const state = {
        annotatedCanvas: null,
        screenshotCanvas: null,
        annotator: null,
        submitting: false,
        screencastBlob: null,
        screencastMimeType: '',
        recordingHandle: null,
        contentCanvasUrl: '',
        // stable per capture session so a retry after a timeout creates no
        // duplicate Asana task (the server deduplicates by this id)
        submissionId: null,
    };

    // random id identifying one report; kept across retries, renewed per capture
    function generateSubmissionId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'cqaf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }

    // the root element is excluded from screenshots via the capture filter
    const root = h('div', { id: 'codeq-asana-feedback-root', dataset: { codeqFeedback: 'true' } });
    document.body.append(root);

    const feedbackButton = h('button', {
        type: 'button',
        className: 'cqaf-fab',
        'aria-label': labels.buttonLabel,
        hidden: !floatingButton,
        onClick: () => startCapture(),
    }, [icon('feedback'), h('span', {}, [labels.buttonLabel])]);

    const overlay = h('div', { className: 'cqaf-overlay', hidden: true });
    // non-blocking corner notice shown while uploading and for the success state
    const toast = h('div', { className: 'cqaf-toast', role: 'status', hidden: true });
    let recordingStartedAt = 0;
    let recordingElapsedInterval = null;
    const recordingStopLabel = h('span', {}, [labels.stopRecording]);
    const recordingStopButton = h('button', {
        type: 'button',
        className: 'cqaf-button cqaf-recording-stop',
        dataset: { action: 'stop-recording' },
        hidden: true,
        onClick: () => {
            if (state.recordingHandle) {
                state.recordingHandle.stop();
            }
        },
    }, [icon('video'), recordingStopLabel]);
    root.append(feedbackButton, overlay, recordingStopButton, toast);

    function showOverlay(...children) {
        overlay.hidden = false;
        replaceChildren(overlay, ...children);
    }

    function hideOverlay() {
        overlay.hidden = true;
        replaceChildren(overlay);
    }

    function concealOverlay() {
        overlay.hidden = true;
    }

    function revealOverlay() {
        overlay.hidden = false;
    }

    // shrinks the full screen modal away (towards the corner) while uploading
    function concealOverlayAnimated() {
        overlay.classList.add('cqaf-overlay--hiding');
        window.setTimeout(() => {
            overlay.hidden = true;
        }, 240);
    }

    // brings the modal back full screen, e.g. after an upload error
    function revealOverlayAnimated() {
        overlay.hidden = false;
        overlay.classList.add('cqaf-overlay--hiding');
        // next frame so the browser animates from the hidden to the shown state
        requestAnimationFrame(() => overlay.classList.remove('cqaf-overlay--hiding'));
    }

    // the corner notice covers the same spot as the floating button
    function showToast(children, { assertive = false } = {}) {
        replaceChildren(toast, ...children);
        toast.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
        feedbackButton.hidden = true;
        toast.hidden = false;
        requestAnimationFrame(() => toast.classList.add('cqaf-toast--visible'));
    }

    function hideToast() {
        toast.classList.remove('cqaf-toast--visible');
        toast.hidden = true;
        replaceChildren(toast);
    }

    function showUploadingToast(labelText) {
        showToast([
            h('div', { className: 'cqaf-toast__uploading' }, [
                icon('spinner'),
                h('span', {}, [labelText]),
            ]),
        ]);
    }

    // success is confirmed in the corner, mirroring the full screen result view
    function showSuccessToast(payload) {
        // message, warning and task link share the text column so they align
        // with each other next to the success icon
        const headlineChildren = [
            h('p', { className: 'cqaf-result__message' }, [labels.successMessage]),
        ];

        if (payload && Array.isArray(payload.warnings) && payload.warnings.includes('videoUploadFailed')) {
            headlineChildren.push(h('p', { className: 'cqaf-result__warning' }, [labels.videoUploadFailed]));
        }

        // the Asana link is only delivered to team members by the server
        if (payload && payload.taskUrl) {
            headlineChildren.push(h('a', {
                className: 'cqaf-button cqaf-button--ghost cqaf-button--small cqaf-task-link',
                href: payload.taskUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
            }, [icon('externalLink'), h('span', {}, [labels.openTask])]));
        }

        const children = [
            h('div', { className: 'cqaf-toast__header' }, [
                h('div', { className: 'cqaf-result__icon cqaf-result__icon--success cqaf-result__icon--small' }, [icon('check')]),
                h('div', { className: 'cqaf-toast__headline' }, headlineChildren),
            ]),
            h('div', { className: 'cqaf-toast__actions' }, [
                h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost cqaf-button--small', onClick: () => reset() }, [labels.close]),
                h('button', { type: 'button', className: 'cqaf-button cqaf-button--primary cqaf-button--small', onClick: () => { reset(); startCapture(); } }, [labels.newFeedback]),
            ]),
        ];

        // the modal is no longer needed once the submission succeeded
        hideOverlay();
        showToast(children, { assertive: true });
    }

    function showRecordingStopButton() {
        recordingStartedAt = Date.now();
        recordingStopLabel.textContent = `${labels.stopRecording} (0s)`;
        recordingStopButton.hidden = false;
        clearInterval(recordingElapsedInterval);
        recordingElapsedInterval = setInterval(() => {
            const seconds = Math.round((Date.now() - recordingStartedAt) / 1000);
            recordingStopLabel.textContent = `${labels.stopRecording} (${seconds}s)`;
        }, 1000);
    }

    function hideRecordingStopButton() {
        clearInterval(recordingElapsedInterval);
        recordingElapsedInterval = null;
        recordingStopButton.hidden = true;
    }

    function destroyAnnotator() {
        if (state.annotator) {
            state.annotator.destroy();
            state.annotator = null;
        }
    }

    function reset() {
        destroyAnnotator();
        const recordingHandle = state.recordingHandle;
        state.recordingHandle = null;
        hideRecordingStopButton();
        if (recordingHandle) {
            recordingHandle.stop();
        }
        state.annotatedCanvas = null;
        state.screenshotCanvas = null;
        state.submitting = false;
        state.screencastBlob = null;
        state.screencastMimeType = '';
        state.contentCanvasUrl = '';
        state.submissionId = null;
        hideToast();
        overlay.classList.remove('cqaf-overlay--hiding');
        hideOverlay();
        feedbackButton.hidden = !floatingButton;
    }

    async function startCapture() {
        state.contentCanvasUrl = includeIframes ? getNeosContentCanvasUrl() : '';
        // a fresh report gets a fresh id; retries of the same report reuse it
        state.submissionId = generateSubmissionId();
        feedbackButton.disabled = true;
        feedbackButton.classList.add('cqaf-fab--busy');
        // rendering the page DOM can take a few seconds; the indicator lives
        // inside the widget root and is excluded from the screenshot itself
        showOverlay(h('div', { className: 'cqaf-capture-indicator', role: 'status' }, [
            icon('spinner'),
            h('span', {}, [labels.capturing]),
        ]));
        try {
            // the widget root is filtered out, the button never shows up in the image
            state.screenshotCanvas = await captureViewport({ includeIframes });
        } catch (error) {
            console.error('CodeQ.AsanaFeedback: screenshot failed', error);
            feedbackButton.disabled = false;
            feedbackButton.classList.remove('cqaf-fab--busy');
            showResult(false, labels.errorScreenshot, null);
            return;
        }
        feedbackButton.disabled = false;
        feedbackButton.classList.remove('cqaf-fab--busy');
        feedbackButton.hidden = true;
        openAnnotator();
    }

    function openAnnotator() {
        destroyAnnotator();
        showOverlay();
        state.annotator = new Annotator(state.screenshotCanvas, labels, {
            onContinue: (annotatedCanvas) => {
                state.annotatedCanvas = annotatedCanvas;
                destroyAnnotator();
                showForm();
            },
            onRetake: () => {
                reset();
                startCapture();
            },
            onCancel: () => reset(),
        });
        state.annotator.mount(overlay);
    }

    function showForm() {
        const previewImage = h('img', {
            className: 'cqaf-form__preview',
            src: state.annotatedCanvas.toDataURL('image/png'),
            alt: labels.screenshotPreviewAlt,
        });

        // every user may name the Asana task; without a title the task is
        // named after the description
        const titleField = h('input', {
            className: 'cqaf-input',
            id: 'cqaf-title',
            type: 'text',
            maxlength: 200,
            placeholder: labels.titlePlaceholder,
        });
        const titleRow = h('div', { className: 'cqaf-field' }, [
            h('label', { className: 'cqaf-label', for: 'cqaf-title' }, [labels.titleLabel]),
            titleField,
        ]);

        const descriptionField = h('textarea', {
            className: 'cqaf-input cqaf-input--textarea',
            id: 'cqaf-description',
            rows: 5,
            maxlength: config.limits.descriptionCharacters,
            placeholder: labels.descriptionPlaceholder,
            required: true,
        });

        const descriptionError = h('p', { className: 'cqaf-field-error', hidden: true }, [labels.errorDescriptionRequired]);

        // logged-in users are identified server side, no name row needed;
        // anonymous visitors can state who they are
        let authorField = null;
        const identityRows = [];
        if (!config.user.authenticated) {
            authorField = h('input', {
                className: 'cqaf-input',
                id: 'cqaf-author',
                type: 'text',
                maxlength: 200,
                placeholder: labels.authorPlaceholder,
            });
            identityRows.push(
                h('div', { className: 'cqaf-field' }, [
                    h('label', { className: 'cqaf-label', for: 'cqaf-author' }, [labels.authorLabel]),
                    authorField,
                ])
            );
        }

        // the server decides which assignees the current user may pick
        let selectedAssignee = { key: '' };
        let assigneeRow = null;
        if (config.assignees.length > 0) {
            const assigneeButtons = [];
            const makeAssigneeButton = (assignee, children) => {
                const button = h('button', {
                    type: 'button',
                    className: 'cqaf-assignee',
                    dataset: { key: assignee.key },
                    'aria-pressed': 'false',
                    onClick: () => {
                        selectedAssignee.key = selectedAssignee.key === assignee.key ? '' : assignee.key;
                        assigneeButtons.forEach((assigneeButton) => {
                            const isActive = assigneeButton.dataset.key === selectedAssignee.key;
                            assigneeButton.classList.toggle('cqaf-assignee--active', isActive);
                            assigneeButton.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                        });
                    },
                }, children);
                assigneeButtons.push(button);
                return button;
            };

            assigneeRow = h('div', { className: 'cqaf-field' }, [
                h('label', { className: 'cqaf-label' }, [labels.assigneeLabel]),
                h('div', { className: 'cqaf-assignees' },
                    config.assignees.map((assignee) => makeAssigneeButton(assignee, [
                        assignee.avatarUri
                            ? h('img', { className: 'cqaf-assignee__avatar', src: assignee.avatarUri, alt: '' })
                            : h('span', { className: 'cqaf-assignee__avatar cqaf-assignee__avatar--fallback' }, [assignee.label.charAt(0)]),
                        h('span', {}, [assignee.label]),
                    ]))
                ),
            ]);
        }

        // optional screencast (nice-to-have): recorded via the native
        // Screen Capture API, attached to the same Asana task
        let screencastContainer = null;
        if (isScreencastSupported()) {
            screencastContainer = h('div', { className: 'cqaf-screencast' });

            const renderScreencastState = () => {
                if (state.screencastBlob) {
                    replaceChildren(screencastContainer,
                        h('span', { className: 'cqaf-screencast__attached' }, [
                            `${labels.screencastAttached} (${(state.screencastBlob.size / 1048576).toFixed(1)} MB)`,
                        ]),
                        h('button', {
                            type: 'button',
                            className: 'cqaf-button cqaf-button--ghost cqaf-button--small',
                            dataset: { action: 'remove-recording' },
                            onClick: () => {
                                state.screencastBlob = null;
                                renderScreencastState();
                            },
                        }, [labels.removeScreencast]));
                } else {
                    replaceChildren(screencastContainer, h('button', {
                        type: 'button',
                        className: 'cqaf-button cqaf-button--ghost cqaf-button--small',
                        dataset: { action: 'record-screencast' },
                        onClick: async () => {
                            let recordingHandle;
                            try {
                                recordingHandle = await startScreencast({
                                    onStreamSelected: () => concealOverlay(),
                                });
                            } catch (error) {
                                // the user cancelled the picker or the browser denied access
                                if (error && error.code === 'audioUnavailable') {
                                    errorMessage.textContent = labels.screencastAudioRequired;
                                    errorMessage.hidden = false;
                                }
                                revealOverlay();
                                return;
                            }
                            state.recordingHandle = recordingHandle;
                            showRecordingStopButton();
                            recordingHandle.blobPromise.then((blob) => finishRecording(blob, recordingHandle));
                        },
                    }, [icon('video'), h('span', {}, [labels.recordScreencast])]));
                }
            };

            const finishRecording = (blob, recordingHandle) => {
                if (state.recordingHandle !== recordingHandle) {
                    return;
                }
                const mimeType = recordingHandle.mimeType;
                state.recordingHandle = null;
                hideRecordingStopButton();
                if (blob && blob.size > 0 && blob.size <= config.limits.videoBytes) {
                    state.screencastBlob = blob;
                    state.screencastMimeType = mimeType;
                } else if (blob && blob.size > config.limits.videoBytes) {
                    state.screencastBlob = null;
                    errorMessage.textContent = labels.screencastTooLarge;
                    errorMessage.hidden = false;
                }
                renderScreencastState();
                revealOverlay();
            };

            renderScreencastState();
        }

        const submitButton = h('button', { type: 'submit', className: 'cqaf-button cqaf-button--primary' }, [labels.submit]);
        const errorMessage = h('p', { className: 'cqaf-form-error', role: 'alert', hidden: true });

        const form = h('form', { className: 'cqaf-form', novalidate: true }, [
            h('div', { className: 'cqaf-panel__header' }, [
                h('h2', { className: 'cqaf-panel__title' }, [labels.panelTitle]),
                h('button', { type: 'button', className: 'cqaf-icon-button', 'aria-label': labels.close, onClick: () => reset() }, [icon('close')]),
            ]),
            h('div', { className: 'cqaf-form__preview-wrap' }, [
                previewImage,
                h('div', { className: 'cqaf-form__preview-actions' }, [
                    h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost cqaf-button--small', onClick: () => openAnnotator() }, [labels.editAnnotations]),
                    screencastContainer,
                ]),
            ]),
            titleRow,
            h('div', { className: 'cqaf-field' }, [
                h('label', { className: 'cqaf-label', for: 'cqaf-description' }, [labels.descriptionLabel]),
                descriptionField,
                descriptionError,
            ]),
            ...identityRows,
            assigneeRow,
            errorMessage,
            h('div', { className: 'cqaf-form__actions' }, [
                h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost', onClick: () => reset() }, [labels.cancel]),
                submitButton,
            ]),
        ]);

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (state.submitting) {
                return;
            }

            const description = descriptionField.value.trim();
            descriptionError.hidden = description !== '';
            if (description === '') {
                descriptionField.focus();
                return;
            }

            // a still running recording is finished before sending
            if (state.recordingHandle) {
                const recordingHandle = state.recordingHandle;
                const blob = await recordingHandle.stop();
                if (blob && blob.size > 0 && blob.size <= config.limits.videoBytes) {
                    state.screencastBlob = blob;
                    state.screencastMimeType = recordingHandle.mimeType;
                }
                state.recordingHandle = null;
                hideRecordingStopButton();
            }

            state.submitting = true;
            errorMessage.hidden = true;
            submitButton.disabled = true;
            // uploading a screencast through the relay to Asana can take a
            // while, so the button says so instead of a generic "Sending …"
            const sendingLabel = state.screencastBlob ? labels.sendingVideo : labels.sending;
            replaceChildren(submitButton, icon('spinner'), document.createTextNode(' ' + sendingLabel));

            // the upload no longer blocks the page: the modal shrinks into a
            // small corner notice while the (potentially slow) upload runs
            concealOverlayAnimated();
            showUploadingToast(sendingLabel);

            try {
                const result = await submitFeedback({
                    title: titleField.value,
                    description,
                    authorName: authorField ? authorField.value : '',
                    assigneeKey: selectedAssignee.key,
                });
                showSuccessToast(result);
            } catch (error) {
                // on failure the modal comes back full screen so the user sees
                // the error and can retry (the retry reuses the submission id)
                hideToast();
                state.submitting = false;
                submitButton.disabled = false;
                replaceChildren(submitButton, document.createTextNode(labels.submit));
                errorMessage.textContent = mapErrorToLabel(error);
                errorMessage.hidden = false;
                revealOverlayAnimated();
            }
        });

        showOverlay(h('div', { className: 'cqaf-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': labels.panelTitle }, [form]));
        descriptionField.focus();
    }

    async function submitFeedback(fields) {
        const screenshotBlob = await new Promise((resolve) => state.annotatedCanvas.toBlob(resolve, 'image/png'));
        if (!screenshotBlob || screenshotBlob.size > config.limits.screenshotBytes) {
            throw { errorCode: 'validation' };
        }

        const formData = new FormData();
        formData.append('submissionId', state.submissionId || '');
        formData.append('title', fields.title || '');
        formData.append('description', fields.description);
        formData.append('authorName', fields.authorName || '');
        formData.append('assigneeKey', fields.assigneeKey || '');
        formData.append('pageUrl', window.location.href);
        formData.append('technicalContext', JSON.stringify(collectTechnicalContext({
            contentCanvasUrl: state.contentCanvasUrl,
        })));
        formData.append('screenshot', screenshotBlob, 'screenshot.png');
        if (state.screencastBlob) {
            formData.append('video', state.screencastBlob, 'screencast.' + fileExtensionForMimeType(state.screencastMimeType));
        }

        let response;
        try {
            response = await fetch(config.submitUrl, {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
            });
        } catch (networkError) {
            console.error('CodeQ.AsanaFeedback: network error', networkError);
            throw { errorCode: 'network' };
        }

        let payload = null;
        try {
            payload = await response.json();
        } catch (parseError) {
            payload = null;
        }

        if (!response.ok || !payload || payload.success !== true) {
            throw payload || { errorCode: 'internal' };
        }
        return payload;
    }

    function mapErrorToLabel(error) {
        const errorCode = error && error.errorCode;
        switch (errorCode) {
            case 'validation':
                return labels.errorValidation;
            case 'rateLimit':
                return labels.errorRateLimit;
            case 'configuration':
                return labels.errorConfiguration;
            case 'attachmentFailed':
                return labels.errorAttachment;
            case 'forbidden':
                return labels.errorForbidden;
            default:
                return labels.errorGeneric;
        }
    }

    function showResult(success, errorText, payload) {
        const children = [
            h('div', { className: `cqaf-result__icon ${success ? 'cqaf-result__icon--success' : 'cqaf-result__icon--error'}` }, [
                icon(success ? 'check' : 'alert'),
            ]),
            h('h2', { className: 'cqaf-panel__title' }, [success ? labels.successTitle : labels.errorTitle]),
            h('p', { className: 'cqaf-result__message' }, [success ? labels.successMessage : errorText]),
        ];

        if (success && payload && Array.isArray(payload.warnings) && payload.warnings.includes('videoUploadFailed')) {
            children.push(h('p', { className: 'cqaf-result__warning' }, [labels.videoUploadFailed]));
        }

        // the Asana link is only delivered to team members by the server
        if (success && payload && payload.taskUrl) {
            children.push(h('a', {
                className: 'cqaf-button cqaf-button--ghost cqaf-task-link',
                href: payload.taskUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
            }, [icon('externalLink'), h('span', {}, [labels.openTask])]));
        }

        children.push(h('div', { className: 'cqaf-form__actions' }, [
            h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost', onClick: () => reset() }, [labels.close]),
            h('button', { type: 'button', className: 'cqaf-button cqaf-button--primary', onClick: () => { reset(); startCapture(); } }, [labels.newFeedback]),
        ]));

        showOverlay(h('div', { className: 'cqaf-panel cqaf-panel--result', role: 'dialog', 'aria-modal': 'true' }, children));
        feedbackButton.hidden = true;
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !overlay.hidden && !state.annotator && !state.submitting) {
            reset();
        }
    });

    return { open: () => startCapture() };
}
