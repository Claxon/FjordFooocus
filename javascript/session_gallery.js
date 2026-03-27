// Session Gallery: batch navigation and collapsible batch groups
// Tracks batches by observing gallery DOM changes and matching images by URL
(function() {
    'use strict';

    var sessionBatches = [];  // [{count, prompt, time, images: [url, ...]}, ...]
    var previousGalleryCount = 0;
    var previousImageUrls = new Set();  // track seen image URLs for batch detection
    var activeBatchIndex = -1; // -1 means ALL
    var collapsedBatches = {}; // {batchIndex: true} for collapsed state
    var isRestructuring = false; // guard against DOM mutation feedback loops

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

    // Get the image src URL from a thumbnail element
    function getThumbSrc(thumb) {
        var img = thumb.querySelector('img');
        return img ? img.src : '';
    }

    // Flatten batch groups back to flat thumbnails and remove duplicate thumbnails
    function flattenAndDedup(container) {
        // Move thumbnails out of batch groups back to container
        container.querySelectorAll('.batch-group').forEach(function(group) {
            Array.from(group.querySelectorAll('.thumbnail-item')).forEach(function(t) {
                container.appendChild(t);
            });
            group.remove();
        });
        container.querySelectorAll('.batch-separator').forEach(function(el) { el.remove(); });

        // Deduplicate by img src (keep first occurrence, remove later duplicates)
        var seen = new Set();
        container.querySelectorAll(':scope > .thumbnail-item').forEach(function(t) {
            var src = getThumbSrc(t);
            if (!src || seen.has(src)) {
                t.remove();
            } else {
                seen.add(src);
            }
        });
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
            // Groups haven't been rendered yet, fall back to URL-based filtering
            if (batchIndex === -1) {
                getFlatGalleryButtons().forEach(function(btn) { btn.style.display = ''; });
            } else if (sessionBatches[batchIndex] && sessionBatches[batchIndex].images) {
                var batchUrls = new Set(sessionBatches[batchIndex].images);
                getFlatGalleryButtons().forEach(function(btn) {
                    var src = getThumbSrc(btn);
                    btn.style.display = batchUrls.has(src) ? '' : 'none';
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
        if (!container || sessionBatches.length === 0) {
            isRestructuring = false;
            return;
        }

        // Guard: prevent DOM mutations from re-triggering onAfterUiUpdate loop
        isRestructuring = true;

        // Flatten existing groups and deduplicate thumbnails
        flattenAndDedup(container);

        var allThumbs = Array.from(container.querySelectorAll(':scope > .thumbnail-item'));
        if (allThumbs.length === 0) {
            setTimeout(function() { isRestructuring = false; }, 250);
            return;
        }

        // Build URL -> thumbnail map for URL-based matching
        var thumbByUrl = {};
        allThumbs.forEach(function(t) {
            var src = getThumbSrc(t);
            if (src) thumbByUrl[src] = t;
        });

        // Track which thumbnails have been assigned to a batch
        var assigned = new Set();

        // Create batch groups - newest batch first for visual ordering (top to bottom)
        for (var b = sessionBatches.length - 1; b >= 0; b--) {
            var batch = sessionBatches[b];
            var isCollapsed = !!collapsedBatches[b];

            // Create batch group container
            var group = document.createElement('div');
            group.className = 'batch-group';
            group.dataset.batchIndex = String(b);
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

            // Match thumbnails to this batch by URL
            if (batch.images) {
                batch.images.forEach(function(url) {
                    if (thumbByUrl[url] && !assigned.has(url)) {
                        grid.appendChild(thumbByUrl[url]);
                        assigned.add(url);
                    }
                });
            }

            group.appendChild(grid);
            container.appendChild(group);
        }

        // Any unassigned thumbnails go into the newest batch group
        var unassigned = Array.from(container.querySelectorAll(':scope > .thumbnail-item'));
        if (unassigned.length > 0) {
            var newestGroup = container.querySelector('.batch-group[data-batch-index="' + (sessionBatches.length - 1) + '"] .batch-group-grid');
            if (!newestGroup) {
                // Fallback: find the first group's grid
                newestGroup = container.querySelector('.batch-group .batch-group-grid');
            }
            if (newestGroup) {
                unassigned.forEach(function(t) {
                    newestGroup.appendChild(t);
                });
            }
        }

        // Apply filter if active
        if (activeBatchIndex !== -1) {
            filterBatch(activeBatchIndex);
        }

        // Add class to container for flex-direction column layout
        container.classList.add('has-batch-groups');

        // Release guard after a tick so the MutationObserver events from our
        // DOM changes are flushed before we start listening again
        setTimeout(function() { isRestructuring = false; }, 250);
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
        previousImageUrls = new Set();
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

    // Detect new gallery images by observing DOM changes and tracking URLs
    onAfterUiUpdate(function() {
        // Skip if we're already restructuring the DOM to prevent feedback loops
        if (isRestructuring) return;

        var container = document.querySelector('#final_gallery .grid-container');
        if (!container) return;

        // Guard DOM mutations so MutationObserver doesn't re-trigger us
        isRestructuring = true;

        // Flatten groups and remove duplicates to get a clean, accurate count
        flattenAndDedup(container);

        var allThumbs = Array.from(container.querySelectorAll(':scope > .thumbnail-item'));
        var currentCount = allThumbs.length;

        // Build current URL set from clean thumbnails
        var currentUrls = new Set();
        allThumbs.forEach(function(t) {
            var src = getThumbSrc(t);
            if (src) currentUrls.add(src);
        });

        // Detect new images by URL difference (not count difference)
        var newUrls = [];
        currentUrls.forEach(function(url) {
            if (!previousImageUrls.has(url)) newUrls.push(url);
        });

        var willRenderGroups = false;

        if (newUrls.length > 0 && currentCount > 0) {
            var now = new Date();
            var hours = now.getHours();
            var ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12 || 12;
            var minutes = now.getMinutes().toString().padStart(2, '0');
            var timeStr = hours + ':' + minutes + ' ' + ampm;

            sessionBatches.push({
                count: newUrls.length,
                prompt: getCurrentPrompt(),
                time: timeStr,
                images: newUrls  // track which image URLs belong to this batch
            });
            previousImageUrls = new Set(currentUrls);
            previousGalleryCount = currentCount;
            buildBatchNav();
            updatePromptDisplay(activeBatchIndex);

            // Small delay to let Gradio finish DOM updates before we restructure
            // renderBatchGroups will manage its own guard release
            willRenderGroups = true;
            setTimeout(function() {
                renderBatchGroups();
            }, 100);
        } else if (currentCount === 0 && previousGalleryCount > 0) {
            clearSession();
        } else if (currentCount > 0 && sessionBatches.length > 0) {
            // Update tracking state even when no new images
            previousImageUrls = new Set(currentUrls);
            previousGalleryCount = currentCount;
            // Gradio may have re-rendered the gallery (e.g. selection change)
            // Check if our groups are still intact
            var groups = document.querySelectorAll('#final_gallery .batch-group');
            if (groups.length === 0) {
                willRenderGroups = true;
                setTimeout(function() {
                    renderBatchGroups();
                }, 100);
            }
        }

        // Release guard if renderBatchGroups won't run (it handles its own release)
        if (!willRenderGroups) {
            setTimeout(function() { isRestructuring = false; }, 250);
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
