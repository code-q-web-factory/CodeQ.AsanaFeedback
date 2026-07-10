import { createFeedbackWidget } from '../../JavaScript/src/widget';

let widgetPromise = null;

/**
 * Lazily bootstraps the shared feedback widget inside the backend host
 * frame. The configuration (identity, team status, labels) is fetched per
 * session from the uncached config endpoint; the capture composites the
 * content iframe so the full backend is part of the screenshot.
 */
export async function openFeedbackWidget() {
    if (!widgetPromise) {
        const interfaceLanguage = document.documentElement.lang || 'en';
        widgetPromise = fetch('/codeq-asana-feedback/config?locale=' + encodeURIComponent(interfaceLanguage), {
            credentials: 'same-origin',
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error('Config endpoint returned ' + response.status);
                }
                return response.json();
            })
            .then((config) => createFeedbackWidget(config, { floatingButton: false, includeIframes: true }));
    }

    try {
        (await widgetPromise).open();
    } catch (error) {
        widgetPromise = null;
        console.error('CodeQ.AsanaFeedback: could not open the feedback widget', error);
    }
}
