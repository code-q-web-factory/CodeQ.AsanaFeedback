import { createFeedbackWidget } from './widget';

/**
 * Website frontend entry point: reads the server rendered bootstrap
 * configuration embedded by the Fusion integration and shows the
 * floating feedback button.
 */
function bootstrap() {
    const configElement = document.getElementById('codeq-asana-feedback-config');
    if (!configElement) {
        return;
    }
    createFeedbackWidget(JSON.parse(configElement.textContent), { floatingButton: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
