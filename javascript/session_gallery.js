// Session Gallery: batch navigation, filtering, and Save Starred
// Tracks batches by observing gallery DOM changes (pure JS, no Python dependency)
(function() {
    'use strict';

    var sessionBatches = [];  // [{count, prompt, time}, ...]
    var previousGalleryCount = 0;
    var activeBatchIndex = -1; // -1 means ALL

    function getGalleryButtons() {
        return Array.from(document.querySelectorAll('#final_gallery .grid-container > .thumbnail-item'));
    }

    function getCurrentPrompt() {
        var el = document.querySelector('#positive_prompt textarea');
        return el ? el.value : '';
    }

    function buildBatchNav() {
        var nav = document.getElementById('session_batch_nav');
        if (!nav) return;
        nav.innerHTML = '';

        if (sessionBatches.length === 0) return;

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

        // Per-batch buttons (newest first in display)
        for (var i = sessionBatches.length - 1; i >= 0; i--) {
            (function(idx) {
                var batch = sessionBatches[idx];
                var btn = document.createElement('button');
                btn.className = 'batch-nav-btn' + (activeBatchIndex === idx ? ' active' : '');
                var preview = batch.prompt ? batch.prompt.split(/\s+/).slice(0, 3).join(' ') : '...';
                btn.textContent = batch.time + ' \u2014 ' + preview;
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
        var buttons = getGalleryButtons();
        var promptDisplay = document.getElementById('batch_prompt_display');

        if (batchIndex === -1 || sessionBatches.length === 0) {
            buttons.forEach(function(btn) { btn.style.display = ''; });
            if (promptDisplay) promptDisplay.textContent = '';
            return;
        }

        // Images are newest-first in DOM. Batches are oldest-first in array.
        // DOM offset: images from batches AFTER this one (newer) come first
        var domStart = 0;
        for (var j = sessionBatches.length - 1; j > batchIndex; j--) {
            domStart += sessionBatches[j].count;
        }
        var domEnd = domStart + sessionBatches[batchIndex].count;

        buttons.forEach(function(btn, i) {
            btn.style.display = (i >= domStart && i < domEnd) ? '' : 'none';
        });

        if (promptDisplay) {
            promptDisplay.textContent = sessionBatches[batchIndex].prompt || '';
        }
    }

    function approveSelectedImages() {
        if (typeof gallerySelectedImages === 'undefined' || gallerySelectedImages.size === 0) return;
        var urls = Array.from(gallerySelectedImages);
        var el = document.querySelector('#approve_images_request textarea') ||
                 document.querySelector('#approve_images_request input');
        if (el) {
            el.value = urls.join('\n');
            var e = new Event('input', { bubbles: true });
            Object.defineProperty(e, 'target', { value: el });
            el.dispatchEvent(e);
        }

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
        sessionBatches = [];
        previousGalleryCount = 0;
        activeBatchIndex = -1;
        var nav = document.getElementById('session_batch_nav');
        if (nav) nav.innerHTML = '';
        var pd = document.getElementById('batch_prompt_display');
        if (pd) pd.textContent = '';
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

    // Detect new gallery images by observing DOM changes
    onAfterUiUpdate(function() {
        var buttons = getGalleryButtons();
        var currentCount = buttons.length;

        if (currentCount > previousGalleryCount && currentCount > 0) {
            var newCount = currentCount - previousGalleryCount;
            var now = new Date();
            var hours = now.getHours();
            var ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            var minutes = now.getMinutes().toString().padStart(2, '0');
            var timeStr = hours + ':' + minutes + ' ' + ampm;

            sessionBatches.push({
                count: newCount,
                prompt: getCurrentPrompt(),
                time: timeStr
            });
            previousGalleryCount = currentCount;
            buildBatchNav();
        } else if (currentCount === 0 && previousGalleryCount > 0) {
            // Gallery was cleared (e.g. reset)
            clearSession();
        }

        updateSaveStarredButton();
    });

    // Expose for external use
    window.sessionGallery = {
        buildBatchNav: buildBatchNav,
        filterBatch: filterBatch,
        clearSession: clearSession,
        getBatches: function() { return sessionBatches; }
    };
})();
