/* ============================================================
   FjordFooocus Advanced Layer Editor
   A Photoshop-like layer compositing editor overlay
   ============================================================ */

(function() {
'use strict';

// ─── Constants ──────────────────────────────────────────────
const BLEND_MODES = [
    { value: 'source-over', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'color-burn', label: 'Color Burn' },
];

const UOV_METHODS = [
    'Disabled', 'Vary (Subtle)', 'Vary (Moderate)', 'Vary (Bold)', 'Vary (Strong)',
    'Upscale (1.5x)', 'Upscale (2x)', 'Upscale (Fast 2x)'
];
const INPAINT_METHODS = [
    'Inpaint or Outpaint (default)',
    'Improve Detail (face, hand, eyes, etc.)',
    'Modify Content (add objects, change background, etc.)'
];
const REMOVEBG_MODELS = [
    'u2net', 'u2netp', 'u2net_human_seg', 'u2net_cloth_seg',
    'silueta', 'isnet-general-use', 'isnet-anime', 'sam'
];
const DESCRIBE_TYPES = ['Photograph', 'Anime'];
const IP_TYPES = ['ImagePrompt', 'PyraCanny', 'CPDS', 'Skeletal Pose', 'FaceSwap'];

const HANDLE_SIZE = 8;
const ROTATE_HANDLE_OFFSET = 25;
const SNAP_THRESHOLD = 5;
const THUMBNAIL_SIZE = 40;
const MAX_UNDO = 50;

let nextLayerId = 1;

// ─── Layer Editor State ─────────────────────────────────────
const LE = {
    overlay: null,
    compositeCanvas: null, compositeCtx: null,
    overlayCanvas: null, overlayCtx: null,
    containerEl: null,

    documentWidth: 1024, documentHeight: 1024,
    layers: [],
    activeLayerId: null,

    viewZoom: 1, viewPanX: 0, viewPanY: 0,
    isDragging: false, isPanning: false, isSpaceDown: false,
    lastMouseX: 0, lastMouseY: 0,

    activeTool: 'transform',
    toolState: {},
    brushColor: '#ffffff',
    brushSize: 10,
    brushOpacity: 1.0,
    brushSoftness: 0,
    maskBrushSize: 30, // Separate brush size for mask tool

    activeAction: null,
    inpaintMaskCanvas: null, inpaintMaskCtx: null,
    isPaintingMask: false,

    undoStack: [],
    redoStack: [],

    previewBackup: null,
    previewLayerId: null,
    isGenerating: false,

    // Touch state
    touches: {},
    lastPinchDist: 0,
    lastPinchCenter: null,
};

window.layerEditor = LE;

// ─── Utility Functions ──────────────────────────────────────
function genId() { return 'layer_' + (nextLayerId++); }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function updateBrushSizeUI() {
    const d = document.getElementById('le-brush-size-display');
    if (d) d.textContent = LE.brushSize;
    const slider = document.getElementById('le-brush-size-slider');
    if (slider) slider.value = LE.brushSize;
}

function screenToCanvas(sx, sy) {
    const rect = LE.containerEl.getBoundingClientRect();
    const x = (sx - rect.left - LE.viewPanX) / LE.viewZoom;
    const y = (sy - rect.top - LE.viewPanY) / LE.viewZoom;
    return { x, y };
}

function canvasToScreen(cx, cy) {
    const rect = LE.containerEl.getBoundingClientRect();
    return {
        x: cx * LE.viewZoom + LE.viewPanX + rect.left,
        y: cy * LE.viewZoom + LE.viewPanY + rect.top
    };
}

function getActiveLayer() {
    return LE.layers.find(l => l.id === LE.activeLayerId) || null;
}

function getLayerBounds(layer) {
    const hw = layer.width * layer.scaleX / 2;
    const hh = layer.height * layer.scaleY / 2;
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    // Return axis-aligned bounding box (ignores rotation for simplicity in hit-testing)
    return {
        x: cx - hw, y: cy - hh,
        w: hw * 2, h: hh * 2,
        cx, cy
    };
}

function pointInLayerBounds(px, py, layer) {
    // Transform point to layer-local coordinates (accounting for rotation)
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    const cos = Math.cos(-layer.rotation);
    const sin = Math.sin(-layer.rotation);
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const hw = layer.width * layer.scaleX / 2;
    const hh = layer.height * layer.scaleY / 2;
    return lx >= -hw && lx <= hw && ly >= -hh && ly <= hh;
}

function hitTestLayers(canvasX, canvasY) {
    // Top to bottom (last in array = top)
    for (let i = LE.layers.length - 1; i >= 0; i--) {
        const layer = LE.layers[i];
        if (!layer.visible || layer.locked) continue;
        if (pointInLayerBounds(canvasX, canvasY, layer)) {
            // Check alpha for non-transparent pixel
            const cx = layer.x + layer.width / 2;
            const cy = layer.y + layer.height / 2;
            const cos = Math.cos(-layer.rotation);
            const sin = Math.sin(-layer.rotation);
            const dx = canvasX - cx;
            const dy = canvasY - cy;
            const lx = (dx * cos - dy * sin) / layer.scaleX + layer.width / 2;
            const ly = (dx * sin + dy * cos) / layer.scaleY + layer.height / 2;
            if (lx >= 0 && lx < layer.width && ly >= 0 && ly < layer.height) {
                try {
                    const pixel = layer.ctx.getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
                    if (pixel[3] > 10) return layer;
                } catch(e) { return layer; }
            }
        }
    }
    return null;
}

// ─── Undo/Redo ──────────────────────────────────────────────
function pushUndo(action) {
    LE.undoStack.push(action);
    if (LE.undoStack.length > MAX_UNDO) LE.undoStack.shift();
    LE.redoStack = [];
}

function performUndo() {
    if (LE.undoStack.length === 0) return;
    const action = LE.undoStack.pop();
    action.undo();
    LE.redoStack.push(action);
    recomposite();
    renderLayerPanel();
}

function performRedo() {
    if (LE.redoStack.length === 0) return;
    const action = LE.redoStack.pop();
    action.redo();
    LE.undoStack.push(action);
    recomposite();
    renderLayerPanel();
}

// ─── Composite Rendering ────────────────────────────────────
function drawCheckerboard(ctx, w, h, panX, panY, zoom) {
    const size = 10;
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(panX, panY, w * zoom, h * zoom);
    ctx.fillStyle = '#444';
    const startX = Math.floor(-panX / (size * zoom)) - 1;
    const startY = Math.floor(-panY / (size * zoom)) - 1;
    const endX = startX + Math.ceil(LE.containerEl.clientWidth / (size * zoom)) + 2;
    const endY = startY + Math.ceil(LE.containerEl.clientHeight / (size * zoom)) + 2;
    for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
            if ((x + y) % 2 === 0) continue;
            const px = panX + x * size * zoom;
            const py = panY + y * size * zoom;
            if (px + size * zoom < 0 || py + size * zoom < 0) continue;
            if (px > LE.compositeCanvas.width || py > LE.compositeCanvas.height) continue;
            ctx.fillRect(px, py, size * zoom, size * zoom);
        }
    }
}

function recomposite() {
    if (!LE.compositeCanvas) return;
    const cw = LE.containerEl.clientWidth;
    const ch = LE.containerEl.clientHeight;
    if (LE.compositeCanvas.width !== cw || LE.compositeCanvas.height !== ch) {
        LE.compositeCanvas.width = cw;
        LE.compositeCanvas.height = ch;
        LE.overlayCanvas.width = cw;
        LE.overlayCanvas.height = ch;
    }

    const ctx = LE.compositeCtx;
    ctx.clearRect(0, 0, cw, ch);

    // Draw checkerboard for document area
    drawCheckerboard(ctx, LE.documentWidth, LE.documentHeight, LE.viewPanX, LE.viewPanY, LE.viewZoom);

    // Draw document border
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.strokeRect(LE.viewPanX - 0.5, LE.viewPanY - 0.5,
        LE.documentWidth * LE.viewZoom + 1, LE.documentHeight * LE.viewZoom + 1);

    // Draw layers
    ctx.save();
    ctx.translate(LE.viewPanX, LE.viewPanY);
    ctx.scale(LE.viewZoom, LE.viewZoom);

    // Clip to document bounds
    ctx.beginPath();
    ctx.rect(0, 0, LE.documentWidth, LE.documentHeight);
    ctx.clip();

    // Collect mask layer IDs so we skip them in the main loop
    // (they're rendered as part of their parent layer)
    const maskLayerIds = new Set();
    for (const layer of LE.layers) {
        if (layer.maskLayerId) maskLayerIds.add(layer.maskLayerId);
    }

    for (const layer of LE.layers) {
        if (!layer.visible) continue;
        // Skip layers that are used as masks — they'll be applied via their parent
        if (maskLayerIds.has(layer.id)) continue;

        ctx.save();
        ctx.globalCompositeOperation = layer.blendMode;
        ctx.globalAlpha = layer.opacity;
        const cx = layer.x + layer.width / 2;
        const cy = layer.y + layer.height / 2;

        // If this layer has a mask layer, composite through it
        if (layer.maskLayerId) {
            const maskLayer = LE.layers.find(l => l.id === layer.maskLayerId);
            if (maskLayer && maskLayer.visible) {
                // Render layer + mask into a temp canvas, then draw that
                const tmpCanvas = document.createElement('canvas');
                tmpCanvas.width = LE.documentWidth;
                tmpCanvas.height = LE.documentHeight;
                const tmpCtx = tmpCanvas.getContext('2d');

                // Draw the layer content
                tmpCtx.save();
                tmpCtx.translate(cx, cy);
                tmpCtx.rotate(layer.rotation);
                tmpCtx.scale(layer.scaleX, layer.scaleY);
                tmpCtx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
                tmpCtx.restore();

                // Apply mask: only keep pixels where the mask has content
                tmpCtx.globalCompositeOperation = 'destination-in';
                const mcx = maskLayer.x + maskLayer.width / 2;
                const mcy = maskLayer.y + maskLayer.height / 2;
                tmpCtx.save();
                tmpCtx.translate(mcx, mcy);
                tmpCtx.rotate(maskLayer.rotation);
                tmpCtx.scale(maskLayer.scaleX, maskLayer.scaleY);
                tmpCtx.drawImage(maskLayer.canvas, -maskLayer.width / 2, -maskLayer.height / 2);
                tmpCtx.restore();

                ctx.drawImage(tmpCanvas, 0, 0);
            } else {
                // No valid mask — draw normally
                ctx.translate(cx, cy);
                ctx.rotate(layer.rotation);
                ctx.scale(layer.scaleX, layer.scaleY);
                ctx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
            }
        } else {
            ctx.translate(cx, cy);
            ctx.rotate(layer.rotation);
            ctx.scale(layer.scaleX, layer.scaleY);
            ctx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
        }
        ctx.restore();
    }
    ctx.restore();

    // Draw overlay (selection, handles, etc.)
    drawOverlay();
    updateStatusBar();
}

function renderCompositeToCanvas(targetCtx, w, h) {
    // Render without checkerboard, zoom, or pan — for export
    targetCtx.clearRect(0, 0, w, h);
    const maskLayerIds = new Set();
    for (const layer of LE.layers) {
        if (layer.maskLayerId) maskLayerIds.add(layer.maskLayerId);
    }
    for (const layer of LE.layers) {
        if (!layer.visible) continue;
        if (maskLayerIds.has(layer.id)) continue;
        targetCtx.save();
        targetCtx.globalCompositeOperation = layer.blendMode;
        targetCtx.globalAlpha = layer.opacity;
        const cx = layer.x + layer.width / 2;
        const cy = layer.y + layer.height / 2;

        if (layer.maskLayerId) {
            const maskLayer = LE.layers.find(l => l.id === layer.maskLayerId);
            if (maskLayer && maskLayer.visible) {
                const tmpCanvas = document.createElement('canvas');
                tmpCanvas.width = w; tmpCanvas.height = h;
                const tmpCtx = tmpCanvas.getContext('2d');
                tmpCtx.save();
                tmpCtx.translate(cx, cy);
                tmpCtx.rotate(layer.rotation);
                tmpCtx.scale(layer.scaleX, layer.scaleY);
                tmpCtx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
                tmpCtx.restore();
                tmpCtx.globalCompositeOperation = 'destination-in';
                const mcx = maskLayer.x + maskLayer.width / 2;
                const mcy = maskLayer.y + maskLayer.height / 2;
                tmpCtx.save();
                tmpCtx.translate(mcx, mcy);
                tmpCtx.rotate(maskLayer.rotation);
                tmpCtx.scale(maskLayer.scaleX, maskLayer.scaleY);
                tmpCtx.drawImage(maskLayer.canvas, -maskLayer.width / 2, -maskLayer.height / 2);
                tmpCtx.restore();
                targetCtx.drawImage(tmpCanvas, 0, 0);
            } else {
                targetCtx.translate(cx, cy);
                targetCtx.rotate(layer.rotation);
                targetCtx.scale(layer.scaleX, layer.scaleY);
                targetCtx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
            }
        } else {
            targetCtx.translate(cx, cy);
            targetCtx.rotate(layer.rotation);
            targetCtx.scale(layer.scaleX, layer.scaleY);
            targetCtx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
        }
        targetCtx.restore();
    }
}

// ─── Overlay Drawing (selection, handles) ───────────────────
function drawOverlay() {
    const ctx = LE.overlayCtx;
    ctx.clearRect(0, 0, LE.overlayCanvas.width, LE.overlayCanvas.height);

    const layer = getActiveLayer();
    if (!layer) return;

    ctx.save();
    ctx.translate(LE.viewPanX, LE.viewPanY);
    ctx.scale(LE.viewZoom, LE.viewZoom);

    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    const hw = layer.width * layer.scaleX / 2;
    const hh = layer.height * layer.scaleY / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(layer.rotation);

    // Bounding box
    ctx.strokeStyle = '#4a8acf';
    ctx.lineWidth = 1.5 / LE.viewZoom;
    ctx.setLineDash([6 / LE.viewZoom, 4 / LE.viewZoom]);
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.setLineDash([]);

    // Draw resize handles for transform tool
    if (LE.activeTool === 'transform') {
        const hs = HANDLE_SIZE / LE.viewZoom;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#4a8acf';
        ctx.lineWidth = 1.5 / LE.viewZoom;
        const handles = [
            [-hw, -hh], [0, -hh], [hw, -hh],
            [-hw, 0],              [hw, 0],
            [-hw, hh],  [0, hh],   [hw, hh]
        ];
        for (const [hx, hy] of handles) {
            ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
            ctx.strokeRect(hx - hs/2, hy - hs/2, hs, hs);
        }
    }

    // Rotate handle
    if (LE.activeTool === 'transform') {
        const rOffset = ROTATE_HANDLE_OFFSET / LE.viewZoom;
        const rs = HANDLE_SIZE / LE.viewZoom;
        ctx.beginPath();
        ctx.moveTo(0, -hh);
        ctx.lineTo(0, -hh - rOffset);
        ctx.strokeStyle = '#4a8acf';
        ctx.lineWidth = 1.5 / LE.viewZoom;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -hh - rOffset, rs / 2 + 2 / LE.viewZoom, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#4a8acf';
        ctx.stroke();
    }

    ctx.restore();

    // Draw inpaint mask if active
    if (LE.activeAction === 'inpaint' && LE.inpaintMaskCanvas) {
        ctx.globalAlpha = 0.5;
        ctx.drawImage(LE.inpaintMaskCanvas, 0, 0);
        ctx.globalAlpha = 1.0;
    }

    ctx.restore();

    // Brush cursor (screen space)
    if ((LE.activeTool === 'brush' || LE.activeTool === 'eraser' || LE.activeTool === 'mask') && LE.lastMouseX) {
        const brushSz = LE.activeTool === 'mask' ? LE.maskBrushSize : LE.brushSize;
        const r = brushSz * LE.viewZoom / 2;
        ctx.beginPath();
        ctx.arc(LE.lastMouseX - LE.containerEl.getBoundingClientRect().left,
                LE.lastMouseY - LE.containerEl.getBoundingClientRect().top, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

// ─── Layer Operations ───────────────────────────────────────
function createLayer(name, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width || LE.documentWidth;
    canvas.height = height || LE.documentHeight;
    const ctx = canvas.getContext('2d');
    const layer = {
        id: genId(),
        name: name || `Layer ${nextLayerId - 1}`,
        canvas, ctx,
        visible: true,
        locked: false,
        blendMode: 'source-over',
        opacity: 1.0,
        x: 0, y: 0,
        scaleX: 1.0, scaleY: 1.0,
        rotation: 0,
        width: canvas.width,
        height: canvas.height,
        maskLayerId: null, // ID of layer used as a clipping mask (child mask layer)
        _thumbDirty: true,
        _thumbCanvas: null,
    };
    return layer;
}

function addLayer(name, img) {
    let layer;
    if (img) {
        layer = createLayer(name, img.naturalWidth || img.width, img.naturalHeight || img.height);
        layer.ctx.drawImage(img, 0, 0);
    } else {
        layer = createLayer(name);
    }
    LE.layers.push(layer);
    LE.activeLayerId = layer.id;
    pushUndo({
        desc: `Add layer "${layer.name}"`,
        undo: () => { LE.layers = LE.layers.filter(l => l.id !== layer.id); if (LE.activeLayerId === layer.id) LE.activeLayerId = LE.layers.length > 0 ? LE.layers[LE.layers.length-1].id : null; },
        redo: () => { LE.layers.push(layer); LE.activeLayerId = layer.id; }
    });
    recomposite();
    renderLayerPanel();
    return layer;
}

function removeLayer(id) {
    const idx = LE.layers.findIndex(l => l.id === id);
    if (idx === -1) return;
    const layer = LE.layers[idx];
    LE.layers.splice(idx, 1);
    // Clean up mask references: if any layer used this as a mask, clear it
    for (const l of LE.layers) {
        if (l.maskLayerId === id) l.maskLayerId = null;
    }
    if (LE.activeLayerId === id) {
        LE.activeLayerId = LE.layers.length > 0 ? LE.layers[Math.min(idx, LE.layers.length - 1)].id : null;
    }
    pushUndo({
        desc: `Delete layer "${layer.name}"`,
        undo: () => { LE.layers.splice(idx, 0, layer); LE.activeLayerId = layer.id; },
        redo: () => { LE.layers = LE.layers.filter(l => l.id !== id); if (LE.activeLayerId === id) LE.activeLayerId = LE.layers.length > 0 ? LE.layers[LE.layers.length-1].id : null; }
    });
    recomposite();
    renderLayerPanel();
}

function duplicateLayer(id) {
    const src = LE.layers.find(l => l.id === id);
    if (!src) return;
    const layer = createLayer(src.name + ' copy', src.width, src.height);
    layer.ctx.drawImage(src.canvas, 0, 0);
    layer.visible = src.visible;
    layer.blendMode = src.blendMode;
    layer.opacity = src.opacity;
    layer.x = src.x + 10; layer.y = src.y + 10;
    layer.scaleX = src.scaleX; layer.scaleY = src.scaleY;
    layer.rotation = src.rotation;
    const idx = LE.layers.indexOf(src);
    LE.layers.splice(idx + 1, 0, layer);
    LE.activeLayerId = layer.id;
    pushUndo({
        desc: `Duplicate layer "${src.name}"`,
        undo: () => { LE.layers = LE.layers.filter(l => l.id !== layer.id); LE.activeLayerId = src.id; },
        redo: () => { LE.layers.splice(idx + 1, 0, layer); LE.activeLayerId = layer.id; }
    });
    recomposite();
    renderLayerPanel();
}

function mergeDown(id) {
    const idx = LE.layers.findIndex(l => l.id === id);
    if (idx <= 0) return;
    const upper = LE.layers[idx];
    const lower = LE.layers[idx - 1];

    // Snapshot both for undo
    const upperBackup = document.createElement('canvas');
    upperBackup.width = upper.width; upperBackup.height = upper.height;
    upperBackup.getContext('2d').drawImage(upper.canvas, 0, 0);
    const lowerBackup = document.createElement('canvas');
    lowerBackup.width = lower.width; lowerBackup.height = lower.height;
    lowerBackup.getContext('2d').drawImage(lower.canvas, 0, 0);
    const oldLowerProps = { width: lower.width, height: lower.height, x: lower.x, y: lower.y, scaleX: lower.scaleX, scaleY: lower.scaleY, rotation: lower.rotation };

    // Create merged canvas at document size
    const merged = document.createElement('canvas');
    merged.width = LE.documentWidth;
    merged.height = LE.documentHeight;
    const mctx = merged.getContext('2d');

    // Draw lower
    mctx.save();
    mctx.globalCompositeOperation = 'source-over';
    mctx.globalAlpha = lower.opacity;
    const lcx = lower.x + lower.width / 2;
    const lcy = lower.y + lower.height / 2;
    mctx.translate(lcx, lcy);
    mctx.rotate(lower.rotation);
    mctx.scale(lower.scaleX, lower.scaleY);
    mctx.drawImage(lower.canvas, -lower.width / 2, -lower.height / 2);
    mctx.restore();

    // Draw upper with blend mode
    mctx.save();
    mctx.globalCompositeOperation = upper.blendMode;
    mctx.globalAlpha = upper.opacity;
    const ucx = upper.x + upper.width / 2;
    const ucy = upper.y + upper.height / 2;
    mctx.translate(ucx, ucy);
    mctx.rotate(upper.rotation);
    mctx.scale(upper.scaleX, upper.scaleY);
    mctx.drawImage(upper.canvas, -upper.width / 2, -upper.height / 2);
    mctx.restore();

    // Replace lower with merged
    lower.canvas = merged;
    lower.ctx = mctx;
    lower.width = LE.documentWidth;
    lower.height = LE.documentHeight;
    lower.x = 0; lower.y = 0;
    lower.scaleX = 1; lower.scaleY = 1;
    lower.rotation = 0;
    lower.opacity = 1.0;
    lower.blendMode = 'source-over';
    lower._thumbDirty = true;

    // Remove upper
    LE.layers.splice(idx, 1);
    LE.activeLayerId = lower.id;

    pushUndo({
        desc: `Merge "${upper.name}" into "${lower.name}"`,
        undo: () => {
            lower.canvas = lowerBackup; lower.ctx = lowerBackup.getContext('2d');
            Object.assign(lower, oldLowerProps);
            lower._thumbDirty = true;
            LE.layers.splice(idx, 0, upper);
            upper.canvas = upperBackup; upper.ctx = upperBackup.getContext('2d');
            upper._thumbDirty = true;
            LE.activeLayerId = upper.id;
        },
        redo: () => {
            lower.canvas = merged; lower.ctx = mctx;
            lower.width = LE.documentWidth; lower.height = LE.documentHeight;
            lower.x = 0; lower.y = 0; lower.scaleX = 1; lower.scaleY = 1; lower.rotation = 0;
            lower.opacity = 1.0; lower.blendMode = 'source-over'; lower._thumbDirty = true;
            LE.layers = LE.layers.filter(l => l.id !== upper.id);
            LE.activeLayerId = lower.id;
        }
    });

    recomposite();
    renderLayerPanel();
}

function flattenAll() {
    if (LE.layers.length <= 1) return;
    const backup = LE.layers.map(l => ({
        layer: l,
        canvasBackup: (() => { const c = document.createElement('canvas'); c.width = l.width; c.height = l.height; c.getContext('2d').drawImage(l.canvas, 0, 0); return c; })(),
        props: { width: l.width, height: l.height, x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY, rotation: l.rotation, opacity: l.opacity, blendMode: l.blendMode, visible: l.visible, locked: l.locked }
    }));

    const merged = document.createElement('canvas');
    merged.width = LE.documentWidth;
    merged.height = LE.documentHeight;
    renderCompositeToCanvas(merged.getContext('2d'), LE.documentWidth, LE.documentHeight);

    const flat = createLayer('Flattened', LE.documentWidth, LE.documentHeight);
    flat.ctx.drawImage(merged, 0, 0);

    const oldLayers = [...LE.layers];
    LE.layers = [flat];
    LE.activeLayerId = flat.id;

    pushUndo({
        desc: 'Flatten all layers',
        undo: () => { LE.layers = oldLayers; backup.forEach(b => { b.layer.canvas = b.canvasBackup; b.layer.ctx = b.canvasBackup.getContext('2d'); Object.assign(b.layer, b.props); b.layer._thumbDirty = true; }); LE.activeLayerId = oldLayers[oldLayers.length - 1].id; },
        redo: () => { LE.layers = [flat]; LE.activeLayerId = flat.id; }
    });

    recomposite();
    renderLayerPanel();
}

// ─── Edge Mask & Smart Merge ────────────────────────────────
// Creates a mask highlighting the edges of layers — the seam areas
// where different layer contents meet. Uses canvas shadowBlur for
// fast dilation without pixel-level iteration.

function createLayerEdgeBand(layer, padding, docW, docH) {
    // Draw the layer's silhouette at its position in document space
    const silhouette = document.createElement('canvas');
    silhouette.width = docW; silhouette.height = docH;
    const sctx = silhouette.getContext('2d');
    sctx.save();
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    sctx.translate(cx, cy);
    sctx.rotate(layer.rotation);
    sctx.scale(layer.scaleX, layer.scaleY);
    sctx.drawImage(layer.canvas, -layer.width / 2, -layer.height / 2);
    sctx.restore();

    // Create dilated version using shadow
    const edge = document.createElement('canvas');
    edge.width = docW; edge.height = docH;
    const ectx = edge.getContext('2d');

    // Trick: draw the silhouette offset far off-screen, but its shadow
    // (which is the dilated version) lands at the correct position.
    ectx.shadowColor = 'white';
    ectx.shadowBlur = padding;
    ectx.shadowOffsetX = docW * 2;
    ectx.drawImage(silhouette, -docW * 2, 0);

    // Now edge has ONLY the shadow (dilated halo + filled interior from shadow).
    // Subtract the original silhouette to keep only the edge band.
    ectx.shadowColor = 'transparent';
    ectx.shadowBlur = 0;
    ectx.shadowOffsetX = 0;
    ectx.globalCompositeOperation = 'destination-out';
    // Erode slightly: shrink the cutout by drawing the silhouette
    // at a few inward offsets so the edge band extends inward too
    const inset = Math.min(padding * 0.4, 8);
    const steps = Math.max(1, Math.ceil(inset));
    for (let s = 0; s < steps; s++) {
        const t = (s + 1) / (steps + 1); // 0..1 fraction of inset
        const off = t * inset;
        // Draw shrunk silhouette by scaling down slightly from center
        ectx.save();
        ectx.translate(docW / 2, docH / 2);
        const scaleFactor = 1 - (off * 2) / Math.max(docW, docH);
        ectx.scale(scaleFactor, scaleFactor);
        ectx.translate(-docW / 2, -docH / 2);
        ectx.drawImage(silhouette, 0, 0);
        ectx.restore();
    }

    return edge;
}

function createSeamMask(layers, padding) {
    padding = padding || 30;
    const w = LE.documentWidth, h = LE.documentHeight;
    const mask = document.createElement('canvas');
    mask.width = w; mask.height = h;
    const mctx = mask.getContext('2d');

    for (const layer of layers) {
        if (!layer.visible) continue;
        const band = createLayerEdgeBand(layer, padding, w, h);
        mctx.drawImage(band, 0, 0);
    }
    return mask;
}

function smartMergeDown(id) {
    const idx = LE.layers.findIndex(l => l.id === id);
    if (idx <= 0) return;

    // Capture the layers involved BEFORE merging (for edge mask)
    const upper = LE.layers[idx];
    const lower = LE.layers[idx - 1];
    const edgeLayers = [upper, lower];

    // Create the seam mask from both layers' edges
    const seamMask = createSeamMask(edgeLayers, 30);

    // Do the normal merge
    mergeDown(id);

    // Now set up inpaint with the seam mask at low denoise
    _triggerSmartBlend(seamMask);
}

function smartFlattenAll() {
    if (LE.layers.length <= 1) return;

    // Capture all layers' edges BEFORE flattening
    const edgeLayers = LE.layers.filter(l => l.visible);
    const seamMask = createSeamMask(edgeLayers, 30);

    // Do the normal flatten
    flattenAll();

    // Trigger smart blend with the seam mask
    _triggerSmartBlend(seamMask);
}

function _triggerSmartBlend(seamMask) {
    // Set the seam mask as the inpaint mask
    LE.inpaintMaskCanvas = seamMask;
    LE.inpaintMaskCtx = seamMask.getContext('2d');

    // Temporarily activate inpaint action to enable mask rendering
    const prevAction = LE.activeAction;
    LE.activeAction = 'inpaint';
    LE.containerEl.classList.add('mask-mode');
    recomposite();

    // Show the seam mask preview for a moment, then trigger generation
    showProgress('Smart blend: generating with seam mask...');

    // Use the merged/flattened layer as source
    const layer = getActiveLayer();
    if (!layer) {
        hideProgress();
        LE.activeAction = prevAction;
        LE.containerEl.classList.remove('mask-mode');
        return;
    }

    LE.isGenerating = true;
    LE._smartBlendPrevAction = prevAction;

    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = layer.width;
    sourceCanvas.height = layer.height;
    sourceCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);

    sourceCanvas.toBlob((blob) => {
        if (!blob) {
            LE.isGenerating = false;
            hideProgress();
            LE.activeAction = prevAction;
            LE.containerEl.classList.remove('mask-mode');
            return;
        }
        _triggerSmartBlendGenerate(blob, layer);
    }, 'image/png');
}

async function _triggerSmartBlendGenerate(imageBlob, activeLayer) {
    const file = new File([imageBlob], 'le_source.png', { type: 'image/png' });
    LE._savedImageNumber = null;
    LE._savedPositivePrompt = null;
    LE._generatingViaGradio = true;

    try {
        // 1. Ensure Input Image is checked
        setGradioCheckboxByLabel('Input Image', true);
        await sleep(500);

        // 2. Set inpaint tab
        clickTabByName('Inpaint or Outpaint');
        setCurrentTab('inpaint');
        await sleep(400);

        // 3. Upload source image and mask to server, set via Python handler
        showProgress('Uploading for smart blend...');
        const sourcePath = await uploadBlob(imageBlob, 'le_source.png');
        if (!sourcePath) throw new Error('Failed to upload source image');

        let maskPath = null;
        if (LE.inpaintMaskCanvas && activeLayer) {
            const maskExport = document.createElement('canvas');
            maskExport.width = activeLayer.width;
            maskExport.height = activeLayer.height;
            const mectx = maskExport.getContext('2d');
            mectx.fillStyle = '#000';
            mectx.fillRect(0, 0, maskExport.width, maskExport.height);
            const cx = activeLayer.x + activeLayer.width / 2;
            const cy = activeLayer.y + activeLayer.height / 2;
            mectx.save();
            mectx.translate(activeLayer.width / 2, activeLayer.height / 2);
            mectx.scale(1 / activeLayer.scaleX, 1 / activeLayer.scaleY);
            mectx.rotate(-activeLayer.rotation);
            mectx.translate(-cx, -cy);
            mectx.drawImage(LE.inpaintMaskCanvas, 0, 0);
            mectx.restore();
            const maskBlob = await new Promise(r => maskExport.toBlob(r, 'image/png'));
            if (maskBlob) {
                maskPath = await uploadBlob(maskBlob, 'le_mask.png');
            }
        }

        // Set both Gradio components via Python handler
        await sendCommandAsync({
            action: 'set_inpaint',
            source_path: sourcePath,
            mask_path: maskPath || ''
        });
        await sleep(500);

        // 4. Set inpaint mode to "Inpaint or Outpaint (default)"
        setGradioDropdown('#inpaint_mode_selector', 'Inpaint or Outpaint (default)');
        await sleep(300);

        // 5. Clear outpaint directions
        setGradioCheckboxGroup('#outpaint_selections', []);
        await sleep(200);

        // 6. Set denoise strength to 0.36 for subtle blending
        const strengthInput = document.querySelector('#inpaint_strength input[type="number"]');
        const savedStrength = strengthInput ? strengthInput.value : null;
        setGradioSlider('#inpaint_strength', 0.36);
        await sleep(200);

        // 7. Enable advanced masking
        setGradioCheckboxByLabel('Enable Advanced Masking Features', true);
        await sleep(300);

        // 8. Set image count to 1
        setImageNumberSlider(1);
        await sleep(200);

        // 9. Register post-generation callback to restore settings
        const prevAction = LE._smartBlendPrevAction || null;
        LE._postGenerateCallback = () => {
            // Restore inpaint strength
            if (savedStrength != null) {
                setGradioSlider('#inpaint_strength', parseFloat(savedStrength));
            }
            // Restore previous action mode
            LE.activeAction = prevAction;
            if (!prevAction || prevAction !== 'inpaint') {
                LE.containerEl.classList.remove('mask-mode');
                LE.inpaintMaskCanvas = null;
                LE.inpaintMaskCtx = null;
            }
            // Update action button styles
            document.querySelectorAll('#le-action-buttons .le-action-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.action === prevAction);
            });
            renderActionControls(prevAction);
            recomposite();
        };

        // 10. Remember gallery state for result detection
        LE._preGalleryCount = document.querySelectorAll('#final_gallery .thumbnail-item img, #final_gallery .grid-container img').length;
        const galleryImgs = document.querySelectorAll('#final_gallery img');
        LE._preGallerySrcs = new Set();
        galleryImgs.forEach(img => { if (img.src) LE._preGallerySrcs.add(img.src); });
        LE._preGalleryFirstSrc = galleryImgs.length > 0 ? galleryImgs[0].src : null;

        // 11. Click generate
        showProgress('Generating smart blend...');
        const genBtn = document.querySelector('#generate_button');
        if (genBtn) {
            genBtn.click();
            console.log('[LE] Smart blend: generate clicked');
        } else {
            throw new Error('Generate button not found');
        }

        // 12. Watch for result (uses standard flow → finishGradioGeneration)
        watchForGradioResult(activeLayer);

    } catch (e) {
        console.error('[LE] Smart blend error:', e);
        LE.isGenerating = false;
        LE._generatingViaGradio = false;
        LE._postGenerateCallback = null;
        hideProgress();
    }
}

function moveLayerInStack(id, direction) {
    const idx = LE.layers.findIndex(l => l.id === id);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= LE.layers.length) return;
    const temp = LE.layers[idx];
    LE.layers[idx] = LE.layers[newIdx];
    LE.layers[newIdx] = temp;
    pushUndo({
        desc: `Move layer "${temp.name}"`,
        undo: () => { const a = LE.layers[idx]; LE.layers[idx] = LE.layers[newIdx]; LE.layers[newIdx] = a; },
        redo: () => { const a = LE.layers[idx]; LE.layers[idx] = LE.layers[newIdx]; LE.layers[newIdx] = a; }
    });
    recomposite();
    renderLayerPanel();
}

// ─── Layer Thumbnails ───────────────────────────────────────
let thumbUpdateTimer = null;
function scheduleThumbUpdate() {
    if (thumbUpdateTimer) return;
    thumbUpdateTimer = setTimeout(() => {
        thumbUpdateTimer = null;
        LE.layers.forEach(layer => {
            if (!layer._thumbDirty) return;
            layer._thumbDirty = false;
            if (!layer._thumbCanvas) {
                layer._thumbCanvas = document.createElement('canvas');
                layer._thumbCanvas.width = THUMBNAIL_SIZE;
                layer._thumbCanvas.height = THUMBNAIL_SIZE;
            }
            const tc = layer._thumbCanvas.getContext('2d');
            tc.clearRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
            const scale = Math.min(THUMBNAIL_SIZE / layer.width, THUMBNAIL_SIZE / layer.height);
            const dx = (THUMBNAIL_SIZE - layer.width * scale) / 2;
            const dy = (THUMBNAIL_SIZE - layer.height * scale) / 2;
            tc.drawImage(layer.canvas, dx, dy, layer.width * scale, layer.height * scale);
            // Update the img element in the panel
            const thumbEl = document.querySelector(`[data-layer-id="${layer.id}"] .le-layer-thumb`);
            if (thumbEl) thumbEl.src = layer._thumbCanvas.toDataURL();
        });
    }, 300);
}

// ─── Layer Panel Rendering ──────────────────────────────────
function renderLayerPanel() {
    const list = document.getElementById('le-layer-list');
    if (!list) return;

    list.innerHTML = '';

    // Build a set of IDs that are used as mask layers
    const maskLayerIds = new Set();
    for (const layer of LE.layers) {
        if (layer.maskLayerId) maskLayerIds.add(layer.maskLayerId);
    }

    // Render top to bottom (reversed array order: top layer first in panel)
    for (let i = LE.layers.length - 1; i >= 0; i--) {
        const layer = LE.layers[i];
        const isActive = layer.id === LE.activeLayerId;
        const isMaskChild = maskLayerIds.has(layer.id);

        const item = document.createElement('div');
        item.className = 'le-layer-item' + (isActive ? ' active' : '') + (isMaskChild ? ' le-mask-child' : '');
        item.dataset.layerId = layer.id;
        item.dataset.layerIndex = i;
        item.draggable = true;

        // Top row: thumb, name, icons
        const topRow = document.createElement('div');
        topRow.className = 'le-layer-row-top';

        // Mask indicator for child mask layers
        if (isMaskChild) {
            const maskIcon = document.createElement('span');
            maskIcon.className = 'le-mask-indicator';
            maskIcon.innerHTML = '&#9740;'; // mask symbol
            maskIcon.title = 'This layer is used as a mask';
            topRow.appendChild(maskIcon);
        }

        // Thumbnail
        const thumb = document.createElement('img');
        thumb.className = 'le-layer-thumb';
        thumb.src = layer._thumbCanvas ? layer._thumbCanvas.toDataURL() : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        layer._thumbDirty = true;
        topRow.appendChild(thumb);

        // Name
        const name = document.createElement('span');
        name.className = 'le-layer-name';
        name.textContent = layer.name;
        name.ondblclick = (e) => {
            e.stopPropagation();
            const input = document.createElement('input');
            input.value = layer.name;
            input.onblur = () => { layer.name = input.value || layer.name; renderLayerPanel(); };
            input.onkeydown = (ev) => { if (ev.key === 'Enter') input.blur(); if (ev.key === 'Escape') { input.value = layer.name; input.blur(); } };
            name.innerHTML = '';
            name.appendChild(input);
            input.focus();
            input.select();
        };
        topRow.appendChild(name);

        // Visibility
        const visBtn = document.createElement('button');
        visBtn.className = 'le-layer-icon-btn' + (layer.visible ? '' : ' off');
        visBtn.innerHTML = layer.visible ? '&#128065;' : '&#128065;';
        visBtn.title = 'Toggle visibility';
        visBtn.onclick = (e) => { e.stopPropagation(); layer.visible = !layer.visible; recomposite(); renderLayerPanel(); };
        topRow.appendChild(visBtn);

        // Lock
        const lockBtn = document.createElement('button');
        lockBtn.className = 'le-layer-icon-btn' + (layer.locked ? '' : ' off');
        lockBtn.innerHTML = layer.locked ? '&#128274;' : '&#128275;';
        lockBtn.title = 'Toggle lock';
        lockBtn.onclick = (e) => { e.stopPropagation(); layer.locked = !layer.locked; renderLayerPanel(); };
        topRow.appendChild(lockBtn);

        // Move up
        const upBtn = document.createElement('button');
        upBtn.className = 'le-layer-icon-btn';
        upBtn.innerHTML = '&#9650;';
        upBtn.title = 'Move up';
        upBtn.onclick = (e) => { e.stopPropagation(); moveLayerInStack(layer.id, 1); };
        topRow.appendChild(upBtn);

        // Move down
        const downBtn = document.createElement('button');
        downBtn.className = 'le-layer-icon-btn';
        downBtn.innerHTML = '&#9660;';
        downBtn.title = 'Move down';
        downBtn.onclick = (e) => { e.stopPropagation(); moveLayerInStack(layer.id, -1); };
        topRow.appendChild(downBtn);

        item.appendChild(topRow);

        // Bottom row: blend mode + opacity
        const bottomRow = document.createElement('div');
        bottomRow.className = 'le-layer-row-bottom';

        const blendSel = document.createElement('select');
        for (const mode of BLEND_MODES) {
            const opt = document.createElement('option');
            opt.value = mode.value;
            opt.textContent = mode.label;
            if (layer.blendMode === mode.value) opt.selected = true;
            blendSel.appendChild(opt);
        }
        blendSel.onchange = (e) => { e.stopPropagation(); layer.blendMode = blendSel.value; recomposite(); };
        bottomRow.appendChild(blendSel);

        const opacitySlider = document.createElement('input');
        opacitySlider.type = 'range';
        opacitySlider.min = 0; opacitySlider.max = 100;
        opacitySlider.value = Math.round(layer.opacity * 100);
        const opacityLabel = document.createElement('span');
        opacityLabel.className = 'le-layer-opacity-label';
        opacityLabel.textContent = Math.round(layer.opacity * 100) + '%';
        opacitySlider.oninput = (e) => {
            e.stopPropagation();
            layer.opacity = parseInt(opacitySlider.value) / 100;
            opacityLabel.textContent = opacitySlider.value + '%';
            recomposite();
        };
        bottomRow.appendChild(opacitySlider);
        bottomRow.appendChild(opacityLabel);

        item.appendChild(bottomRow);

        // Click to select
        item.onclick = () => { LE.activeLayerId = layer.id; recomposite(); renderLayerPanel(); };

        // Right-click context menu
        item.oncontextmenu = (e) => { e.preventDefault(); showLayerContextMenu(e, layer); };

        // Drag and drop: hold Shift while dropping to set as mask layer,
        // otherwise reorder as before
        item.ondragstart = (e) => {
            e.dataTransfer.setData('text/plain', layer.id);
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(() => item.style.opacity = '0.4', 0);
        };
        item.ondragend = () => { item.style.opacity = '1'; };
        item.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // Visual cue: if Alt held, show mask-drop indicator
            if (e.altKey) {
                item.classList.add('mask-drop-target');
                item.classList.remove('drag-over');
            } else {
                item.classList.add('drag-over');
                item.classList.remove('mask-drop-target');
            }
        };
        item.ondragleave = () => { item.classList.remove('drag-over'); item.classList.remove('mask-drop-target'); };
        item.ondrop = (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            item.classList.remove('mask-drop-target');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (draggedId === layer.id) return;

            // Alt+Drop: set the dragged layer as a mask for this layer
            if (e.altKey) {
                const targetLayer = layer;
                const draggedLayer = LE.layers.find(l => l.id === draggedId);
                if (draggedLayer && targetLayer) {
                    // Remove any existing mask assignment for this target
                    targetLayer.maskLayerId = draggedId;
                    console.log('[LE] Set layer "' + draggedLayer.name + '" as mask for "' + targetLayer.name + '"');
                    recomposite();
                    renderLayerPanel();
                }
                return;
            }

            // Normal drop: reorder
            const fromIdx = LE.layers.findIndex(l => l.id === draggedId);
            const toIdx = parseInt(item.dataset.layerIndex);
            if (fromIdx === -1 || fromIdx === toIdx) return;
            const moved = LE.layers.splice(fromIdx, 1)[0];
            LE.layers.splice(toIdx, 0, moved);
            recomposite();
            renderLayerPanel();
        };

        list.appendChild(item);
    }

    scheduleThumbUpdate();
}

function showLayerContextMenu(e, layer) {
    // Remove any existing
    const old = document.querySelector('.le-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.className = 'le-context-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    // Check if this layer is being used as a mask, or has a mask
    const isUsedAsMask = LE.layers.some(l => l.maskLayerId === layer.id);
    const hasMask = !!layer.maskLayerId;
    const parentOfMask = hasMask ? LE.layers.find(l => l.id === layer.maskLayerId) : null;

    const items = [
        { label: 'Rename', action: () => { const el = document.querySelector(`[data-layer-id="${layer.id}"] .le-layer-name`); if (el) el.ondblclick(new Event('dblclick')); }},
        { label: 'Duplicate', action: () => duplicateLayer(layer.id) },
        { sep: true },
    ];

    // Mask options
    if (isUsedAsMask) {
        const parentLayer = LE.layers.find(l => l.maskLayerId === layer.id);
        items.push({ label: `Release as mask for "${parentLayer ? parentLayer.name : '?'}"`, action: () => {
            if (parentLayer) { parentLayer.maskLayerId = null; recomposite(); renderLayerPanel(); }
        }});
    }
    if (hasMask) {
        items.push({ label: `Remove mask (${parentOfMask ? parentOfMask.name : '?'})`, action: () => {
            layer.maskLayerId = null; recomposite(); renderLayerPanel();
        }});
    }
    if (!isUsedAsMask && LE.layers.length > 1) {
        // Offer to set as mask for adjacent layer below
        const idx = LE.layers.indexOf(layer);
        if (idx > 0) {
            const below = LE.layers[idx - 1];
            items.push({ label: `Set as mask for "${below.name}"`, action: () => {
                below.maskLayerId = layer.id; recomposite(); renderLayerPanel();
            }});
        }
    }

    items.push({ sep: true });
    items.push({ label: 'Merge Down', action: () => mergeDown(layer.id) });
    items.push({ label: 'Smart Merge Down', action: () => smartMergeDown(layer.id) });
    items.push({ sep: true });
    items.push({ label: 'Flatten All', action: () => flattenAll() });
    items.push({ label: 'Smart Flatten All', action: () => smartFlattenAll() });
    items.push({ sep: true });
    items.push({ label: 'Delete', action: () => removeLayer(layer.id) });

    for (const item of items) {
        if (item.sep) {
            const sep = document.createElement('div');
            sep.className = 'le-context-menu-separator';
            menu.appendChild(sep);
        } else {
            const el = document.createElement('div');
            el.className = 'le-context-menu-item';
            el.textContent = item.label;
            el.onclick = () => { menu.remove(); item.action(); };
            menu.appendChild(el);
        }
    }

    document.body.appendChild(menu);
    const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu, true); }
    };
    setTimeout(() => document.addEventListener('mousedown', closeMenu, true), 0);
}

// ─── Image Import ───────────────────────────────────────────
function loadImageAsLayer(src, name) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const layer = addLayer(name || 'Image', img);
            resolve(layer);
        };
        img.onerror = () => { console.warn('Failed to load image:', src); resolve(null); };
        img.src = src;
    });
}

function handleFileImport(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = (e) => loadImageAsLayer(e.target.result, file.name.replace(/\.[^.]+$/, ''));
        reader.readAsDataURL(file);
    }
}

// ─── Tools ──────────────────────────────────────────────────
function setTool(toolName) {
    // The mask tool is only available when inpaint action is active
    if (toolName === 'mask' && LE.activeAction !== 'inpaint') return;
    LE.activeTool = toolName;
    document.querySelectorAll('.le-tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === toolName);
    });

    // Update cursor
    const cursors = { transform: 'default', brush: 'crosshair', eraser: 'crosshair', mask: 'crosshair' };
    LE.containerEl.style.cursor = cursors[toolName] || 'default';

    recomposite();
}

// --- Unified Transform Tool (Select + Move + Resize + Rotate) ---
// Like Photoshop: click to select, drag body to move, drag corner/edge handles
// to resize, drag rotate handle to rotate.

function getResizeHandle(cx, cy, layer) {
    if (!layer) return null;
    const lcx = layer.x + layer.width / 2;
    const lcy = layer.y + layer.height / 2;
    const cos = Math.cos(-layer.rotation);
    const sin = Math.sin(-layer.rotation);
    const dx = cx - lcx;
    const dy = cy - lcy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const hw = layer.width * layer.scaleX / 2;
    const hh = layer.height * layer.scaleY / 2;
    const hs = HANDLE_SIZE / LE.viewZoom * 2;

    const handles = [
        { name: 'tl', x: -hw, y: -hh }, { name: 'tc', x: 0, y: -hh }, { name: 'tr', x: hw, y: -hh },
        { name: 'ml', x: -hw, y: 0 },                                    { name: 'mr', x: hw, y: 0 },
        { name: 'bl', x: -hw, y: hh },  { name: 'bc', x: 0, y: hh },   { name: 'br', x: hw, y: hh },
    ];
    for (const h of handles) {
        if (Math.abs(lx - h.x) < hs && Math.abs(ly - h.y) < hs) return h.name;
    }
    return null;
}

function getRotateHandle(cx, cy, layer) {
    if (!layer) return false;
    const lcx = layer.x + layer.width / 2;
    const lcy = layer.y + layer.height / 2;
    const cos = Math.cos(-layer.rotation);
    const sin = Math.sin(-layer.rotation);
    const dx = cx - lcx;
    const dy = cy - lcy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    const hh = layer.height * layer.scaleY / 2;
    const rOffset = ROTATE_HANDLE_OFFSET / LE.viewZoom;
    const hs = HANDLE_SIZE / LE.viewZoom * 2;
    return Math.abs(lx) < hs && Math.abs(ly - (-hh - rOffset)) < hs;
}

function toolTransformDown(cx, cy) {
    const layer = getActiveLayer();

    // First check: if there's an active layer, check for rotate handle hit
    if (layer && !layer.locked && getRotateHandle(cx, cy, layer)) {
        const lcx = layer.x + layer.width / 2;
        const lcy = layer.y + layer.height / 2;
        LE.toolState = {
            mode: 'rotate',
            centerX: lcx, centerY: lcy,
            origRotation: layer.rotation,
            startAngle: Math.atan2(cy - lcy, cx - lcx)
        };
        LE.isDragging = true;
        return;
    }

    // Second: check for resize handle hit
    if (layer && !layer.locked) {
        const handle = getResizeHandle(cx, cy, layer);
        if (handle) {
            LE.toolState = {
                mode: 'resize',
                handle, startX: cx, startY: cy,
                origScaleX: layer.scaleX, origScaleY: layer.scaleY,
                origX: layer.x, origY: layer.y
            };
            LE.isDragging = true;
            return;
        }
    }

    // Third: check if clicking inside the active layer bounds → move
    if (layer && !layer.locked && pointInLayerBounds(cx, cy, layer)) {
        LE.toolState = {
            mode: 'move',
            startX: cx, startY: cy,
            origX: layer.x, origY: layer.y
        };
        LE.isDragging = true;
        return;
    }

    // Fourth: hit-test to select a different layer
    const hitLayer = hitTestLayers(cx, cy);
    if (hitLayer) {
        LE.activeLayerId = hitLayer.id;
        recomposite();
        renderLayerPanel();
        // Start moving immediately
        if (!hitLayer.locked) {
            LE.toolState = {
                mode: 'move',
                startX: cx, startY: cy,
                origX: hitLayer.x, origY: hitLayer.y
            };
            LE.isDragging = true;
        }
    } else {
        // Clicked empty space: deselect
        LE.activeLayerId = null;
        recomposite();
        renderLayerPanel();
    }
}

function toolTransformMove(cx, cy, shiftKey) {
    if (!LE.isDragging || !LE.toolState) return;
    const layer = getActiveLayer();
    if (!layer) return;

    switch (LE.toolState.mode) {
        case 'move': {
            const dx = cx - LE.toolState.startX;
            const dy = cy - LE.toolState.startY;
            layer.x = LE.toolState.origX + dx;
            layer.y = LE.toolState.origY + dy;
            layer._thumbDirty = true;
            recomposite();
            break;
        }
        case 'resize': {
            const { handle, startX, startY, origScaleX, origScaleY } = LE.toolState;
            const dcx = (cx - startX) / layer.width;
            const dcy = (cy - startY) / layer.height;
            let newSX = origScaleX, newSY = origScaleY;
            if (handle.includes('r')) newSX = Math.max(0.05, origScaleX + dcx);
            if (handle.includes('l')) newSX = Math.max(0.05, origScaleX - dcx);
            if (handle.includes('b')) newSY = Math.max(0.05, origScaleY + dcy);
            if (handle.includes('t')) newSY = Math.max(0.05, origScaleY - dcy);
            if (shiftKey) {
                const avgScale = (newSX / origScaleX + newSY / origScaleY) / 2;
                newSX = origScaleX * avgScale;
                newSY = origScaleY * avgScale;
            }
            layer.scaleX = newSX;
            layer.scaleY = newSY;
            layer._thumbDirty = true;
            recomposite();
            break;
        }
        case 'rotate': {
            const { centerX, centerY, origRotation, startAngle } = LE.toolState;
            let angle = Math.atan2(cy - centerY, cx - centerX) - startAngle + origRotation;
            if (shiftKey) {
                const snap = Math.PI / 12; // 15 degrees
                angle = Math.round(angle / snap) * snap;
            }
            layer.rotation = angle;
            layer._thumbDirty = true;
            recomposite();
            break;
        }
    }
}

function toolTransformUp() {
    if (!LE.isDragging || !LE.toolState) return;
    LE.isDragging = false;
    const layer = getActiveLayer();
    if (!layer) return;

    switch (LE.toolState.mode) {
        case 'move': {
            const { origX, origY } = LE.toolState;
            const newX = layer.x, newY = layer.y;
            if (origX !== newX || origY !== newY) {
                pushUndo({
                    desc: `Move "${layer.name}"`,
                    undo: () => { layer.x = origX; layer.y = origY; layer._thumbDirty = true; },
                    redo: () => { layer.x = newX; layer.y = newY; layer._thumbDirty = true; }
                });
            }
            break;
        }
        case 'resize': {
            const { origScaleX, origScaleY } = LE.toolState;
            const nsx = layer.scaleX, nsy = layer.scaleY;
            if (origScaleX !== nsx || origScaleY !== nsy) {
                pushUndo({
                    desc: `Resize "${layer.name}"`,
                    undo: () => { layer.scaleX = origScaleX; layer.scaleY = origScaleY; layer._thumbDirty = true; },
                    redo: () => { layer.scaleX = nsx; layer.scaleY = nsy; layer._thumbDirty = true; }
                });
            }
            break;
        }
        case 'rotate': {
            const { origRotation } = LE.toolState;
            const newRot = layer.rotation;
            if (origRotation !== newRot) {
                pushUndo({
                    desc: `Rotate "${layer.name}"`,
                    undo: () => { layer.rotation = origRotation; layer._thumbDirty = true; },
                    redo: () => { layer.rotation = newRot; layer._thumbDirty = true; }
                });
            }
            break;
        }
    }
}

// --- Tool: Brush ---
function toolBrushDown(cx, cy, isEraser) {
    const layer = getActiveLayer();
    if (!layer || layer.locked) return;

    // Snapshot for undo
    const backup = document.createElement('canvas');
    backup.width = layer.width; backup.height = layer.height;
    backup.getContext('2d').drawImage(layer.canvas, 0, 0);
    LE.toolState = { backup, layerId: layer.id };

    // Transform point to layer-local coordinates
    const lcx = layer.x + layer.width / 2;
    const lcy = layer.y + layer.height / 2;
    const cos = Math.cos(-layer.rotation);
    const sin = Math.sin(-layer.rotation);
    const dx = cx - lcx; const dy = cy - lcy;
    const lx = (dx * cos - dy * sin) / layer.scaleX + layer.width / 2;
    const ly = (dx * sin + dy * cos) / layer.scaleY + layer.height / 2;

    layer.ctx.save();
    if (isEraser) {
        layer.ctx.globalCompositeOperation = 'destination-out';
    }
    layer.ctx.globalAlpha = LE.brushOpacity;
    layer.ctx.strokeStyle = isEraser ? 'rgba(0,0,0,1)' : LE.brushColor;
    layer.ctx.lineWidth = LE.brushSize / layer.scaleX;
    layer.ctx.lineCap = 'round';
    layer.ctx.lineJoin = 'round';
    // Apply softness via shadow blur (simulates soft brush edge)
    if (LE.brushSoftness > 0 && !isEraser) {
        layer.ctx.shadowColor = LE.brushColor;
        layer.ctx.shadowBlur = LE.brushSoftness * (LE.brushSize / layer.scaleX) * 0.5;
    }
    layer.ctx.beginPath();
    layer.ctx.moveTo(lx, ly);
    LE.toolState.lastLX = lx;
    LE.toolState.lastLY = ly;
    LE.isDragging = true;
}
function toolBrushMove(cx, cy, isEraser) {
    if (!LE.isDragging) return;
    const layer = getActiveLayer();
    if (!layer) return;

    const lcx = layer.x + layer.width / 2;
    const lcy = layer.y + layer.height / 2;
    const cos = Math.cos(-layer.rotation);
    const sin = Math.sin(-layer.rotation);
    const dx = cx - lcx; const dy = cy - lcy;
    const lx = (dx * cos - dy * sin) / layer.scaleX + layer.width / 2;
    const ly = (dx * sin + dy * cos) / layer.scaleY + layer.height / 2;

    layer.ctx.lineTo(lx, ly);
    layer.ctx.stroke();
    layer.ctx.beginPath();
    layer.ctx.moveTo(lx, ly);
    LE.toolState.lastLX = lx;
    LE.toolState.lastLY = ly;
    layer._thumbDirty = true;
    recomposite();
}
function toolBrushUp(isEraser) {
    if (!LE.isDragging) return;
    LE.isDragging = false;
    const layer = getActiveLayer();
    if (!layer) return;
    layer.ctx.restore();
    layer._thumbDirty = true;

    const { backup, layerId } = LE.toolState;
    const newState = document.createElement('canvas');
    newState.width = layer.width; newState.height = layer.height;
    newState.getContext('2d').drawImage(layer.canvas, 0, 0);
    pushUndo({
        desc: `${isEraser ? 'Erase' : 'Paint'} on "${layer.name}"`,
        undo: () => { const l = LE.layers.find(x => x.id === layerId); if (l) { l.ctx.clearRect(0,0,l.width,l.height); l.ctx.drawImage(backup,0,0); l._thumbDirty = true; } },
        redo: () => { const l = LE.layers.find(x => x.id === layerId); if (l) { l.ctx.clearRect(0,0,l.width,l.height); l.ctx.drawImage(newState,0,0); l._thumbDirty = true; } }
    });
    recomposite();
}

// --- Inpaint mask painting ---
function toolMaskDown(cx, cy, isEraser) {
    if (!LE.inpaintMaskCanvas) {
        LE.inpaintMaskCanvas = document.createElement('canvas');
        LE.inpaintMaskCanvas.width = LE.documentWidth;
        LE.inpaintMaskCanvas.height = LE.documentHeight;
        LE.inpaintMaskCtx = LE.inpaintMaskCanvas.getContext('2d');
    }
    LE.isPaintingMask = true;
    const ctx = LE.inpaintMaskCtx;
    ctx.save();
    if (isEraser) {
        // Right-click erases mask
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        // Left-click paints mask
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = 'rgba(255,255,255,1)';
    }
    ctx.lineWidth = LE.maskBrushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    LE.toolState = { lastMX: cx, lastMY: cy, isEraser };
}
function toolMaskMove(cx, cy) {
    if (!LE.isPaintingMask) return;
    LE.inpaintMaskCtx.lineTo(cx, cy);
    LE.inpaintMaskCtx.stroke();
    LE.inpaintMaskCtx.beginPath();
    LE.inpaintMaskCtx.moveTo(cx, cy);
    recomposite();
}
function toolMaskUp() {
    if (!LE.isPaintingMask) return;
    LE.isPaintingMask = false;
    LE.inpaintMaskCtx.restore();
    recomposite();
}

// ─── Mouse Event Handling ───────────────────────────────────
function onCanvasMouseDown(e) {
    if (e.button === 1 || LE.isSpaceDown) {
        // Middle click or space: pan
        LE.isPanning = true;
        LE.lastMouseX = e.clientX;
        LE.lastMouseY = e.clientY;
        e.preventDefault();
        return;
    }

    const pos = screenToCanvas(e.clientX, e.clientY);
    LE.lastMouseX = e.clientX;
    LE.lastMouseY = e.clientY;

    // Mask tool: left-click paints, right-click erases
    if (LE.activeTool === 'mask' && LE.activeAction === 'inpaint') {
        if (e.button === 0 || e.button === 2) {
            toolMaskDown(pos.x, pos.y, e.button === 2);
            e.preventDefault();
            return;
        }
    }

    if (e.button !== 0) return;

    switch (LE.activeTool) {
        case 'transform': toolTransformDown(pos.x, pos.y); break;
        case 'brush': toolBrushDown(pos.x, pos.y, false); break;
        case 'eraser': toolBrushDown(pos.x, pos.y, true); break;
    }
}

function onCanvasMouseMove(e) {
    LE.lastMouseX = e.clientX;
    LE.lastMouseY = e.clientY;

    if (LE.isPanning) {
        const dx = e.clientX - LE.lastMouseX;
        const dy = e.clientY - LE.lastMouseY;
        // Note: lastMouse already updated above, so we need to track differently
        // Fix: use movementX/movementY instead
        LE.viewPanX += e.movementX;
        LE.viewPanY += e.movementY;
        recomposite();
        return;
    }

    const pos = screenToCanvas(e.clientX, e.clientY);

    if (LE.activeTool === 'mask' && LE.isPaintingMask) {
        toolMaskMove(pos.x, pos.y);
        return;
    }

    switch (LE.activeTool) {
        case 'transform': toolTransformMove(pos.x, pos.y, e.shiftKey); break;
        case 'brush': toolBrushMove(pos.x, pos.y, false); break;
        case 'eraser': toolBrushMove(pos.x, pos.y, true); break;
    }

    // Update cursor and overlay for brush/eraser/mask
    if (LE.activeTool === 'brush' || LE.activeTool === 'eraser' || LE.activeTool === 'mask') {
        drawOverlay();
    }

    updateStatusBar();
}

function onCanvasMouseUp(e) {
    if (LE.isPanning) {
        LE.isPanning = false;
        return;
    }

    if (LE.activeTool === 'mask' && LE.isPaintingMask) {
        toolMaskUp();
        return;
    }

    switch (LE.activeTool) {
        case 'transform': toolTransformUp(); break;
        case 'brush': toolBrushUp(false); break;
        case 'eraser': toolBrushUp(true); break;
    }
}

function onCanvasWheel(e) {
    e.preventDefault();

    // Ctrl+scroll = brush size (mask tool uses its own size)
    if (e.ctrlKey) {
        if (LE.activeTool === 'mask') {
            LE.maskBrushSize = clamp(LE.maskBrushSize + (e.deltaY > 0 ? -2 : 2), 1, 200);
        } else {
            LE.brushSize = clamp(LE.brushSize + (e.deltaY > 0 ? -1 : 1), 1, 200);
        }
        updateBrushSizeUI();
        drawOverlay();
        return;
    }

    // Zoom centered on cursor
    const rect = LE.containerEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldZoom = LE.viewZoom;
    const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
    LE.viewZoom = clamp(LE.viewZoom * zoomDelta, 0.05, 20);

    // Adjust pan to keep cursor position stable
    LE.viewPanX = mx - (mx - LE.viewPanX) * (LE.viewZoom / oldZoom);
    LE.viewPanY = my - (my - LE.viewPanY) * (LE.viewZoom / oldZoom);

    recomposite();
}

// ─── Touch Event Handling ───────────────────────────────────
function onCanvasTouchStart(e) {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        LE.lastPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        LE.lastPinchCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        LE.isPanning = true;
        // Cancel any in-progress tool
        LE.isDragging = false;
        LE.isPaintingMask = false;
    } else if (e.touches.length === 1) {
        const touch = e.touches[0];
        onCanvasMouseDown({ clientX: touch.clientX, clientY: touch.clientY, button: 0, preventDefault: () => {} });
    }
}
function onCanvasTouchMove(e) {
    if (e.touches.length === 2) {
        e.preventDefault();
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };

        // Pinch zoom
        if (LE.lastPinchDist > 0) {
            const scale = dist / LE.lastPinchDist;
            const rect = LE.containerEl.getBoundingClientRect();
            const mx = center.x - rect.left;
            const my = center.y - rect.top;
            const oldZoom = LE.viewZoom;
            LE.viewZoom = clamp(LE.viewZoom * scale, 0.05, 20);
            LE.viewPanX = mx - (mx - LE.viewPanX) * (LE.viewZoom / oldZoom);
            LE.viewPanY = my - (my - LE.viewPanY) * (LE.viewZoom / oldZoom);
        }

        // Pan
        if (LE.lastPinchCenter) {
            LE.viewPanX += center.x - LE.lastPinchCenter.x;
            LE.viewPanY += center.y - LE.lastPinchCenter.y;
        }

        LE.lastPinchDist = dist;
        LE.lastPinchCenter = center;
        recomposite();
    } else if (e.touches.length === 1) {
        const touch = e.touches[0];
        onCanvasMouseMove({ clientX: touch.clientX, clientY: touch.clientY, shiftKey: false, movementX: 0, movementY: 0 });
    }
}
function onCanvasTouchEnd(e) {
    if (e.touches.length < 2) {
        LE.isPanning = false;
        LE.lastPinchDist = 0;
        LE.lastPinchCenter = null;
    }
    if (e.touches.length === 0) {
        onCanvasMouseUp({ button: 0 });
    }
}

// ─── Keyboard Handling ──────────────────────────────────────
function onKeyDown(e) {
    if (!LE.overlay || !LE.overlay.classList.contains('le-visible')) return;

    // Don't intercept if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key === 'Escape') {
        if (LE.previewBackup) {
            cancelPreview();
        } else if (LE.activeAction === 'inpaint') {
            setActiveAction(null);
        } else {
            closeEditor();
        }
        e.preventDefault();
        return;
    }

    if (e.key === ' ') {
        LE.isSpaceDown = true;
        LE.containerEl.style.cursor = 'grab';
        e.preventDefault();
        return;
    }

    if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) performRedo(); else performUndo();
        return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (LE.activeLayerId) removeLayer(LE.activeLayerId);
        e.preventDefault();
        return;
    }

    // Tool shortcuts
    const toolKeys = { v: 'transform', b: 'brush', e: 'eraser', m: 'mask' };
    if (toolKeys[e.key.toLowerCase()] && !e.ctrlKey && !e.altKey) {
        setTool(toolKeys[e.key.toLowerCase()]);
        e.preventDefault();
        return;
    }

    // Brush size (mask tool uses its own size)
    if (e.key === '[') {
        if (LE.activeTool === 'mask') LE.maskBrushSize = clamp(LE.maskBrushSize - 2, 1, 200);
        else LE.brushSize = clamp(LE.brushSize - 2, 1, 200);
        updateBrushSizeUI(); e.preventDefault();
    }
    if (e.key === ']') {
        if (LE.activeTool === 'mask') LE.maskBrushSize = clamp(LE.maskBrushSize + 2, 1, 200);
        else LE.brushSize = clamp(LE.brushSize + 2, 1, 200);
        updateBrushSizeUI(); e.preventDefault();
    }
}

function onKeyUp(e) {
    if (e.key === ' ') {
        LE.isSpaceDown = false;
        const cursors = { transform: 'default', brush: 'crosshair', eraser: 'crosshair', mask: 'crosshair' };
        LE.containerEl.style.cursor = cursors[LE.activeTool] || 'default';
    }
}

// ─── Action Panel ───────────────────────────────────────────
function setActiveAction(actionName) {
    const wasInpaint = LE.activeAction === 'inpaint';
    LE.activeAction = actionName;

    // Clear inpaint mask when leaving inpaint
    if (actionName !== 'inpaint') {
        LE.inpaintMaskCanvas = null;
        LE.inpaintMaskCtx = null;
        LE.isPaintingMask = false;
        LE.containerEl.classList.remove('mask-mode');
        // Restore previous tool if we were on the mask tool
        if (LE.activeTool === 'mask') {
            setTool(LE._preInpaintTool || 'transform');
        }
    } else {
        LE.containerEl.classList.add('mask-mode');
        // Remember current tool and auto-select mask tool
        LE._preInpaintTool = LE.activeTool;
        setTool('mask');
    }

    // Show/hide the mask tool button in toolbar
    const maskBtn = document.querySelector('.le-tool-btn[data-tool="mask"]');
    if (maskBtn) maskBtn.style.display = (actionName === 'inpaint') ? '' : 'none';

    // Update buttons
    document.querySelectorAll('#le-action-buttons .le-action-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.action === actionName);
    });

    // Render controls
    renderActionControls(actionName);
    recomposite();
}

function renderActionControls(action) {
    const container = document.getElementById('le-action-controls');
    if (!container) return;
    container.innerHTML = '';

    if (!action) return;

    // Get current positive prompt from Gradio for pre-fill
    let currentPrompt = '';
    try {
        const pp = document.querySelector('#positive_prompt textarea');
        if (pp) currentPrompt = pp.value || '';
    } catch(e) {}

    let html = '';
    switch (action) {
        case 'upscale':
            html = `
                <div class="le-control-group">
                    <label>Method</label>
                    <select id="le-uov-method">${UOV_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                </div>
                <div class="le-control-group">
                    <label>Prompt (optional — uses main prompt if empty)</label>
                    <textarea id="le-action-prompt" placeholder="Describe what to generate...">${currentPrompt}</textarea>
                </div>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('uov')">Generate</button>
            `;
            break;
        case 'inpaint':
            html = `
                <div class="le-control-group">
                    <label>Method</label>
                    <select id="le-inpaint-method">${INPAINT_METHODS.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                </div>
                <div class="le-control-group">
                    <label>Prompt (optional — uses main prompt if empty)</label>
                    <textarea id="le-action-prompt" placeholder="Describe the scene...">${currentPrompt}</textarea>
                </div>
                <div class="le-control-group">
                    <label>Inpaint Additional Prompt</label>
                    <textarea id="le-inpaint-prompt" placeholder="Describe what to inpaint in the masked area..."></textarea>
                </div>
                <div class="le-control-group">
                    <label>Outpaint Direction</label>
                    <div class="le-checkbox-row">
                        <label><input type="checkbox" value="Left"> Left</label>
                        <label><input type="checkbox" value="Right"> Right</label>
                        <label><input type="checkbox" value="Top"> Top</label>
                        <label><input type="checkbox" value="Bottom"> Bottom</label>
                    </div>
                </div>
                <p style="font-size:11px;color:#888;margin:4px 0;">Use the Mask tool (M) to paint the inpaint area. Left-click = paint, Right-click = erase. Other tools (move, brush, etc.) remain available.</p>
                <button class="le-btn" style="width:100%;margin-bottom:4px" onclick="window.layerEditor._clearMask()">Clear Mask</button>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('inpaint')">Generate</button>
            `;
            break;
        case 'enhance':
            html = `
                <div class="le-control-group">
                    <label>Prompt (optional — uses main prompt if empty)</label>
                    <textarea id="le-action-prompt" placeholder="Describe what to generate...">${currentPrompt}</textarea>
                </div>
                <p style="font-size:11px;color:#888;margin:4px 0;">Enhance the current layer. Uses the prompt and enhancement settings from the main UI.</p>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('enhance')">Enhance</button>
            `;
            break;
        case 'removebg':
            html = `
                <div class="le-control-group">
                    <label>Model</label>
                    <select id="le-removebg-model">${REMOVEBG_MODELS.map(m => `<option value="${m}"${m === 'isnet-general-use' ? ' selected' : ''}>${m}</option>`).join('')}</select>
                </div>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('removebg')">Remove Background</button>
            `;
            break;
        case 'describe':
            html = `
                <div class="le-control-group">
                    <label>Content Type</label>
                    <div class="le-checkbox-row">
                        ${DESCRIBE_TYPES.map(t => `<label><input type="checkbox" value="${t}" checked> ${t}</label>`).join('')}
                    </div>
                </div>
                <div id="le-describe-result" style="font-size:12px;color:#aaa;margin:8px 0;min-height:40px;background:#1a1a1a;border:1px solid #444;border-radius:4px;padding:6px;display:none;"></div>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('describe')">Describe Image</button>
            `;
            break;
        case 'imageprompt':
            html = `
                <div class="le-control-group">
                    <label>Type</label>
                    <select id="le-ip-type">${IP_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}</select>
                </div>
                <div class="le-control-group">
                    <label>Prompt (required — what to generate using this image as reference)</label>
                    <textarea id="le-action-prompt" placeholder="Describe what to generate...">${currentPrompt}</textarea>
                </div>
                <div class="le-control-group">
                    <label>Stop At</label>
                    <div class="le-range-row">
                        <input type="range" id="le-ip-stop" min="0" max="1" step="0.05" value="0.5">
                        <span class="le-range-value" id="le-ip-stop-val">0.50</span>
                    </div>
                </div>
                <div class="le-control-group">
                    <label>Weight</label>
                    <div class="le-range-row">
                        <input type="range" id="le-ip-weight" min="0" max="2" step="0.05" value="1.0">
                        <span class="le-range-value" id="le-ip-weight-val">1.00</span>
                    </div>
                </div>
                <p style="font-size:11px;color:#888;margin:4px 0;">Uses the current layer as an image prompt reference.</p>
                <button class="le-btn le-btn-primary" style="width:100%" id="le-action-generate-btn" onclick="window.layerEditor._triggerGenerate('imageprompt')">Generate with Image Prompt</button>
            `;
            break;
    }

    container.innerHTML = html;

    // Wire up range value displays
    const ipStop = container.querySelector('#le-ip-stop');
    const ipStopVal = container.querySelector('#le-ip-stop-val');
    if (ipStop && ipStopVal) ipStop.oninput = () => ipStopVal.textContent = parseFloat(ipStop.value).toFixed(2);
    const ipWeight = container.querySelector('#le-ip-weight');
    const ipWeightVal = container.querySelector('#le-ip-weight-val');
    if (ipWeight && ipWeightVal) ipWeight.oninput = () => ipWeightVal.textContent = parseFloat(ipWeight.value).toFixed(2);
}

// ─── Generation Integration ─────────────────────────────────
LE._clearMask = function() {
    if (LE.inpaintMaskCanvas) {
        LE.inpaintMaskCtx.clearRect(0, 0, LE.inpaintMaskCanvas.width, LE.inpaintMaskCanvas.height);
        recomposite();
    }
};

LE._triggerGenerate = function(action) {
    if (LE.isGenerating) return;

    const layer = getActiveLayer();
    if (!layer && action !== 'imageprompt') {
        alert('Please select a layer first.');
        return;
    }

    LE.isGenerating = true;
    showProgress('Preparing image...');

    // Render source image — always use the active layer's actual content
    // (no cropping to document bounds, no padding)
    const sourceCanvas = document.createElement('canvas');
    if (layer) {
        sourceCanvas.width = layer.width;
        sourceCanvas.height = layer.height;
        sourceCanvas.getContext('2d').drawImage(layer.canvas, 0, 0);
    }

    // Route: removebg and describe go through Python handler directly.
    // uov, inpaint, enhance, imageprompt go through Gradio UI pipeline.
    if (action === 'removebg' || action === 'describe') {
        sourceCanvas.toBlob((blob) => {
            if (!blob) { LE.isGenerating = false; hideProgress(); return; }
            uploadBlob(blob, 'source.png').then(sourcePath => {
                if (!sourcePath) { LE.isGenerating = false; hideProgress(); return; }
                const cmd = { action: action, image_path: sourcePath, params: {} };
                if (action === 'removebg') {
                    const model = document.getElementById('le-removebg-model');
                    cmd.mask_model = model ? model.value : 'isnet-general-use';
                } else {
                    cmd.params.describe_types = [];
                    document.querySelectorAll('#le-action-controls .le-checkbox-row input:checked').forEach(cb => {
                        cmd.params.describe_types.push(cb.value);
                    });
                }
                sendCommand(cmd);
            });
        }, 'image/png');
        return;
    }

    // For generation-based actions: route through Gradio UI
    sourceCanvas.toBlob((blob) => {
        if (!blob) { LE.isGenerating = false; hideProgress(); return; }
        triggerGradioGenerate(action, blob, layer);
    }, 'image/png');
};

// ─── Gradio UI Generation Integration ───────────────────────
// For uov, inpaint, enhance, imageprompt: manipulate the actual
// Gradio UI components and click the real Generate button, then
// watch for results.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Clear a Gradio Image/Sketch component so a new image can be injected.
// When a component already has an image, the file input is conditionally
// removed from the DOM (Svelte {#if}). We need to click the clear/X
// button first to reset it back to the upload state with a file input.
function clearGradioImage(selector) {
    const container = document.querySelector(selector);
    if (!container) return false;

    // Check if there's even an image loaded (canvas layers or image preview present)
    const hasImage = container.querySelector('canvas, .image-container img, img[data-testid]');
    if (!hasImage) {
        console.log('[LE] clearGradioImage: no image loaded in', selector);
        return true; // Already clear
    }

    // Strategy 1: Standard aria-label buttons
    const ariaLabels = ['Remove Image', 'Clear', 'Remove', 'Close', 'Reset'];
    for (const label of ariaLabels) {
        const btn = container.querySelector(`button[aria-label="${label}"]`);
        if (btn) {
            btn.click();
            console.log('[LE] Cleared via aria-label button:', label, selector);
            return true;
        }
    }

    // Strategy 2: Look for any small icon button (×, ✕, SVG close icons)
    const allBtns = container.querySelectorAll('button');
    for (const btn of allBtns) {
        const text = btn.textContent.trim();
        const html = btn.innerHTML;
        // Skip known non-clear buttons
        if (btn.getAttribute('aria-label') === 'Undo') continue;
        if (btn.getAttribute('aria-label') === 'Redo') continue;
        // Match × icons, SVG close icons, or very small buttons
        if (text === '×' || text === '✕' || text === 'x' || text === 'X' ||
            html.includes('×') || html.includes('✕') ||
            (html.includes('<svg') && html.includes('close')) ||
            (html.includes('<svg') && btn.classList.contains('icon-button'))) {
            btn.click();
            console.log('[LE] Cleared via icon button:', selector);
            return true;
        }
    }

    // Strategy 3: Find the Svelte component and reset it
    // Gradio 3.41.2 Svelte components are accessible via __svelte_meta or data attributes
    // on the block element. Try to find and invoke the clear method.
    const wrap = container.closest('.wrap, .block');
    if (wrap) {
        // Try dispatching a custom clear event that Gradio might listen to
        container.dispatchEvent(new CustomEvent('clear', { bubbles: true }));
    }

    console.warn('[LE] clearGradioImage: could not find clear button for', selector);
    return false;
}

// Force-inject an image into a Gradio Image/Sketch component.
// This is a more robust version that handles both empty and already-loaded states.
// When the standard file input approach fails (because Svelte removed it from DOM),
// we fall back to drag-and-drop simulation and upload API.
function forceInjectImageIntoGradio(selector, file) {
    const container = document.querySelector(selector);
    if (!container) {
        console.warn('[LE] forceInjectImage: container not found:', selector);
        return false;
    }

    // Strategy A: Standard file input (works when component is in upload mode)
    const fileInput = container.querySelector('input[type="file"]');
    if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LE] Injected via file input:', selector);
        return true;
    }

    // Strategy B: Drag-and-drop on the container (works even when canvas is showing)
    const dt = new DataTransfer();
    dt.items.add(file);
    // Simulate full drag sequence for maximum compatibility
    container.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    container.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    container.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    console.log('[LE] Injected via drag-drop on container:', selector);

    // Strategy C: Also try dropping on nested elements that might have drop handlers
    const dropTargets = container.querySelectorAll('.upload-container, [data-testid="image"], .image-container, .wrap');
    for (const target of dropTargets) {
        const dt2 = new DataTransfer();
        dt2.items.add(file);
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
    }

    return true;
}

const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

function setGradioTextboxValue(selector, value) {
    const container = document.querySelector(selector);
    if (!container) { console.warn('[LE] setGradioTextboxValue: container not found:', selector); return; }
    const textarea = container.querySelector('textarea');
    if (textarea) {
        nativeTextareaSetter.call(textarea, value);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }
    const input = container.querySelector('input');
    if (input) {
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Find a Gradio checkbox by label text and check/uncheck it.
// Most checkboxes in this app have NO elem_id, so we find by label.
function setGradioCheckboxByLabel(labelText, checked) {
    const allLabels = document.querySelectorAll('.gradio-container label');
    for (const label of allLabels) {
        const span = label.querySelector('span');
        if (!span) continue;
        if (span.textContent.trim() === labelText) {
            const cb = label.querySelector('input[type="checkbox"]');
            if (cb && cb.checked !== checked) {
                cb.click();
                return true;
            }
            if (cb && cb.checked === checked) return true;
        }
    }
    console.warn('[LE] setGradioCheckboxByLabel: not found:', labelText);
    return false;
}

function setGradioCheckbox(selector, checked) {
    const container = document.querySelector(selector);
    if (!container) {
        console.warn('[LE] setGradioCheckbox: selector not found:', selector);
        return false;
    }
    const cb = container.querySelector('input[type="checkbox"]');
    if (cb && cb.checked !== checked) cb.click();
    return !!cb;
}

function setGradioSlider(selector, value) {
    const input = document.querySelector(selector + ' input[type="number"]');
    if (input) {
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function setGradioRadio(containerSelector, value) {
    const labels = document.querySelectorAll(containerSelector + ' label');
    for (const label of labels) {
        const span = label.querySelector('span');
        if (span && span.textContent.trim() === value) {
            const radio = label.querySelector('input[type="radio"]');
            if (radio && !radio.checked) radio.click();
            return true;
        }
    }
    return false;
}

// Click a Gradio Radio option by its text content within a container
// In Gradio 3.41.2, Radio buttons need their label clicked (not just the input)
// to properly trigger Svelte reactivity
function clickGradioRadioByText(containerSelector, text) {
    const container = document.querySelector(containerSelector);
    if (!container) { console.warn('[LE] clickGradioRadioByText: container not found:', containerSelector); return false; }
    const labels = container.querySelectorAll('label');
    for (const lbl of labels) {
        const span = lbl.querySelector('span');
        if (span && span.textContent.trim() === text) {
            const radio = lbl.querySelector('input[type="radio"]');
            if (radio) {
                if (!radio.checked) {
                    // Click the label (not the input) to trigger Gradio/Svelte event handling
                    lbl.click();
                    // Also dispatch events on the input as fallback
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                    radio.dispatchEvent(new Event('input', { bubbles: true }));
                }
                console.log('[LE] Set radio to:', text);
                return true;
            }
        }
    }
    console.warn('[LE] clickGradioRadioByText: option not found:', text, 'in', containerSelector);
    return false;
}

// Click a tab-nav button by its text label
function clickTabByName(name) {
    const allTabBtns = document.querySelectorAll('.tab-nav button');
    for (const btn of allTabBtns) {
        if (btn.textContent.trim() === name) {
            btn.click();
            return true;
        }
    }
    console.warn('[LE] clickTabByName: tab not found:', name);
    return false;
}

// Set a Gradio Dropdown value by elem_id
function setGradioDropdown(selector, value) {
    const container = document.querySelector(selector);
    if (!container) { console.warn('[LE] setGradioDropdown: not found:', selector); return; }
    const input = container.querySelector('input');
    if (input) {
        // Focus to open dropdown
        input.focus();
        input.click();
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => {
            const options = container.querySelectorAll('[role="option"], li');
            for (const opt of options) {
                if (opt.textContent.trim() === value) {
                    opt.click();
                    return;
                }
            }
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }, 150);
    }
}

// Set a Gradio CheckboxGroup values by elem_id
function setGradioCheckboxGroup(selector, values) {
    const container = document.querySelector(selector);
    if (!container) { console.warn('[LE] setGradioCheckboxGroup: not found:', selector); return; }
    const labels = container.querySelectorAll('label');
    for (const lbl of labels) {
        const span = lbl.querySelector('span');
        const cb = lbl.querySelector('input[type="checkbox"]');
        if (span && cb) {
            const shouldCheck = values.includes(span.textContent.trim());
            if (cb.checked !== shouldCheck) cb.click();
        }
    }
}

// Find and set Image Number slider (has no elem_id, find by label)
function setImageNumberSlider(value) {
    const allLabels = document.querySelectorAll('label span');
    for (const span of allLabels) {
        if (span.textContent.trim() === 'Image Number') {
            // Walk up to find the slider container
            let container = span.closest('.form') || span.closest('.wrap') || span.parentElement?.parentElement;
            if (!container) continue;
            const numberInput = container.querySelector('input[type="number"]');
            const rangeInput = container.querySelector('input[type="range"]');
            if (numberInput) {
                LE._savedImageNumber = numberInput.value;
                nativeSetter.call(numberInput, String(value));
                numberInput.dispatchEvent(new Event('input', { bubbles: true }));
                numberInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (rangeInput) {
                nativeSetter.call(rangeInput, String(value));
                rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
                rangeInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }
    }
    console.warn('[LE] setImageNumberSlider: "Image Number" label not found');
    return false;
}

function restoreImageNumber() {
    if (LE._savedImageNumber != null) {
        setImageNumberSlider(LE._savedImageNumber);
        LE._savedImageNumber = null;
    }
}

// Set the main positive prompt
function setPositivePrompt(value) {
    if (!value) return;
    const el = document.querySelector('#positive_prompt textarea');
    if (el) {
        LE._savedPositivePrompt = el.value;
        nativeTextareaSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function restorePositivePrompt() {
    if (LE._savedPositivePrompt != null) {
        const el = document.querySelector('#positive_prompt textarea');
        if (el) {
            nativeTextareaSetter.call(el, LE._savedPositivePrompt);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        LE._savedPositivePrompt = null;
    }
}

// Directly set the current_tab hidden textbox that tells the Python backend
// which processing mode to use (uov, inpaint, ip, enhance, etc.)
// Tab .select() server callbacks may not fire from JS-triggered clicks.
function setCurrentTab(tabValue) {
    const textarea = document.querySelector('#current_tab textarea');
    const input = document.querySelector('#current_tab input');
    const el = textarea || input;
    if (el) {
        LE._savedCurrentTab = el.value;
        const setter = textarea ? nativeTextareaSetter : nativeSetter;
        setter.call(el, tabValue);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[LE] Set current_tab to:', tabValue);
    } else {
        console.warn('[LE] current_tab element not found');
    }
}

function restoreCurrentTab() {
    if (LE._savedCurrentTab != null) {
        const textarea = document.querySelector('#current_tab textarea');
        const input = document.querySelector('#current_tab input');
        const el = textarea || input;
        if (el) {
            const setter = textarea ? nativeTextareaSetter : nativeSetter;
            setter.call(el, LE._savedCurrentTab);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        LE._savedCurrentTab = null;
    }
}

async function triggerGradioGenerate(action, imageBlob, activeLayer) {
    showProgress('Setting up generation...');
    const file = new File([imageBlob], 'le_source.png', { type: 'image/png' });

    LE._savedImageNumber = null;
    LE._savedPositivePrompt = null;
    LE._generatingViaGradio = true;

    try {
        // 0. Set positive prompt from action panel (if provided)
        const actionPrompt = document.getElementById('le-action-prompt');
        if (actionPrompt && actionPrompt.value.trim()) {
            setPositivePrompt(actionPrompt.value.trim());
        }

        // 1. Ensure Input Image checkbox is checked (NO elem_id, find by label)
        if (action !== 'enhance') {
            setGradioCheckboxByLabel('Input Image', true);
            await sleep(500);
        }

        // 2-3. Set up the specific action
        switch (action) {
            case 'uov': {
                clickTabByName('Upscale or Variation');
                setCurrentTab('uov');
                await sleep(400);
                // Clear previous image first so re-injection works
                clearGradioImage('#uov_input_image');
                await sleep(300);
                injectImageIntoGradio('#uov_input_image', file);
                await sleep(500);
                // UOV method is a gr.Radio with elem_id='uov_method'
                const leMethod = document.getElementById('le-uov-method');
                const methodVal = leMethod ? leMethod.value : 'Vary (Subtle)';
                console.log('[LE] Setting UOV method to:', methodVal);
                if (!clickGradioRadioByText('#uov_method', methodVal)) {
                    console.warn('[LE] Failed to set UOV method radio');
                }
                await sleep(300);
                break;
            }
            case 'inpaint': {
                clickTabByName('Inpaint or Outpaint');
                setCurrentTab('inpaint');
                await sleep(400);

                // --- Server-side image injection ---
                // Upload source + mask to server, then use Python handler to set
                // Gradio components directly. This bypasses the sketch component's
                // DOM (which removes file input after first upload in Gradio 3.41.2).
                showProgress('Uploading source image...');
                const sourcePath = await uploadBlob(imageBlob, 'le_source.png');
                if (!sourcePath) throw new Error('Failed to upload source image');
                console.log('[LE] Uploaded source:', sourcePath);

                let maskPath = null;
                if (activeLayer) {
                    const maskExport = document.createElement('canvas');
                    maskExport.width = activeLayer.width;
                    maskExport.height = activeLayer.height;
                    const mectx = maskExport.getContext('2d');

                    let hasMask = false;
                    if (LE.inpaintMaskCanvas && LE.inpaintMaskCtx) {
                        const maskData = LE.inpaintMaskCtx.getImageData(
                            0, 0, LE.inpaintMaskCanvas.width, LE.inpaintMaskCanvas.height).data;
                        for (let i = 3; i < maskData.length; i += 4) {
                            if (maskData[i] > 0) { hasMask = true; break; }
                        }
                    }

                    if (hasMask) {
                        // Transform mask from document-space to layer-local-space
                        mectx.fillStyle = '#000';
                        mectx.fillRect(0, 0, maskExport.width, maskExport.height);
                        const cx = activeLayer.x + activeLayer.width / 2;
                        const cy = activeLayer.y + activeLayer.height / 2;
                        mectx.save();
                        mectx.translate(activeLayer.width / 2, activeLayer.height / 2);
                        mectx.scale(1 / activeLayer.scaleX, 1 / activeLayer.scaleY);
                        mectx.rotate(-activeLayer.rotation);
                        mectx.translate(-cx, -cy);
                        mectx.drawImage(LE.inpaintMaskCanvas, 0, 0);
                        mectx.restore();
                    } else {
                        // Empty mask for outpaint (direction checkboxes handle masking)
                        mectx.fillStyle = '#000';
                        mectx.fillRect(0, 0, maskExport.width, maskExport.height);
                    }

                    const maskBlob = await new Promise(r => maskExport.toBlob(r, 'image/png'));
                    if (maskBlob) {
                        maskPath = await uploadBlob(maskBlob, 'le_mask.png');
                        console.log('[LE] Uploaded mask:', maskPath);
                    }
                }

                // Send set_inpaint command — Python sets both Gradio components
                showProgress('Setting inpaint images via server...');
                try {
                    await sendCommandAsync({
                        action: 'set_inpaint',
                        source_path: sourcePath,
                        mask_path: maskPath || ''
                    });
                    console.log('[LE] Server set_inpaint complete');
                } catch (e) {
                    console.error('[LE] set_inpaint failed:', e);
                    throw e;
                }
                await sleep(500);

                // Set inpaint mode
                const leInpaintMethod = document.getElementById('le-inpaint-method');
                if (leInpaintMethod) {
                    setGradioDropdown('#inpaint_mode_selector', leInpaintMethod.value);
                    await sleep(300);
                }

                // Set inpaint additional prompt
                const iprompt = document.getElementById('le-inpaint-prompt');
                if (iprompt && iprompt.value.trim()) {
                    setGradioTextboxValue('#inpaint_additional_prompt', iprompt.value.trim());
                }

                // Set outpaint directions
                const outpaintChecked = [];
                document.querySelectorAll('#le-action-controls .le-checkbox-row input:checked').forEach(cb => {
                    outpaintChecked.push(cb.value);
                });
                setGradioCheckboxGroup('#outpaint_selections', outpaintChecked);
                await sleep(200);

                // Enable advanced masking
                setGradioCheckboxByLabel('Enable Advanced Masking Features', true);
                await sleep(300);
                break;
            }
            case 'enhance': {
                // Enhance checkbox has NO elem_id, find by label
                setGradioCheckboxByLabel('Enhance', true);
                setCurrentTab('enhance');
                await sleep(400);
                clearGradioImage('#enhance_input_image');
                await sleep(300);
                injectImageIntoGradio('#enhance_input_image', file);
                await sleep(500);
                break;
            }
            case 'imageprompt': {
                clickTabByName('Image Prompt');
                setCurrentTab('ip');
                await sleep(400);
                clearGradioImage('#ip_image_1');
                await sleep(300);
                // Inject into the first image prompt area (#ip_image_1)
                injectImageIntoGradio('#ip_image_1', file);
                await sleep(400);
                break;
            }
        }

        // 4. Set image_number to 1
        setImageNumberSlider(1);
        await sleep(200);

        // 5. Remember current gallery state to detect new images
        LE._preGalleryCount = document.querySelectorAll('#final_gallery .thumbnail-item img, #final_gallery .grid-container img').length;
        const galleryImgs = document.querySelectorAll('#final_gallery img');
        // Store ALL current gallery image srcs so we can identify which ones are new
        LE._preGallerySrcs = new Set();
        galleryImgs.forEach(img => { if (img.src) LE._preGallerySrcs.add(img.src); });
        LE._preGalleryFirstSrc = galleryImgs.length > 0 ? galleryImgs[0].src : null;

        // 6. Click the generate button
        showProgress('Generating...');
        const genBtn = document.querySelector('#generate_button');
        if (genBtn) {
            genBtn.click();
            console.log('[LE] Generate button clicked');
        } else {
            throw new Error('Generate button not found');
        }

        // 7. Watch for generation to complete
        watchForGradioResult(activeLayer);

    } catch (e) {
        console.error('[Layer Editor] Gradio generation setup failed:', e);
        LE.isGenerating = false;
        LE._generatingViaGradio = false;
        hideProgress();
        restorePositivePrompt();
        restoreImageNumber();
        restoreCurrentTab();
    }
}

function watchForGradioResult(activeLayer) {
    let pollCount = 0;
    const maxPolls = 600; // 5 minutes
    let genStarted = false;
    let genBtnWasHidden = false;

    const poll = setInterval(() => {
        pollCount++;
        if (pollCount > maxPolls) {
            clearInterval(poll);
            finishGradioGeneration('Generation timed out', null, activeLayer);
            return;
        }

        const genBtn = document.querySelector('#generate_button');
        const stopBtn = document.querySelector('#stop_button');
        const skipBtn = document.querySelector('#skip_button');

        // Check if generation has started (stop/skip buttons appear)
        const stopVisible = stopBtn && stopBtn.offsetParent !== null;
        const skipVisible = skipBtn && skipBtn.offsetParent !== null;
        const genVisible = genBtn && genBtn.offsetParent !== null;

        if (stopVisible || skipVisible) {
            genStarted = true;
        }
        if (!genVisible && genStarted) {
            genBtnWasHidden = true;
        }

        // Generation complete: gen button reappears after being hidden, stop/skip gone
        if (genStarted && genVisible && !stopVisible && !skipVisible && (genBtnWasHidden || pollCount > 4)) {
            clearInterval(poll);
            console.log('[LE] Generation complete detected, capturing result...');
            // Delay to let gallery fully update
            setTimeout(() => captureGradioResult(activeLayer), 1000);
        }
    }, 500);
}

function captureGradioResult(activeLayer) {
    let resultSrc = null;

    // Strategy 1: Find the currently selected/displayed gallery image
    // Gradio sets .selected class on the active thumbnail-item
    const selectedThumb = document.querySelector('#final_gallery .thumbnail-item.selected img');
    if (selectedThumb && selectedThumb.src) {
        resultSrc = selectedThumb.src;
        console.log('[LE] Found result via .selected thumbnail');
    }

    // Strategy 2: Check the large preview image that Gradio shows above thumbnails
    if (!resultSrc) {
        // In Gradio 3.41.2, the gallery has a large preview <img> above the grid
        const previewImgs = document.querySelectorAll('#final_gallery > div > img, #final_gallery .preview img');
        for (const img of previewImgs) {
            if (img && img.src && !img.src.includes('data:') && img.src !== LE._preGalleryFirstSrc) {
                resultSrc = img.src;
                console.log('[LE] Found result via gallery preview image');
                break;
            }
        }
    }

    // Strategy 3: Check all gallery images — newest is typically the FIRST thumbnail
    // but may also be the last depending on gallery order. Try to find by checking
    // the progress_gallery first (shows results during generation), then fall back
    // to the first image in main gallery that differs from pre-generation state.
    if (!resultSrc) {
        // Check progress gallery (always shows the latest result)
        const progressImgs = document.querySelectorAll('#progress_gallery img');
        for (const img of progressImgs) {
            if (img.src && !img.src.includes('data:')) {
                resultSrc = img.src;
                console.log('[LE] Found result via progress gallery');
                break;
            }
        }
    }
    if (!resultSrc) {
        const allImgs = document.querySelectorAll(
            '#final_gallery .grid-container > .thumbnail-item img, ' +
            '#final_gallery .grid-container .batch-group-grid > .thumbnail-item img'
        );
        // Try first image (newest-first order)
        for (const img of allImgs) {
            if (img.src && img.src !== LE._preGalleryFirstSrc && !img.src.includes('data:')) {
                resultSrc = img.src;
                console.log('[LE] Found result via gallery scan (first new image)');
                break;
            }
        }
    }

    if (!resultSrc) {
        console.warn('[LE] Could not find generated image in gallery');
    } else {
        console.log('[LE] Captured result image:', resultSrc.substring(0, 100));
    }

    finishGradioGeneration(null, resultSrc, activeLayer);

    // Restore saved settings AFTER capturing the result, with a delay
    // to avoid triggering gallery re-renders that could interfere
    setTimeout(() => {
        restoreImageNumber();
        restorePositivePrompt();
        restoreCurrentTab();
    }, 2000);
}

function finishGradioGeneration(error, imageSrc, activeLayer) {
    LE._generatingViaGradio = false;
    LE.isGenerating = false;
    hideProgress();

    // Run any post-generation cleanup callback (used by Smart Merge/Flatten)
    if (LE._postGenerateCallback) {
        const cb = LE._postGenerateCallback;
        LE._postGenerateCallback = null;
        cb();
    }

    if (error) {
        console.error('[Layer Editor] Gradio generation error:', error);
        setTimeout(() => {
            restoreImageNumber();
            restorePositivePrompt();
            restoreCurrentTab();
        }, 1000);
        return;
    }

    if (!imageSrc || !activeLayer) return;

    // Store backup for preview workflow
    LE.previewBackup = document.createElement('canvas');
    LE.previewBackup.width = activeLayer.width;
    LE.previewBackup.height = activeLayer.height;
    LE.previewBackup.getContext('2d').drawImage(activeLayer.canvas, 0, 0);
    LE.previewLayerId = activeLayer.id;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        activeLayer.canvas.width = img.width;
        activeLayer.canvas.height = img.height;
        activeLayer.width = img.width;
        activeLayer.height = img.height;
        activeLayer.ctx = activeLayer.canvas.getContext('2d');
        activeLayer.ctx.drawImage(img, 0, 0);
        activeLayer._thumbDirty = true;
        recomposite();
        renderLayerPanel();
        showPreviewBar();
    };
    img.onerror = () => {
        console.error('[Layer Editor] Failed to load generated image:', imageSrc);
    };
    img.src = imageSrc;
}

function uploadBlob(blob, filename) {
    return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('files', blob, filename);
        fetch('/upload', { method: 'POST', body: formData })
            .then(r => r.json())
            .then(data => {
                // Gradio returns array of file paths
                if (Array.isArray(data) && data.length > 0) resolve(data[0]);
                else resolve(null);
            })
            .catch(() => resolve(null));
    });
}

function sendCommand(cmd) {
    showProgress('Processing...');
    const textarea = document.querySelector('#layer_editor_command textarea');
    if (textarea) {
        textarea.value = JSON.stringify(cmd);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// Send a command and wait for the result via the layer_editor_result textbox.
function sendCommandAsync(cmd, timeoutMs) {
    timeoutMs = timeoutMs || 30000;
    return new Promise((resolve, reject) => {
        const resultEl = document.querySelector('#layer_editor_result textarea');
        const startVal = resultEl ? resultEl.value : '';
        sendCommand(cmd);
        let elapsed = 0;
        const poll = setInterval(() => {
            elapsed += 200;
            if (elapsed > timeoutMs) {
                clearInterval(poll);
                reject(new Error('sendCommandAsync timeout'));
                return;
            }
            const cur = resultEl ? resultEl.value : '';
            if (cur && cur !== startVal) {
                clearInterval(poll);
                try { resolve(JSON.parse(cur)); } catch { resolve(cur); }
            }
        }, 200);
    });
}

function handleResult(resultJson) {
    hideProgress();
    LE.isGenerating = false;

    try {
        const result = JSON.parse(resultJson);
        if (result.error) {
            console.error('Layer Editor error:', result.error);
            alert('Layer Editor error: ' + result.error);
            return;
        }

        // Handle describe result
        if (result.action === 'describe_result' && result.description) {
            const el = document.getElementById('le-describe-result');
            if (el) {
                el.textContent = result.description;
                el.style.display = 'block';
            }
            return;
        }

        // Handle project saved
        if (result.action === 'project_saved' && result.download_url) {
            const a = document.createElement('a');
            a.href = result.download_url;
            a.download = result.path ? result.path.split(/[/\\]/).pop() : 'project.fjord';
            a.click();
            return;
        }

        // Handle project loaded
        if (result.action === 'project_loaded' && result.project) {
            loadProjectFromData(result.project);
            return;
        }

        // Handle load error
        if (result.action === 'load_error') {
            alert('Failed to load project: ' + (result.error || 'Unknown error'));
            return;
        }

        // Handle removebg result (image_url from Python handler)
        if (result.action === 'removebg_result' && result.image_url) {
            const layer = getActiveLayer();
            if (!layer) return;

            LE.previewBackup = document.createElement('canvas');
            LE.previewBackup.width = layer.width;
            LE.previewBackup.height = layer.height;
            LE.previewBackup.getContext('2d').drawImage(layer.canvas, 0, 0);
            LE.previewLayerId = layer.id;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                layer.canvas.width = img.width;
                layer.canvas.height = img.height;
                layer.width = img.width;
                layer.height = img.height;
                layer.ctx = layer.canvas.getContext('2d');
                layer.ctx.drawImage(img, 0, 0);
                layer._thumbDirty = true;
                recomposite();
                renderLayerPanel();
                showPreviewBar();
            };
            img.src = result.image_url;
            return;
        }

        // Generic image_path result (legacy/fallback)
        if (result.image_path) {
            const layer = getActiveLayer();
            if (!layer) return;

            LE.previewBackup = document.createElement('canvas');
            LE.previewBackup.width = layer.width;
            LE.previewBackup.height = layer.height;
            LE.previewBackup.getContext('2d').drawImage(layer.canvas, 0, 0);
            LE.previewLayerId = layer.id;

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                layer.canvas.width = img.width;
                layer.canvas.height = img.height;
                layer.width = img.width;
                layer.height = img.height;
                layer.ctx = layer.canvas.getContext('2d');
                layer.ctx.drawImage(img, 0, 0);
                layer._thumbDirty = true;
                recomposite();
                renderLayerPanel();
                showPreviewBar();
            };
            img.src = '/file=' + result.image_path;
            return;
        }
    } catch (e) {
        console.error('Failed to parse layer editor result:', e);
    }
}

// ─── Preview Accept/Cancel ──────────────────────────────────
function showPreviewBar() {
    const bar = document.getElementById('le-preview-bar');
    if (bar) bar.classList.add('visible');
}

function hidePreviewBar() {
    const bar = document.getElementById('le-preview-bar');
    if (bar) bar.classList.remove('visible');
}

function acceptPreview() {
    LE.previewBackup = null;
    LE.previewLayerId = null;
    hidePreviewBar();
}

function cancelPreview() {
    if (LE.previewBackup && LE.previewLayerId) {
        const layer = LE.layers.find(l => l.id === LE.previewLayerId);
        if (layer) {
            layer.canvas.width = LE.previewBackup.width;
            layer.canvas.height = LE.previewBackup.height;
            layer.width = LE.previewBackup.width;
            layer.height = LE.previewBackup.height;
            layer.ctx = layer.canvas.getContext('2d');
            layer.ctx.drawImage(LE.previewBackup, 0, 0);
            layer._thumbDirty = true;
            recomposite();
            renderLayerPanel();
        }
    }
    LE.previewBackup = null;
    LE.previewLayerId = null;
    hidePreviewBar();
}

function regeneratePreview() {
    cancelPreview();
    // Re-trigger the last generate action
    const genBtn = document.getElementById('le-action-generate-btn');
    if (genBtn) genBtn.click();
}

// ─── Progress Overlay ───────────────────────────────────────
function showProgress(text) {
    const el = document.getElementById('le-progress-overlay');
    const txt = document.getElementById('le-progress-text');
    if (el) el.classList.add('visible');
    if (txt) txt.textContent = text || 'Processing...';
}

function hideProgress() {
    const el = document.getElementById('le-progress-overlay');
    if (el) el.classList.remove('visible');
}

// ─── Export Functions ────────────────────────────────────────
function exportFlattened() {
    const canvas = document.createElement('canvas');
    canvas.width = LE.documentWidth;
    canvas.height = LE.documentHeight;
    renderCompositeToCanvas(canvas.getContext('2d'), LE.documentWidth, LE.documentHeight);
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fjord_composite_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 'image/png');
}

function exportAllLayers() {
    LE.layers.forEach((layer, idx) => {
        const canvas = document.createElement('canvas');
        canvas.width = layer.width;
        canvas.height = layer.height;
        canvas.getContext('2d').drawImage(layer.canvas, 0, 0);
        canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${layer.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${idx}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/png');
    });
}

// ─── Project Save/Load ──────────────────────────────────────
function saveProject() {
    if (LE.layers.length === 0) { alert('No layers to save.'); return; }
    showProgress('Saving project...');

    // Upload all layer images first
    const uploadPromises = LE.layers.map((layer, idx) => {
        return new Promise((resolve) => {
            layer.canvas.toBlob(blob => {
                uploadBlob(blob, `layer_${idx}.png`).then(path => resolve(path));
            }, 'image/png');
        });
    });

    Promise.all(uploadPromises).then(paths => {
        const project = {
            action: 'save_project',
            document: { width: LE.documentWidth, height: LE.documentHeight },
            layers: LE.layers.map((layer, idx) => ({
                name: layer.name,
                blend_mode: layer.blendMode,
                opacity: layer.opacity,
                x: layer.x, y: layer.y,
                scaleX: layer.scaleX, scaleY: layer.scaleY,
                rotation: layer.rotation,
                visible: layer.visible,
                locked: layer.locked,
                width: layer.width, height: layer.height,
                image_path: paths[idx]
            }))
        };
        sendCommand(project);
    });
}

function loadProject() {
    const input = document.getElementById('le-project-file-input');
    if (input) input.click();
}

function handleProjectFile(file) {
    showProgress('Loading project...');
    const formData = new FormData();
    formData.append('files', file, file.name);
    fetch('/upload', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (Array.isArray(data) && data.length > 0) {
                sendCommand({
                    action: 'load_project',
                    file_path: data[0],
                    filename: file.name
                });
            }
        })
        .catch(e => { console.error('Upload failed:', e); hideProgress(); });
}

function loadProjectFromData(project) {
    // Load project from Python handler's format (project_loaded response)
    hideProgress();
    try {
        // Clear existing layers
        LE.layers = [];
        LE.activeLayerId = null;
        LE.documentWidth = project.documentWidth || 1024;
        LE.documentHeight = project.documentHeight || 1024;

        const layersData = project.layers || [];
        let loaded = 0;
        const total = layersData.length;
        if (total === 0) { recomposite(); renderLayerPanel(); return; }

        layersData.forEach((layerData, idx) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const layer = createLayer(layerData.name || `Layer ${idx}`, img.width, img.height);
                layer.ctx.drawImage(img, 0, 0);
                layer.blendMode = layerData.blendMode || 'source-over';
                layer.opacity = layerData.opacity !== undefined ? layerData.opacity : 1.0;
                layer.x = layerData.x || 0;
                layer.y = layerData.y || 0;
                layer.scaleX = layerData.scaleX || 1;
                layer.scaleY = layerData.scaleY || 1;
                layer.rotation = layerData.rotation || 0;
                layer.visible = layerData.visible !== false;
                layer.locked = layerData.locked || false;
                layer._thumbDirty = true;

                while (LE.layers.length < idx) LE.layers.push(null);
                LE.layers[idx] = layer;

                loaded++;
                if (loaded === total) {
                    LE.layers = LE.layers.filter(l => l !== null);
                    if (LE.layers.length > 0) LE.activeLayerId = LE.layers[LE.layers.length - 1].id;
                    centerView();
                    recomposite();
                    renderLayerPanel();
                }
            };
            img.onerror = () => {
                console.warn('[Layer Editor] Failed to load layer image:', layerData.image_url);
                loaded++;
                if (loaded === total) {
                    LE.layers = LE.layers.filter(l => l !== null);
                    recomposite();
                    renderLayerPanel();
                }
            };
            img.src = layerData.image_url || '';
        });
    } catch (e) {
        console.error('Failed to load project data:', e);
    }
}

function handleLoadedProject(projectData) {
    // Legacy handler for non-JSON project data
    hideProgress();
    try {
        const data = JSON.parse(projectData);
        if (data.error) { alert('Failed to load project: ' + data.error); return; }
        if (data.project) {
            loadProjectFromData(data.project);
            return;
        }

        // Fallback: old format with data.document
        LE.layers = [];
        LE.activeLayerId = null;
        LE.documentWidth = (data.document && data.document.width) || data.documentWidth || 1024;
        LE.documentHeight = (data.document && data.document.height) || data.documentHeight || 1024;

        const layersData = data.layers || [];
        let loaded = 0;
        const total = layersData.length;
        if (total === 0) { recomposite(); renderLayerPanel(); return; }

        layersData.forEach((layerData, idx) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const layer = createLayer(layerData.name, img.width, img.height);
                layer.ctx.drawImage(img, 0, 0);
                layer.blendMode = layerData.blendMode || layerData.blend_mode || 'source-over';
                layer.opacity = layerData.opacity !== undefined ? layerData.opacity : 1.0;
                layer.x = layerData.x || 0;
                layer.y = layerData.y || 0;
                layer.scaleX = layerData.scaleX || 1;
                layer.scaleY = layerData.scaleY || 1;
                layer.rotation = layerData.rotation || 0;
                layer.visible = layerData.visible !== false;
                layer.locked = layerData.locked || false;
                layer._thumbDirty = true;

                while (LE.layers.length < idx) LE.layers.push(null);
                LE.layers[idx] = layer;

                loaded++;
                if (loaded === total) {
                    LE.layers = LE.layers.filter(l => l !== null);
                    if (LE.layers.length > 0) LE.activeLayerId = LE.layers[LE.layers.length - 1].id;
                    centerView();
                    recomposite();
                    renderLayerPanel();
                }
            };
            img.onerror = () => {
                loaded++;
                if (loaded === total) {
                    LE.layers = LE.layers.filter(l => l !== null);
                    recomposite();
                    renderLayerPanel();
                }
            };
            img.src = layerData.image_url || ('/file=' + layerData.image_url);
        });
    } catch (e) {
        console.error('Failed to parse project data:', e);
    }
}

// ─── Status Bar ─────────────────────────────────────────────
function updateStatusBar() {
    const bar = document.getElementById('le-statusbar');
    if (!bar) return;
    const pos = screenToCanvas(LE.lastMouseX, LE.lastMouseY);
    bar.innerHTML = `X: ${Math.round(pos.x)}, Y: ${Math.round(pos.y)} &nbsp;|&nbsp; Zoom: ${Math.round(LE.viewZoom * 100)}% &nbsp;|&nbsp; ${LE.documentWidth} × ${LE.documentHeight} &nbsp;|&nbsp; Layers: ${LE.layers.length}`;
}

// ─── View Utilities ─────────────────────────────────────────
function centerView() {
    if (!LE.containerEl) return;
    const cw = LE.containerEl.clientWidth;
    const ch = LE.containerEl.clientHeight;
    const zoom = Math.min(cw / LE.documentWidth * 0.85, ch / LE.documentHeight * 0.85, 1);
    LE.viewZoom = zoom;
    LE.viewPanX = (cw - LE.documentWidth * zoom) / 2;
    LE.viewPanY = (ch - LE.documentHeight * zoom) / 2;
    recomposite();
}

function fitToScreen() {
    centerView();
}

// ─── Open / Close Editor ────────────────────────────────────
function openEditor() {
    if (!LE.overlay) return;
    LE.overlay.classList.add('le-visible');

    // Auto-set document size from current aspect ratio selection if empty
    if (LE.layers.length === 0) {
        try {
            const arText = document.querySelector('#aspect_ratios_selection textarea, #aspect_ratios_selection input');
            if (arText) {
                const match = arText.value.match(/(\d+)\u00d7(\d+)/);
                if (match) {
                    LE.documentWidth = parseInt(match[1]);
                    LE.documentHeight = parseInt(match[2]);
                }
            }
        } catch(e) {}
    }

    setTimeout(() => {
        centerView();
        recomposite();
        renderLayerPanel();
    }, 50);
}

function closeEditor() {
    if (LE.overlay) LE.overlay.classList.remove('le-visible');
}

// Expose globally for the "Send to Editor" button
window.openLayerEditor = openEditor;
window.sendImageToLayerEditor = function(src, name) {
    openEditor();
    loadImageAsLayer(src, name || 'Image');
};

// ─── Build DOM ──────────────────────────────────────────────
function buildEditorDOM() {
    const overlay = document.createElement('div');
    overlay.id = 'layer-editor-overlay';
    LE.overlay = overlay;

    // ── Top bar ──
    const topbar = document.createElement('div');
    topbar.id = 'le-topbar';
    topbar.innerHTML = `
        <span class="le-topbar-title">Layer Editor</span>
        <span class="le-topbar-separator"></span>
        <button class="le-btn" onclick="window.layerEditor._newDocument()" title="New Document">New</button>
        <button class="le-btn" onclick="window.layerEditor._loadProject()" title="Open Project (.fjord / .psd)">Open</button>
        <button class="le-btn" onclick="window.layerEditor._saveProject()" title="Save Project (.fjord)">Save</button>
        <span class="le-topbar-separator"></span>
        <button class="le-btn" onclick="window.layerEditor._exportFlattened()" title="Export flattened PNG">Export Flat</button>
        <button class="le-btn" onclick="window.layerEditor._exportAllLayers()" title="Export each layer as PNG">Export Layers</button>
        <span class="le-topbar-separator"></span>
        <button class="le-btn" onclick="window.layerEditor._fitToScreen()" title="Fit to screen">Fit</button>
        <button class="le-btn le-btn-close" onclick="window.layerEditor._close()" title="Close Editor">&times;</button>
    `;
    overlay.appendChild(topbar);

    // ── Main area ──
    const main = document.createElement('div');
    main.id = 'le-main';

    // ── Left toolbar ──
    const toolbar = document.createElement('div');
    toolbar.id = 'le-toolbar-left';

    // --- Tool buttons ---
    const tools = [
        { name: 'transform', icon: '&#11020;', title: 'Transform — Select, Move, Resize, Rotate (V)', key: 'transform' },
        { sep: true },
        { name: 'brush', icon: '&#9998;', title: 'Brush (B)', key: 'brush' },
        { name: 'eraser', icon: '&#9634;', title: 'Eraser (E)', key: 'eraser' },
        { sep: true },
        { name: 'mask', icon: '&#9673;', title: 'Inpaint Mask — Left=paint, Right=erase (M)', key: 'mask', hidden: true },
    ];
    for (const tool of tools) {
        if (tool.sep) {
            const sep = document.createElement('div');
            sep.className = 'le-tool-separator';
            toolbar.appendChild(sep);
            continue;
        }
        const btn = document.createElement('button');
        btn.className = 'le-tool-btn' + (tool.name === 'transform' ? ' active' : '');
        btn.innerHTML = tool.icon;
        btn.title = tool.title;
        btn.dataset.tool = tool.name;
        btn.onclick = () => setTool(tool.name);
        if (tool.hidden) btn.style.display = 'none'; // Mask tool hidden until inpaint mode
        toolbar.appendChild(btn);
    }

    // --- Separator ---
    const sep1 = document.createElement('div');
    sep1.className = 'le-tool-separator';
    toolbar.appendChild(sep1);

    // --- Undo/Redo buttons ---
    const undoBtn = document.createElement('button');
    undoBtn.className = 'le-tool-btn';
    undoBtn.innerHTML = '&#8630;';
    undoBtn.title = 'Undo (Ctrl+Z)';
    undoBtn.onclick = performUndo;
    toolbar.appendChild(undoBtn);

    const redoBtn = document.createElement('button');
    redoBtn.className = 'le-tool-btn';
    redoBtn.innerHTML = '&#8631;';
    redoBtn.title = 'Redo (Ctrl+Shift+Z)';
    redoBtn.onclick = performRedo;
    toolbar.appendChild(redoBtn);

    // --- Separator ---
    const sep2 = document.createElement('div');
    sep2.className = 'le-tool-separator';
    toolbar.appendChild(sep2);

    // --- Layer quick actions ---
    const layerActBtns = [
        { icon: '&#10010;', title: 'Add layer', action: () => addLayer('New Layer') },
        { icon: '&#128203;', title: 'Paste from clipboard', action: () => LE._pasteLayer() },
        { icon: '&#128465;', title: 'Delete layer', action: () => { if (LE.activeLayerId) removeLayer(LE.activeLayerId); } },
        { icon: '&#8615;', title: 'Merge down', action: () => { if (LE.activeLayerId) mergeDown(LE.activeLayerId); } },
        { icon: '&#10031;', title: 'Smart Merge — merge + AI blend seams', action: () => { if (LE.activeLayerId) smartMergeDown(LE.activeLayerId); } },
    ];
    for (const act of layerActBtns) {
        const btn = document.createElement('button');
        btn.className = 'le-tool-btn le-tool-btn-small';
        btn.innerHTML = act.icon;
        btn.title = act.title;
        btn.onclick = act.action;
        toolbar.appendChild(btn);
    }

    // --- Brush controls (pushed to bottom) ---
    const brushControls = document.createElement('div');
    brushControls.id = 'le-brush-controls';
    brushControls.innerHTML = `
        <input type="color" id="le-brush-color" value="${LE.brushColor}" title="Brush color">
        <div class="le-brush-slider-group">
            <label title="Brush Size">Size</label>
            <input type="range" id="le-brush-size-slider" min="1" max="200" value="${LE.brushSize}">
            <span id="le-brush-size-display">${LE.brushSize}</span>
        </div>
        <div class="le-brush-slider-group">
            <label title="Brush Opacity">Opac</label>
            <input type="range" id="le-brush-opacity-slider" min="0" max="100" value="${Math.round(LE.brushOpacity * 100)}">
            <span id="le-brush-opacity-display">${Math.round(LE.brushOpacity * 100)}%</span>
        </div>
        <div class="le-brush-slider-group">
            <label title="Brush Softness">Soft</label>
            <input type="range" id="le-brush-softness-slider" min="0" max="100" value="${Math.round(LE.brushSoftness * 100)}">
            <span id="le-brush-softness-display">${Math.round(LE.brushSoftness * 100)}%</span>
        </div>
    `;
    toolbar.appendChild(brushControls);
    main.appendChild(toolbar);

    // ── Canvas container ──
    const canvasContainer = document.createElement('div');
    canvasContainer.id = 'le-canvas-container';
    LE.containerEl = canvasContainer;

    const composite = document.createElement('canvas');
    composite.id = 'le-composite';
    LE.compositeCanvas = composite;
    LE.compositeCtx = composite.getContext('2d');

    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'le-overlay';
    LE.overlayCanvas = overlayCanvas;
    LE.overlayCtx = overlayCanvas.getContext('2d');

    canvasContainer.appendChild(composite);
    canvasContainer.appendChild(overlayCanvas);

    // Progress overlay
    const progress = document.createElement('div');
    progress.id = 'le-progress-overlay';
    progress.innerHTML = `<span id="le-progress-text">Processing...</span><div id="le-progress-bar-container"><div id="le-progress-bar"></div></div>`;
    canvasContainer.appendChild(progress);

    // Preview accept bar
    const previewBar = document.createElement('div');
    previewBar.id = 'le-preview-bar';
    previewBar.innerHTML = `
        <span class="le-preview-label">Preview:</span>
        <button class="le-btn le-btn-primary" onclick="window.layerEditor._acceptPreview()">&#10003; Accept</button>
        <button class="le-btn" onclick="window.layerEditor._regeneratePreview()">&#8635; Re-generate</button>
        <button class="le-btn le-btn-danger" onclick="window.layerEditor._cancelPreview()">&#10005; Cancel</button>
    `;
    canvasContainer.appendChild(previewBar);

    main.appendChild(canvasContainer);

    // ── Right sidebar ──
    const sidebar = document.createElement('div');
    sidebar.id = 'le-sidebar-right';

    // Layer panel
    const layerPanel = document.createElement('div');
    layerPanel.id = 'le-layer-panel';
    layerPanel.innerHTML = `
        <div id="le-layer-panel-header">Layers</div>
        <div id="le-layer-list"></div>
        <div id="le-layer-buttons">
            <button class="le-btn" onclick="window.layerEditor._addEmptyLayer()" title="Add empty layer">&#10010; New</button>
            <button class="le-btn" onclick="window.layerEditor._addImageLayer()" title="Add image as layer">&#128444; Image</button>
            <button class="le-btn" onclick="window.layerEditor._pasteLayer()" title="Paste from clipboard">&#128203;</button>
            <button class="le-btn" onclick="window.layerEditor._mergeDown()" title="Merge down">&#8615; Merge</button>
            <button class="le-btn le-btn-danger" onclick="window.layerEditor._deleteLayer()" title="Delete layer">&#128465;</button>
        </div>
    `;
    sidebar.appendChild(layerPanel);

    // Action panel
    const actionPanel = document.createElement('div');
    actionPanel.id = 'le-action-panel';
    actionPanel.innerHTML = `
        <div id="le-action-panel-header">Actions</div>
        <div id="le-action-buttons">
            <button class="le-action-btn" data-action="upscale" onclick="window.layerEditor._setAction('upscale')">Variation</button>
            <button class="le-action-btn" data-action="inpaint" onclick="window.layerEditor._setAction('inpaint')">Inpaint</button>
            <button class="le-action-btn" data-action="enhance" onclick="window.layerEditor._setAction('enhance')">Enhance</button>
            <button class="le-action-btn" data-action="removebg" onclick="window.layerEditor._setAction('removebg')">RemoveBG</button>
            <button class="le-action-btn" data-action="describe" onclick="window.layerEditor._setAction('describe')">Describe</button>
            <button class="le-action-btn" data-action="imageprompt" onclick="window.layerEditor._setAction('imageprompt')">Img Prompt</button>
        </div>
        <div id="le-action-controls"></div>
    `;
    sidebar.appendChild(actionPanel);
    main.appendChild(sidebar);
    overlay.appendChild(main);

    // ── Status bar ──
    const statusbar = document.createElement('div');
    statusbar.id = 'le-statusbar';
    overlay.appendChild(statusbar);

    // ── Hidden file inputs ──
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'le-file-input';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.onchange = (e) => handleFileImport(e.target.files);
    overlay.appendChild(fileInput);

    const projectInput = document.createElement('input');
    projectInput.type = 'file';
    projectInput.id = 'le-project-file-input';
    projectInput.accept = '.fjord,.psd';
    projectInput.onchange = (e) => { if (e.target.files[0]) handleProjectFile(e.target.files[0]); };
    overlay.appendChild(projectInput);

    document.body.appendChild(overlay);

    // ── Event listeners ──
    overlayCanvas.addEventListener('mousedown', onCanvasMouseDown);
    window.addEventListener('mousemove', onCanvasMouseMove);
    window.addEventListener('mouseup', onCanvasMouseUp);
    overlayCanvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    overlayCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch events
    overlayCanvas.addEventListener('touchstart', onCanvasTouchStart, { passive: false });
    overlayCanvas.addEventListener('touchmove', onCanvasTouchMove, { passive: false });
    overlayCanvas.addEventListener('touchend', onCanvasTouchEnd, { passive: false });

    // Keyboard
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // Drag and drop files onto canvas
    canvasContainer.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    canvasContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) {
            handleFileImport(e.dataTransfer.files);
        }
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
        if (LE.overlay.classList.contains('le-visible')) {
            recomposite();
        }
    });
    resizeObserver.observe(canvasContainer);

    // Brush controls wiring
    setTimeout(() => {
        const colorInput = document.getElementById('le-brush-color');
        if (colorInput) colorInput.oninput = (e) => { LE.brushColor = e.target.value; };

        const sizeSlider = document.getElementById('le-brush-size-slider');
        const sizeDisplay = document.getElementById('le-brush-size-display');
        if (sizeSlider) sizeSlider.oninput = () => {
            LE.brushSize = parseInt(sizeSlider.value);
            if (sizeDisplay) sizeDisplay.textContent = LE.brushSize;
            drawOverlay();
        };

        const opacitySlider = document.getElementById('le-brush-opacity-slider');
        const opacityDisplay = document.getElementById('le-brush-opacity-display');
        if (opacitySlider) opacitySlider.oninput = () => {
            LE.brushOpacity = parseInt(opacitySlider.value) / 100;
            if (opacityDisplay) opacityDisplay.textContent = opacitySlider.value + '%';
        };

        const softnessSlider = document.getElementById('le-brush-softness-slider');
        const softnessDisplay = document.getElementById('le-brush-softness-display');
        if (softnessSlider) softnessSlider.oninput = () => {
            LE.brushSoftness = parseInt(softnessSlider.value) / 100;
            if (softnessDisplay) softnessDisplay.textContent = softnessSlider.value + '%';
        };
    }, 100);
}

// ─── Expose methods for inline onclick handlers ─────────────
LE._newDocument = function() {
    const w = prompt('Document width:', LE.documentWidth);
    const h = prompt('Document height:', LE.documentHeight);
    if (w && h) {
        LE.documentWidth = parseInt(w) || 1024;
        LE.documentHeight = parseInt(h) || 1024;
        LE.layers = [];
        LE.activeLayerId = null;
        LE.undoStack = [];
        LE.redoStack = [];
        centerView();
        recomposite();
        renderLayerPanel();
    }
};
LE._loadProject = loadProject;
LE._saveProject = saveProject;
LE._exportFlattened = exportFlattened;
LE._exportAllLayers = exportAllLayers;
LE._fitToScreen = fitToScreen;
LE._close = closeEditor;
LE.addLayerFromURL = async (url) => {
    if (!LE.overlay || !LE.overlay.classList.contains('le-visible')) openEditor();
    await loadImageAsLayer(url, 'From Gallery');
};
LE._addEmptyLayer = () => addLayer('New Layer');
LE._addImageLayer = () => document.getElementById('le-file-input')?.click();
LE._pasteLayer = async () => {
    try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
            for (const type of item.types) {
                if (type.startsWith('image/')) {
                    const blob = await item.getType(type);
                    const url = URL.createObjectURL(blob);
                    await loadImageAsLayer(url, 'Pasted');
                    URL.revokeObjectURL(url);
                    return;
                }
            }
        }
    } catch (e) {
        console.warn('Clipboard paste failed:', e);
    }
};
LE._mergeDown = () => { if (LE.activeLayerId) mergeDown(LE.activeLayerId); };
LE._deleteLayer = () => { if (LE.activeLayerId) removeLayer(LE.activeLayerId); };
LE._setAction = (action) => setActiveAction(LE.activeAction === action ? null : action);
LE._acceptPreview = acceptPreview;
LE._cancelPreview = cancelPreview;
LE._regeneratePreview = regeneratePreview;

// ─── Initialization ─────────────────────────────────────────
onUiLoaded(function() {
    buildEditorDOM();

    // Watch for results from Python
    const resultObserver = new MutationObserver(() => {
        const textarea = document.querySelector('#layer_editor_result textarea');
        if (textarea && textarea.value) {
            const value = textarea.value;
            textarea.value = '';
            if (value.startsWith('{')) {
                handleResult(value);
            } else {
                handleLoadedProject(value);
            }
        }
    });

    // Start observing once the textarea exists
    const checkResultTextarea = setInterval(() => {
        const textarea = document.querySelector('#layer_editor_result textarea');
        if (textarea) {
            clearInterval(checkResultTextarea);
            resultObserver.observe(textarea, { attributes: true, childList: true, characterData: true, subtree: true });
            // Also poll since MutationObserver may miss .value changes
            setInterval(() => {
                if (textarea.value && textarea.value.trim()) {
                    const val = textarea.value;
                    textarea.value = '';
                    if (val.startsWith('{')) handleResult(val);
                    else handleLoadedProject(val);
                }
            }, 200);
        }
    }, 500);

    // Wire up toggle button
    const checkToggle = setInterval(() => {
        const btn = document.querySelector('#layer_editor_toggle');
        if (btn) {
            clearInterval(checkToggle);
            btn.addEventListener('click', () => openEditor());
        }
    }, 500);
});

})();
