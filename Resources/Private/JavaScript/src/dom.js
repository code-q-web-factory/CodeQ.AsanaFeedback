/**
 * Tiny hyperscript helper so the widget UI can be built without a
 * framework dependency.
 */
export function h(tagName, attributes = {}, children = []) {
    const element = document.createElement(tagName);

    for (const [name, value] of Object.entries(attributes)) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (name === 'className') {
            element.className = value;
        } else if (name === 'onClick') {
            element.addEventListener('click', value);
        } else if (name === 'onInput') {
            element.addEventListener('input', value);
        } else if (name === 'dataset') {
            Object.assign(element.dataset, value);
        } else if (value === true) {
            element.setAttribute(name, '');
        } else {
            element.setAttribute(name, String(value));
        }
    }

    for (const child of [].concat(children)) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }

    return element;
}

/** Replaces all children of a container element. */
export function replaceChildren(container, ...children) {
    container.innerHTML = '';
    container.append(...children.filter((child) => child !== null && child !== undefined));
}
