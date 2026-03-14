// Session Gallery: batch navigation and collapsible batch groups
// Tracks batches by observing gallery DOM changes (pure JS, no Python dependency)
(function() {
    'use strict';

    var sessionBatches = [];  // [{count, prompt, time}, ...]
    var previousGalleryCount = 0;
    var activeBatchIndex = -1; // -1 means ALL
    var collapsedBatches = {}; // {batchIndex: true} for collapsed state

    function getGalleryButtons() {
        // Thumbnails may be nested inside .batch-group-grid containers or flat in grid-container
        return Array.from(document.querySelectorAll('#final_gallery .grid-container .thumbnail-item'));
    }

    function getFlatGalleryButtons() {
        // Only direct children of grid-container (before grouping)
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
        allOpt.textContent = 'All batches (' + sessionBatches.length + ')';
        if (activeBatchIndex === -1) allOpt.selected = true;
        select.appendChild(allOpt);

        // Per-batch options (newest first in display)
        for (var i = sessionBatches.length - 1; i >= 0; i--) {
            var batch = sessionBatches[i];
            var opt = document.createElement('option');
            opt.value = String(i);
            var preview = batch.prompt ? batch.prompt.split(/\s+/).slice(0, 4).join(' ') : '...';
            if (preview.length > 30) preview = preview.substring(0, 30) + '...';
            opt.textContent = 'Batch ' + (i + 1) + ': ' + preview;
            if (activeBatchIndex === i) opt.selected = true;
            select.appendChild(opt);
        }

        select.addEventListener('change', function() {
            var idx = parseInt(this.value, 10);
            activeBatchIndex = idx;
            filterBatch(idx);
        });
        nav.appendChild(select);

        // Expand All button
        var expandBtn = document.createElement('button');
        expandBtn.className = 'batch-nav-btn';
        expandBtn.textContent = '\u25BC All';
        expandBtn.title = 'Expand all batches';
        expandBtn.addEventListener('click', function() {
            collapsedBatches = {};
            renderBatchGroups();
        });
        nav.appendChild(expandBtn);

        // Collapse All button
        var collapseBtn = document.createElement('button');
        collapseBtn.className = 'batch-nav-btn';
        collapseBtn.textContent = '\u25B6 All';
        collapseBtn.title = 'Collapse all batches';
        collapseBtn.addEventListener('click', function() {
            for (var i = 0; i < sessionBatches.length; i++) {
                collapsedBatches[i] = true;
            }
            renderBatchGroups();
        });
        nav.appendChild(collapseBtn);

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
            var latest = sessionBatches[sessionBatches.length - 1];
            promptDisplay.textContent = latest.prompt || '';
        } else {
            promptDisplay.textContent = sessionBatches[batchIndex].prompt || '';
        }
    }

    function filterBatch(batchIndex) {
        // When filtering to a specific batch, show/hide entire batch groups
        var groups = document.querySelectorAll('#final_gallery .batch-group');

        if (groups.length === 0) {
            // Groups haven't been rendered yet, fall back to flat filtering
            var buttons = getFlatGalleryButtons();
            if (batchIndex === -1) {
                buttons.forEach(function(btn) { btn.style.display = ''; });
            } else {
                var domStart = 0;
                for (var j = sessionBatches.length - 1; j > batchIndex; j--) {
                    domStart += sessionBatches[j].count;
                }
                var domEnd = domStart + sessionBatches[batchIndex].count;
                buttons.forEach(function(btn, i) {
                    btn.style.display = (i >= domStart && i < domEnd) ? '' : 'none';
                });
            }
        } else {
            groups.forEach(function(group) {
                var groupIdx = parseInt(group.dataset.batchIndex, 10);
                if (batchIndex === -1) {
                    group.style.display = '';
                } else {
                    group.style.display = (groupIdx === batchIndex) ? '' : 'none';
                }
            });
        }

        updatePromptDisplay(batchIndex);
    }

    function renderBatchGroups() {
        var container = document.querySelector('#final_gallery .grid-container');
        if (!container || sessionBatches.length === 0) return;

        // Collect all thumbnail-items (may be in groups already or flat)
        var allThumbs = Array.from(container.querySelectorAll('.thumbnail-item'));
        if (allThumbs.length === 0) return;

        // Remove existing batch groups - move thumbnails back to container first
        var existingGroups = container.querySelectorAll('.batch-group');
        existingGroups.forEach(function(group) {
            var thumbs = Array.from(group.querySelectorAll('.thumbnail-item'));
            thumbs.forEach(function(t) {
                container.appendChild(t);
            });
            group.remove();
        });

        // Remove old separators
        container.querySelectorAll('.batch-separator').forEach(function(el) { el.remove(); });

        // Re-collect all thumbnails now flat in container
        allThumbs = Array.from(container.querySelectorAll(':scope > .thumbnail-item'));
        if (allThumbs.length === 0) return;

        // Images are newest-first in DOM. Batches are oldest-first in array.
        // Walk from newest batch to oldest to match DOM order.
        var domIndex = 0;
        for (var b = sessionBatches.length - 1; b >= 0; b--) {
            var batch = sessionBatches[b];
            var batchStart = domIndex;
            var batchEnd = Math.min(domIndex + batch.count, allThumbs.length);

            if (batchStart >= allThumbs.length) continue;

            // Create batch group container
            var group = document.createElement('div');
            group.className = 'batch-group';
            group.dataset.batchIndex = String(b);
            var isCollapsed = !!collapsedBatches[b];
            if (isCollapsed) group.classList.add('batch-collapsed');

            // Header bar
            var header = document.createElement('div');
            header.className = 'batch-group-header';
            header.addEventListener('click', (function(idx) {
                return function() {
                    collapsedBatches[idx] = !collapsedBatches[idx];
                    renderBatchGroups();
                };
            })(b));

            var arrow = document.createElement('span');
            arrow.className = 'batch-header-arrow';
            arrow.textContent = isCollapsed ? '\u25B6' : '\u25BC';

            var titleSpan = document.createElement('span');
            titleSpan.className = 'batch-header-title';
            titleSpan.textContent = 'BATCH ' + (b + 1);

            var timeSpan = document.createElement('span');
            timeSpan.className = 'batch-header-time';
            timeSpan.textContent = batch.time;

            var countSpan = document.createElement('span');
            countSpan.className = 'batch-header-count';
            countSpan.textContent = batch.count + ' image' + (batch.count !== 1 ? 's' : '');

            var promptSpan = document.createElement('span');
            promptSpan.className = 'batch-header-prompt';
            var promptText = batch.prompt || '';
            if (promptText.length > 100) promptText = promptText.substring(0, 100) + '...';
            promptSpan.textContent = promptText;

            header.appendChild(arrow);
            header.appendChild(titleSpan);
            header.appendChild(timeSpan);
            header.appendChild(countSpan);
            header.appendChild(promptSpan);
            group.appendChild(header);

            // Grid container for thumbnails
            var grid = document.createElement('div');
            grid.className = 'batch-group-grid';
            if (isCollapsed) grid.style.display = 'none';

            // Move thumbnails into the grid
            for (var i = batchStart; i < batchEnd; i++) {
                grid.appendChild(allThumbs[i]);
            }

            group.appendChild(grid);

            // Insert group into container at the correct position
            // Since we process newest first, insert at end (groups will be in DOM order)
            container.appendChild(group);

            domIndex = batchEnd;
        }

        // Apply filter if active
        if (activeBatchIndex !== -1) {
            filterBatch(activeBatchIndex);
        }

        // Add class to container for flex-direction column layout
        container.classList.add('has-batch-groups');
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
        collapsedBatches = {};
        var nav = document.getElementById('session_batch_nav');
        if (nav) nav.innerHTML = '';
        var pd = document.getElementById('batch_prompt_display');
        if (pd) pd.textContent = '';

        // Remove batch groups and restore container
        var container = document.querySelector('#final_gallery .grid-container');
        if (container) {
            container.classList.remove('has-batch-groups');
            container.querySelectorAll('.batch-group').forEach(function(g) { g.remove(); });
        }
    }

    // Send starred images to Python for approval
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
        // Count only direct thumbnail-items or those inside batch-group-grid
        var allThumbs = document.querySelectorAll('#final_gallery .grid-container .thumbnail-item');
        var currentCount = allThumbs.length;

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

            // Small delay to let Gradio finish DOM updates before we restructure
            setTimeout(function() {
                renderBatchGroups();
            }, 100);
        } else if (currentCount === 0 && previousGalleryCount > 0) {
            clearSession();
        } else if (currentCount === previousGalleryCount && currentCount > 0 && sessionBatches.length > 0) {
            // Gradio may have re-rendered the gallery (e.g. selection change)
            // Check if our groups are still intact
            var groups = document.querySelectorAll('#final_gallery .batch-group');
            if (groups.length === 0) {
                setTimeout(function() {
                    renderBatchGroups();
                }, 100);
            }
        }
    });

    // Expose for external use
    window.sessionGallery = {
        buildBatchNav: buildBatchNav,
        filterBatch: filterBatch,
        clearSession: clearSession,
        getBatches: function() { return sessionBatches; },
        approveStarredImages: approveStarredImages,
        renderBatchGroups: renderBatchGroups
    };
})();
