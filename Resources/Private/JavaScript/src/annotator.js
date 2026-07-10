import { Canvas, FabricImage, Rect, IText, Line, Triangle, Group, PencilBrush } from 'fabric';
import { h, replaceChildren } from './dom';
import { icon } from './icons';

const ANNOTATION_COLORS = ['#ff460d', '#00adee', '#00a338', '#f9c749', '#1a1a1a'];

/**
 * Fullscreen annotation editor on top of Fabric.js providing exactly the
 * required tools: freehand, rectangle, arrow, text, undo/redo and removal
 * of annotations.
 */
export class Annotator {
    /**
     * @param {HTMLCanvasElement} screenshotCanvas device-pixel sized screenshot
     * @param {object} labels translated UI labels
     * @param {{onContinue: Function, onRetake: Function, onCancel: Function}} callbacks
     */
    constructor(screenshotCanvas, labels, callbacks) {
        this.screenshotCanvas = screenshotCanvas;
        this.labels = labels;
        this.callbacks = callbacks;

        this.devicePixelRatio = Math.max(1, (window.devicePixelRatio || 1));
        // fabric works in CSS pixel coordinates, export multiplies back up
        this.logicalWidth = Math.round(screenshotCanvas.width / this.devicePixelRatio);
        this.logicalHeight = Math.round(screenshotCanvas.height / this.devicePixelRatio);

        this.activeTool = 'select';
        this.activeColor = ANNOTATION_COLORS[0];
        this.undoStack = [];
        this.redoStack = [];
        this.isRestoringState = false;
        this.stateCaptureTimeout = null;
        this.drawingShape = null;

        this.element = this.buildDom();
        this.handleKeyDown = this.handleKeyDown.bind(this);
    }

    buildDom() {
        this.toolButtons = {};
        const toolDefinitions = [
            ['select', 'toolSelect', 'select'],
            ['pen', 'toolPen', 'pen'],
            ['rect', 'toolRect', 'rect'],
            ['arrow', 'toolArrow', 'arrow'],
            ['text', 'toolText', 'text'],
        ];

        const toolbarLeft = h('div', { className: 'cqaf-annotator__tools', role: 'toolbar' });
        for (const [tool, labelKey, iconName] of toolDefinitions) {
            const button = h('button', {
                type: 'button',
                className: 'cqaf-tool-button',
                title: this.labels[labelKey],
                'aria-label': this.labels[labelKey],
                'aria-pressed': 'false',
                dataset: { tool },
                onClick: () => this.selectTool(tool),
            }, [icon(iconName)]);
            this.toolButtons[tool] = button;
            toolbarLeft.append(button);
        }

        this.colorButtons = [];
        const colorGroup = h('div', { className: 'cqaf-annotator__colors' });
        for (const color of ANNOTATION_COLORS) {
            const colorButton = h('button', {
                type: 'button',
                className: 'cqaf-color-button',
                style: `--cqaf-color:${color}`,
                'aria-label': color,
                onClick: () => this.selectColor(color),
            });
            this.colorButtons.push(colorButton);
            colorGroup.append(colorButton);
        }
        toolbarLeft.append(colorGroup);

        this.undoButton = h('button', { type: 'button', className: 'cqaf-tool-button', title: this.labels.undo, 'aria-label': this.labels.undo, dataset: { action: 'undo' }, onClick: () => this.undo() }, [icon('undo')]);
        this.redoButton = h('button', { type: 'button', className: 'cqaf-tool-button', title: this.labels.redo, 'aria-label': this.labels.redo, dataset: { action: 'redo' }, onClick: () => this.redo() }, [icon('redo')]);
        this.deleteButton = h('button', { type: 'button', className: 'cqaf-tool-button', title: this.labels.deleteAnnotation, 'aria-label': this.labels.deleteAnnotation, dataset: { action: 'delete' }, onClick: () => this.deleteSelection() }, [icon('trash')]);
        toolbarLeft.append(this.undoButton, this.redoButton, this.deleteButton);

        const toolbarRight = h('div', { className: 'cqaf-annotator__actions' }, [
            h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost', dataset: { action: 'cancel' }, onClick: () => this.callbacks.onCancel() }, [this.labels.cancel]),
            h('button', { type: 'button', className: 'cqaf-button cqaf-button--ghost', dataset: { action: 'retake' }, onClick: () => this.callbacks.onRetake() }, [this.labels.retakeScreenshot]),
            h('button', { type: 'button', className: 'cqaf-button cqaf-button--primary', dataset: { action: 'continue' }, onClick: () => this.finish() }, [this.labels.continueButton]),
        ]);

        this.canvasWrapper = h('div', { className: 'cqaf-annotator__canvas' });

        return h('div', { className: 'cqaf-annotator', role: 'dialog', 'aria-label': this.labels.annotateTitle }, [
            h('div', { className: 'cqaf-annotator__toolbar' }, [
                h('span', { className: 'cqaf-annotator__title' }, [this.labels.annotateTitle]),
                toolbarLeft,
                toolbarRight,
            ]),
            this.canvasWrapper,
        ]);
    }

    async mount(container) {
        container.append(this.element);

        const canvasElement = document.createElement('canvas');
        this.canvasWrapper.append(canvasElement);

        this.canvas = new Canvas(canvasElement, {
            width: this.logicalWidth,
            height: this.logicalHeight,
            selection: true,
            preserveObjectStacking: true,
        });

        const backgroundImage = await FabricImage.fromURL(this.screenshotCanvas.toDataURL('image/png'));
        backgroundImage.scaleX = this.logicalWidth / backgroundImage.width;
        backgroundImage.scaleY = this.logicalHeight / backgroundImage.height;
        this.canvas.backgroundImage = backgroundImage;
        this.canvas.renderAll();

        this.fitCanvasToViewport();
        this.registerCanvasEvents();
        this.captureState();
        this.selectTool('pen');
        this.selectColor(this.activeColor);

        document.addEventListener('keydown', this.handleKeyDown);
        this.resizeListener = () => this.fitCanvasToViewport();
        window.addEventListener('resize', this.resizeListener);
    }

    destroy() {
        document.removeEventListener('keydown', this.handleKeyDown);
        window.removeEventListener('resize', this.resizeListener);
        if (this.canvas) {
            this.canvas.dispose();
        }
        this.element.remove();
    }

    /** Scales the canvas via CSS to fit the available space, coordinates stay logical. */
    fitCanvasToViewport() {
        const availableWidth = Math.max(320, window.innerWidth - 48);
        const availableHeight = Math.max(240, window.innerHeight - 140);
        const scale = Math.min(1, availableWidth / this.logicalWidth, availableHeight / this.logicalHeight);
        this.canvas.setDimensions(
            { width: `${Math.round(this.logicalWidth * scale)}px`, height: `${Math.round(this.logicalHeight * scale)}px` },
            { cssOnly: true }
        );
    }

    registerCanvasEvents() {
        this.canvas.on('mouse:down', (event) => this.handlePointerDown(event));
        this.canvas.on('mouse:move', (event) => this.handlePointerMove(event));
        this.canvas.on('mouse:up', () => this.handlePointerUp());

        for (const eventName of ['object:added', 'object:modified', 'object:removed']) {
            this.canvas.on(eventName, () => this.scheduleStateCapture());
        }
    }

    selectTool(tool) {
        this.activeTool = tool;
        this.canvas.isDrawingMode = tool === 'pen';
        this.canvas.selection = tool === 'select';
        this.canvas.skipTargetFind = tool !== 'select';
        this.canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';

        if (tool === 'pen') {
            const brush = new PencilBrush(this.canvas);
            brush.color = this.activeColor;
            brush.width = 4;
            this.canvas.freeDrawingBrush = brush;
        }

        for (const [name, button] of Object.entries(this.toolButtons)) {
            button.setAttribute('aria-pressed', name === tool ? 'true' : 'false');
            button.classList.toggle('cqaf-tool-button--active', name === tool);
        }
    }

    selectColor(color) {
        this.activeColor = color;
        if (this.canvas && this.canvas.freeDrawingBrush) {
            this.canvas.freeDrawingBrush.color = color;
        }
        this.colorButtons.forEach((button) => {
            button.classList.toggle('cqaf-color-button--active', button.style.getPropertyValue('--cqaf-color') === color);
        });
    }

    handlePointerDown(event) {
        if (this.activeTool === 'rect' || this.activeTool === 'arrow') {
            const pointer = this.canvas.getScenePoint(event.e);
            this.drawingStart = pointer;

            if (this.activeTool === 'rect') {
                this.drawingShape = new Rect({
                    left: pointer.x,
                    top: pointer.y,
                    width: 1,
                    height: 1,
                    fill: 'transparent',
                    stroke: this.activeColor,
                    strokeWidth: 3,
                    strokeUniform: true,
                });
            } else {
                this.drawingShape = new Line([pointer.x, pointer.y, pointer.x, pointer.y], {
                    stroke: this.activeColor,
                    strokeWidth: 3,
                });
            }
            this.isRestoringState = true; // suppress undo snapshots while dragging
            this.canvas.add(this.drawingShape);
        }

        if (this.activeTool === 'text') {
            const pointer = this.canvas.getScenePoint(event.e);
            const text = new IText('', {
                left: pointer.x,
                top: pointer.y,
                fill: this.activeColor,
                fontFamily: 'Arial, sans-serif',
                fontSize: 22,
            });
            this.canvas.add(text);
            this.canvas.setActiveObject(text);
            text.enterEditing();
            this.selectTool('select');
        }
    }

    handlePointerMove(event) {
        if (!this.drawingShape) {
            return;
        }
        const pointer = this.canvas.getScenePoint(event.e);

        if (this.activeTool === 'rect') {
            this.drawingShape.set({
                left: Math.min(pointer.x, this.drawingStart.x),
                top: Math.min(pointer.y, this.drawingStart.y),
                width: Math.abs(pointer.x - this.drawingStart.x),
                height: Math.abs(pointer.y - this.drawingStart.y),
            });
        } else if (this.activeTool === 'arrow') {
            this.drawingShape.set({ x2: pointer.x, y2: pointer.y });
        }
        this.canvas.renderAll();
    }

    handlePointerUp() {
        if (!this.drawingShape) {
            return;
        }
        const shape = this.drawingShape;
        this.drawingShape = null;
        this.isRestoringState = false;

        if (this.activeTool === 'arrow') {
            const angle = (Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1) * 180) / Math.PI;
            const arrowHead = new Triangle({
                left: shape.x2,
                top: shape.y2,
                originX: 'center',
                originY: 'center',
                width: 14,
                height: 16,
                angle: angle + 90,
                fill: this.activeColor,
            });
            this.canvas.remove(shape);
            const arrowGroup = new Group([shape, arrowHead]);
            this.canvas.add(arrowGroup);
        } else {
            this.scheduleStateCapture();
        }
    }

    handleKeyDown(event) {
        const activeObject = this.canvas.getActiveObject();
        const isEditingText = activeObject && activeObject.isEditing;

        if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditingText && this.canvas.getActiveObjects().length > 0) {
            event.preventDefault();
            this.deleteSelection();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !isEditingText) {
            event.preventDefault();
            event.shiftKey ? this.redo() : this.undo();
        }
    }

    deleteSelection() {
        for (const object of this.canvas.getActiveObjects()) {
            this.canvas.remove(object);
        }
        this.canvas.discardActiveObject();
        this.canvas.renderAll();
    }

    scheduleStateCapture() {
        if (this.isRestoringState) {
            return;
        }
        // multiple fabric events fire per user action, capture once per tick
        clearTimeout(this.stateCaptureTimeout);
        this.stateCaptureTimeout = setTimeout(() => this.captureState(), 60);
    }

    captureState() {
        if (this.isRestoringState) {
            return;
        }
        this.undoStack.push(JSON.stringify(this.canvas.toObject()));
        if (this.undoStack.length > 60) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.updateHistoryButtons();
    }

    async undo() {
        if (this.undoStack.length < 2) {
            return;
        }
        this.redoStack.push(this.undoStack.pop());
        await this.restoreState(this.undoStack[this.undoStack.length - 1]);
    }

    async redo() {
        if (this.redoStack.length === 0) {
            return;
        }
        const state = this.redoStack.pop();
        this.undoStack.push(state);
        await this.restoreState(state);
    }

    async restoreState(serializedState) {
        this.isRestoringState = true;
        await this.canvas.loadFromJSON(JSON.parse(serializedState));
        this.canvas.renderAll();
        this.isRestoringState = false;
        this.updateHistoryButtons();
    }

    updateHistoryButtons() {
        this.undoButton.disabled = this.undoStack.length < 2;
        this.redoButton.disabled = this.redoStack.length === 0;
    }

    /** Renders the annotated screenshot back at full device resolution. */
    exportCanvas() {
        this.canvas.discardActiveObject();
        this.canvas.renderAll();
        return this.canvas.toCanvasElement(this.devicePixelRatio);
    }

    finish() {
        this.callbacks.onContinue(this.exportCanvas());
    }
}
