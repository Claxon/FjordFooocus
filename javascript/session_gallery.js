// Session Gallery: batch navigation, filtering, and Save Starred
(function() {
    'use strict';

    var activeBatchIndex = -1; // -1 means ALL

    function getBatchData() {
        var el = document.querySelector('#session_batch_info');
        if (!el) return [];
        // The data is in a nested element — Gradio wraps HTML content
        var text = el.textContent || el.innerText || '';
        text = text.trim();
        if (!text || text === '[]') return [];
        try {
            return JSON.parse(text);
        } catch(e) { return []; }
    }

    function getGalleryButtons() {
        return Array.from(document.querySelectorAll('#final_gallery .grid-container > .thumbnail-item'));
    }

    function buildBatchNav() {
        var nav = document.getElementById('session_batch_nav');
        if (!nav) return;

        var batches = getBatchData();
        nav.innerHTML = '';

        if (batches.length === 0) return;

        // ALL button
        var allBtn = document.createElement('button');
        allBtn.className = 'batch-nav-btn' + (activeBatchIndex === -1 ? ' active' : '');
        allBtn.textContent = 'ALL';
        allBtn.addEventListener('click', function() {
            activeBatchIndex = -1;
            filterBatch(-1);
            buildBatchNav();
        });
        nav.appendChild(allBtn);

        // Per-batch buttons (newest batch = last in array, but images are prepended = first in DOM)
        for (var i = batches.length - 1; i >= 0; i--) {
            (function(idx) {
                var batch = batches[idx];
                var btn = document.createElement('button');
                btn.className = 'batch-nav-btn' + (activeBatchIndex === idx ? ' active' : '');
                btn.textContent = batch.time + ' \u2014 ' + (batch.preview || '...');
                btn.title = batch.prompt || '';
                btn.addEventListener('click', function() {
                    activeBatchIndex = idx;
                    filterBatch(idx);
                    buildBatchNav();
                });
                nav.appendChild(btn);
            })(i);
        }

        // Save Starred button
        var saveBtn = document.createElement('button');
        saveBtn.className = 'save-starred-btn';
        saveBtn.id = 'save_starred_btn';
        saveBtn.textContent = '\u2B50 Save Starred';
        saveBtn.style.display = 'none';
        saveBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            approveSelectedImages();
        });
        nav.appendChild(saveBtn);

        // Clear Session button
        var clearBtn = document.createElement('button');
        clearBtn.className = 'batch-nav-btn batch-clear-btn';
        clearBtn.textContent = '\uD83D\uDDD1 Clear';
        clearBtn.title = 'Clear session gallery';
        clearBtn.addEventListener('click', function() {
            clearSession();
        });
        nav.appendChild(clearBtn);

        updateSaveStarredButton();
    }

    function filterBatch(batchIndex) {
        var batches = getBatchData();
        var buttons = getGalleryButtons();
        var promptDisplay = document.getElementById('batch_prompt_display');

        if (batchIndex === -1 || batches.length === 0) {
            // Show ALL
            buttons.forEach(function(btn) { btn.style.display = ''; });
            if (promptDisplay) promptDisplay.textContent = '';
            return;
        }

        // Calculate DOM offset for the selected batch
        // Batches are stored oldest-first in array. Images are newest-first in DOM.
        // So batch[last] images are at DOM positions 0..count-1
        var totalImages = 0;
        for (var i = 0; i < batches.length; i++) {
            totalImages += batches[i].count;
        }

        // DOM offset: images from batches AFTER this one (newer) come first
        var domStart = 0;
        for (var j = batches.length - 1; j > batchIndex; j--) {
            domStart += batches[j].count;
        }
        var domEnd = domStart + batches[batchIndex].count;

        buttons.forEach(function(btn, i) {
            btn.style.display = (i >= domStart && i < domEnd) ? '' : 'none';
        });

        if (promptDisplay) {
            promptDisplay.textContent = batches[batchIndex].prompt || '';
        }
    }

    function approveSelectedImages() {
        if (typeof gallerySelectedImages === 'undefined' || gallerySelectedImages.size === 0) return;
        var urls = Array.from(gallerySelectedImages);
        var el = document.querySelector('#approve_images_request textarea');
        if (!el) {
            el = document.querySelector('#approve_images_request input');
        }
        if (el) {
            el.value = urls.join('\n');
            var e = new Event('input', { bubbles: true });
            Object.defineProperty(e, 'target', { value: el });
            el.dispatchEvent(e);
        }

        // Show toast
        showToast('Saving ' + urls.length + ' image(s)...');

        // Uncheck all
        gallerySelectedImages.clear();
        document.querySelectorAll('.gallery-select-checkbox').forEach(function(cb) {
            cb.checked = false;
        });
        document.querySelectorAll('.gallery-checked').forEach(function(el) {
            el.classList.remove('gallery-checked');
        });
        if (typeof updateDeleteSelectedButton === 'function') {
            updateDeleteSelectedButton();
        }
        updateSaveStarredButton();
    }

    function showToast(message) {
        var existing = document.getElementById('fooocus_toast');
        if (existing) existing.remove();
        var toast = document.createElement('div');
        toast.id = 'fooocus_toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function() {
            toast.classList.add('fade-out');
            setTimeout(function() { toast.remove(); }, 500);
        }, 2000);
    }

    function clearSession() {
        activeBatchIndex = -1;
        // Clear batch nav
        var nav = document.getElementById('session_batch_nav');
        if (nav) nav.innerHTML = '';
        // Clear prompt display
        var pd = document.getElementById('batch_prompt_display');
        if (pd) pd.textContent = '';
        // Trigger Python-side clear by clicking reset or setting gallery to empty
        // We'll use a simple approach: find and set the session_batch_info to empty
        var batchEl = document.querySelector('#session_batch_info');
        if (batchEl) {
            // Find the inner textarea/span and clear it
            var inner = batchEl.querySelector('textarea') || batchEl.querySelector('input');
            if (inner) {
                inner.value = '[]';
                var e = new Event('input', { bubbles: true });
                Object.defineProperty(e, 'target', { value: inner });
                inner.dispatchEvent(e);
            }
        }
        // Clear the gallery visually
        var gallery = document.querySelector('#final_gallery .grid-container');
        if (gallery) gallery.innerHTML = '';
    }

    function updateSaveStarredButton() {
        var btn = document.getElementById('save_starred_btn');
        if (!btn) return;
        var count = (typeof gallerySelectedImages !== 'undefined') ? gallerySelectedImages.size : 0;
        if (count > 0) {
            btn.style.display = 'inline-flex';
            btn.textContent = '\u2B50 Save Starred (' + count + ')';
        } else {
            btn.style.display = 'none';
        }
    }

    // Hook into the existing checkbox system to update Save Starred button
    var origUpdateDelete = window.updateDeleteSelectedButton;
    if (typeof origUpdateDelete === 'function') {
        window.updateDeleteSelectedButton = function() {
            origUpdateDelete();
            updateSaveStarredButton();
        };
    }

    // Observe batch info changes to rebuild nav
    var lastBatchJson = '';
    onAfterUiUpdate(function() {
        var batches = getBatchData();
        var json = JSON.stringify(batches);
        if (json !== lastBatchJson) {
            lastBatchJson = json;
            buildBatchNav();
            // Re-apply filter if a specific batch was selected
            if (activeBatchIndex >= 0) {
                filterBatch(activeBatchIndex);
            }
        }
        // Also keep save starred button in sync
        updateSaveStarredButton();
    });

    // Expose for external use
    window.sessionGallery = {
        buildBatchNav: buildBatchNav,
        filterBatch: filterBatch,
        clearSession: clearSession
    };
})();
