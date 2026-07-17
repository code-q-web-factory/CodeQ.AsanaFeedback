/**
 * Options for frontend embeds. Regular Fusion integrations keep the default
 * viewport capture, while hosts with same-origin content frames can opt in to
 * compositing them into the screenshot.
 */
export function widgetOptionsForConfigElement(configElement) {
    return {
        floatingButton: true,
        includeIframes: configElement.dataset.includeIframes === 'true',
    };
}
