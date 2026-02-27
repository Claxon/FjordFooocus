// Session Gallery: batch navigation (dropdown filter), and starred approve
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

        // Dropdown filter
        var select = document.createElement('select');
        select.id = 'batch_filter_select';

        var allOpt = document.createElement('option');
        allOpt.value = '-1';
        allOpt.textContent = 'All batches';
        if (activeBatchIndex === -1) allOpt.selected = true;
        select.appendChild(allOpt);

        // Per-batch options (newest first in display)
        for (var i = sessionBatches.length - 1; i >= 0; i--) {
            var batch = sessionBatches[i];
            var opt = document.createElement('option');
            opt.value = String(i);
            var preview = batch.prompt ? batch.prompt.split(/\s+/).slice(0, 4).join(' ') : '...';
            if (preview.length > 30) preview = preview.substring(0, 30) + '...';
            opt.textContent = batch.time + ' \u2014 ' + preview;
            if (activeBatchIndex === i) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener('change', function() {
            var idx = parseInt(this.value, 10);
            activeBatchIndex = idx;
            filterBatch(idx);
        });
        nav.appendChild(select);

        // Clear Session button
        var clearBtn = document.createElement('button');
        clearBtn.className = 'batch-clear-btn';
        clearBtn.textContent = '\uD83D\uDDD1 Clear';
        clearBtn.title = 'Clear session gallery';
        clearBtn.addEventListener('click', function() {
            clearSession();
        });
        nav.appendChild(clearBtn);
    }

    function updatePromptDisplay(batchIndex) {
        var promptDisplay = document.getElementById('batch_prompt_display');
        if (!promptDisplay) return;

        if (sessionBatches.length === 0) {
            promptDisplay.textContent = '';
            return;
        }

        if (batchIndex === -1) {
            // "All" selected: show the most recent batch prompt
            var latest = sessionBatches[sessionBatches.length - 1];
            promptDisplay.textContent = latest.prompt || '';
        } else {
            promptDisplay.textContent = sessionBatches[batchIndex].prompt || '';
        }
    }

    function filterBatch(batchIndex) {
        var buttons = getGalleryButtons();

        if (batchIndex === -1 || sessionBatches.length === 0) {
            buttons.forEach(function(btn) { btn.style.display = ''; });
            updatePromptDisplay(batchIndex);
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

        updatePromptDisplay(batchIndex);
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

    // Send starred images to Python for approval (uses galleryStarredImages from imageviewer.js)
    function approveStarredImages() {
        if (typeof galleryStarredImages === 'undefined' || galleryStarredImages.size === 0) return;
        var urls = Array.from(galleryStarredImages);
        var el = document.querySelector('#approve_images_request textarea') ||
                 document.querySelector('#approve_images_request input');
        if (el) {
            el.value = urls.join('\n');
            var e = new Event('input', { bubbles: true });
            Object.defineProperty(e, 'target', { value: el });
            el.dispatchEvent(e);
        }

        showToast('Saving ' + urls.length + ' starred image(s)...');

        // Clear all stars
        galleryStarredImages.clear();
        document.querySelectorAll('.gallery-star.starred').forEach(function(star) {
            star.textContent = '\u2606';
            star.classList.remove('starred');
        });
        if (typeof updateStarredUI === 'function') {
            updateStarredUI();
        }
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
            updatePromptDisplay(activeBatchIndex);
        } else if (currentCount === 0 && previousGalleryCount > 0) {
            // Gallery was cleared (e.g. reset)
            clearSession();
        }
    });

    // Expose for external use
    window.sessionGallery = {
        buildBatchNav: buildBatchNav,
        filterBatch: filterBatch,
        clearSession: clearSession,
        getBatches: function() { return sessionBatches; },
        approveStarredImages: approveStarredImages
    };
})();
