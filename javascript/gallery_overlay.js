/**
 * Gallery Parent Overlay — receives postMessage from the gallery iframe
 * (embed mode, stage 2 fullscreen) and displays the image in a full-window
 * overlay over the main app. Includes its own zoom/pan controller.
 */
(function () {
  'use strict';

  // ===== Zoom/Pan Controller (same logic as gallery/index.html) =====
  function createZoomPanController(container, img) {
    let scale = 1, tx = 0, ty = 0;
    let isPanning = false, didPanFlag = false;
    let panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
    let lastTouchDist = 0, lastTouchCX = 0, lastTouchCY = 0;
    const ac = new AbortController();
    const sig = ac.signal;

    function applyTransform() {
      img.style.transform = scale === 1 && tx === 0 && ty === 0
        ? '' : `matrix(${scale},0,0,${scale},${tx},${ty})`;
      container.style.cursor = scale > 1 ? (isPanning ? 'grabbing' : 'grab') : '';
    }

    function reset() {
      scale = 1; tx = 0; ty = 0; isPanning = false;
      applyTransform();
    }

    // Wheel zoom (always centered on cursor, no limits)
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cr = container.getBoundingClientRect();
      const cx = e.clientX - cr.left, cy = e.clientY - cr.top;
      const prevScale = scale;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = Math.max(0.1, scale * factor);
      const ratio = scale / prevScale;
      tx = cx - (cx - tx) * ratio;
      ty = cy - (cy - ty) * ratio;
      applyTransform();
    }, { passive: false, signal: sig });

    // Mouse pan (no limits)
    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      if (e.button === 1 || (e.button === 0 && scale > 1)) {
        isPanning = true; didPanFlag = false;
        panStartX = e.clientX; panStartY = e.clientY;
        panStartTx = tx; panStartTy = ty;
        e.preventDefault();
        applyTransform();
      }
    }, { signal: sig });

    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartX, dy = e.clientY - panStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didPanFlag = true;
      tx = panStartTx + dx; ty = panStartTy + dy;
      applyTransform();
    }, { signal: sig });

    document.addEventListener('mouseup', () => {
      if (isPanning) { isPanning = false; applyTransform(); }
    }, { signal: sig });

    // Touch pinch zoom + pan (no limits)
    function touchDist(t) {
      return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    }

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        lastTouchDist = touchDist(e.touches);
        lastTouchCX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        lastTouchCY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      } else if (e.touches.length === 1 && scale > 1) {
        isPanning = true; didPanFlag = false;
        panStartX = e.touches[0].clientX; panStartY = e.touches[0].clientY;
        panStartTx = tx; panStartTy = ty;
        e.preventDefault();
      }
    }, { signal: sig });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = touchDist(e.touches);
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const prevScale = scale;
        scale = Math.max(0.1, scale * (dist / lastTouchDist));
        const cr = container.getBoundingClientRect();
        const ratio = scale / prevScale;
        tx = cx - cr.left - (cx - cr.left - tx) * ratio;
        ty = cy - cr.top - (cy - cr.top - ty) * ratio;
        tx += cx - lastTouchCX; ty += cy - lastTouchCY;
        lastTouchDist = dist; lastTouchCX = cx; lastTouchCY = cy;
        applyTransform();
      } else if (e.touches.length === 1 && isPanning) {
        e.preventDefault();
        const dx = e.touches[0].clientX - panStartX;
        const dy = e.touches[0].clientY - panStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didPanFlag = true;
        tx = panStartTx + dx; ty = panStartTy + dy;
        applyTransform();
      }
    }, { signal: sig });

    container.addEventListener('touchend', () => { isPanning = false; }, { signal: sig });

    // Double-click to reset
    container.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      reset();
    }, { signal: sig });

    container.addEventListener('contextmenu', (e) => {
      if (scale > 1) e.preventDefault();
    }, { signal: sig });

    return {
      reset,
      destroy() { ac.abort(); reset(); },
      scale() { return scale; },
      didPan() { return didPanFlag; },
    };
  }

  // ===== Parent Overlay =====
  let overlay = null;
  let overlayImg = null;
  let overlayZoom = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'gallery-parent-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '10000',
      background: 'rgba(5, 5, 15, 0.97)',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column',
    });

    // Header bar with filename and close button
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', width: '100%',
      padding: '8px 16px', background: 'rgba(0,0,0,0.5)',
      zIndex: '2', gap: '8px',
    });
    const filenameEl = document.createElement('span');
    Object.assign(filenameEl.style, {
      flex: '1', color: '#ccc', fontSize: '13px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    filenameEl.id = 'gallery-overlay-filename';
    const closeBtn = document.createElement('button');
    Object.assign(closeBtn.style, {
      background: 'none', border: 'none', color: '#ccc', fontSize: '24px',
      cursor: 'pointer', padding: '4px 8px', borderRadius: '4px',
      opacity: '0.7', transition: 'opacity 0.15s',
    });
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', closeOverlay);
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.7'; });
    header.appendChild(filenameEl);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    // Image container
    const container = document.createElement('div');
    container.id = 'gallery-overlay-container';
    Object.assign(container.style, {
      flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', position: 'relative', width: '100%',
    });
    overlayImg = document.createElement('img');
    Object.assign(overlayImg.style, {
      maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
      userSelect: 'none',
    });
    overlayImg.draggable = false;
    container.appendChild(overlayImg);
    overlay.appendChild(container);

    // Click on container background (not image) to close
    container.addEventListener('click', (e) => {
      if (e.target === container && (!overlayZoom || overlayZoom.scale() <= 1)
          && (!overlayZoom || !overlayZoom.didPan())) {
        closeOverlay();
      }
    });

    document.body.appendChild(overlay);
    return container;
  }

  function showOverlay(src, filename) {
    if (!overlay) createOverlay();
    const cont = overlay.querySelector('#gallery-overlay-container');
    const fnEl = overlay.querySelector('#gallery-overlay-filename');
    if (fnEl) fnEl.textContent = filename || '';
    overlayImg.src = src;
    overlay.style.display = 'flex';
    // Init zoom/pan
    if (overlayZoom) overlayZoom.destroy();
    overlayZoom = createZoomPanController(cont, overlayImg);
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.style.display = 'none';
    overlayImg.src = '';
    if (overlayZoom) { overlayZoom.destroy(); overlayZoom = null; }
  }

  function isOverlayOpen() {
    return overlay && overlay.style.display !== 'none';
  }

  // Listen for postMessage from the gallery iframe
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'gallery-fullscreen') {
      showOverlay(e.data.src, e.data.filename);
    }
  });

  // Keyboard: Escape to close, R to reset zoom
  document.addEventListener('keydown', (e) => {
    if (!isOverlayOpen()) return;
    if (e.key === 'Escape') {
      closeOverlay();
      e.preventDefault();
      e.stopPropagation();
    } else if ((e.key === 'r' || e.key === 'R') && overlayZoom) {
      overlayZoom.reset();
      e.preventDefault();
      e.stopPropagation();
    }
  }, true); // capture phase so it fires before Gradio handlers
})();
