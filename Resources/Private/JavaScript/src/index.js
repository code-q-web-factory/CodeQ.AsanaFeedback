import { h, replaceChildren } from './dom';
import { icon } from './icons';
import { captureViewport } from './capture';
import { collectTechnicalContext } from './context';
import { Annotator } from './annotator';

/**
 * Entry point of the feedback widget. Reads the server rendered bootstrap
 * configuration, renders the floating button and drives the flow:
 * capture -> annotate -> describe -> submit -> result.
 */
function bootstrap() {
    const configElement = document.getElementById('codeq-asana-feedback-config');
    if (!configElement) {
        return;
    }
    const config = JSON.parse(configElement.textContent);
    const labels = config.labels;

    const state = {
        annotatedCanvas: null,
        screenshotCanvas: null,
        annotator: null,
        submitting: false,
    };

    // the root element is excluded from screenshots via the capture filter
    const root = h('div', { id: 'codeq-asana-feedback-root', dataset: { codeqFeedback: 'true' } });
    document.body.append(root);

    const feedbackButton = h('button', {
        type: 'button',
        className: 'cqaf-fab',
        'aria-label': labels.buttonLabel,
        onClick: () => startCapture(),
    }, [icon('feedback'), h('span', {}, [labels.buttonLabel])]);

    const overlay = h('div', { className: 'cqaf-overlay', hidden: true });
    root.append(feedbackButton, overlay);

    function showOverlay(...children) {
        overlay.hidden = false;
        replaceChildren(overlay, ...children);
    }

    function hideOverlay() {
        overlay.hidden = true;
        replaceChildren(overlay);
    }

    function destroyAnnotator() {
        if (state.annotator) {
            state.annotator.destroy();
            state.annotator = null;
        }
    }

    function reset() {
        destroyAnnotator();
        state.annotatedCanvas = null;
        state.screenshotCanvas = null;
        state.submitting = false;
        hideOverlay();
        feedbackButton.hidden = false;
    }

    async function startCapture() {
        feedbackButton.disabled = true;
        feedbackButton.classList.add('cqaf-fab--busy');
        try {
            // the widget root is filtered out, the button never shows up in the image
            state.screenshotCanvas = await captureViewport(root);
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

        const descriptionField = h('textarea', {
            className: 'cqaf-input cqaf-input--textarea',
            id: 'cqaf-description',
            rows: 5,
            maxlength: config.limits.descriptionCharacters,
            placeholder: labels.descriptionPlaceholder,
            required: true,
        });

        const descriptionError = h('p', { className: 'cqaf-field-error', hidden: true }, [labels.errorDescriptionRequired]);

        let authorField = null;
        const identityRows = [];
        if (config.user.authenticated) {
            identityRows.push(
                h('div', { className: 'cqaf-field' }, [
                    h('label', { className: 'cqaf-label' }, [labels.authorLabel]),
                    h('p', { className: 'cqaf-author-name' }, [config.user.authorName || '']),
                ])
            );
        } else {
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

        // assignee selection exists only for recognized Code Q team members
        let selectedAssignee = { key: '' };
        let assigneeRow = null;
        if (config.user.isTeamMember && config.assignees.length > 0) {
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

        const submitButton = h('button', { type: 'submit', className: 'cqaf-button cqaf-button--primary' }, [labels.submit]);
        const errorMessage = h('p', { className: 'cqaf-form-error', role: 'alert', hidden: true });

        const form = h('form', { className: 'cqaf-form', novalidate: true }, [
            h('div', { className: 'cqaf-panel__header' }, [
                h('h2', { className: 'cqaf-panel__title' }, [labels.panelTitle]),
                h('button', { type: 'button', className: 'cqaf-icon-button', 'aria-label': labels.close, onClick: () => reset() }, [icon('close')]),
            ]),
            h('div', { className: 'cqaf-form__preview-wrap' }, [
                previewImage,
                h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost cqaf-button--small', onClick: () => openAnnotator() }, [labels.editAnnotations]),
            ]),
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

            state.submitting = true;
            errorMessage.hidden = true;
            submitButton.disabled = true;
            replaceChildren(submitButton, icon('spinner'), document.createTextNode(' ' + labels.sending));

            try {
                const result = await submitFeedback({
                    description,
                    authorName: authorField ? authorField.value : '',
                    assigneeKey: selectedAssignee.key,
                });
                showResult(true, null, result);
            } catch (error) {
                state.submitting = false;
                submitButton.disabled = false;
                replaceChildren(submitButton, document.createTextNode(labels.submit));
                errorMessage.textContent = mapErrorToLabel(error);
                errorMessage.hidden = false;
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
        formData.append('description', fields.description);
        formData.append('authorName', fields.authorName || '');
        formData.append('assigneeKey', fields.assigneeKey || '');
        formData.append('pageUrl', window.location.href);
        formData.append('technicalContext', JSON.stringify(collectTechnicalContext()));
        formData.append('screenshot', screenshotBlob, 'screenshot.png');

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
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
