// Camera Fullscreen Preview: shows generated images fullscreen during live camera mode
// Creates a seamless loop: completed image → live preview → completed image
// Uses setInterval polling because Gradio updates img.src attributes directly
// without DOM childList mutations, so MutationObserver misses them.
(function() {
    'use strict';

    var overlay = null;
    var fullscreenImg = null;
    var indicator = null;
    var isActive = false;
    var lastSrc = '';
    var pollTimer = null;

    function createOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'camera_fullscreen_overlay';

        fullscreenImg = document.createElement('img');
        fullscreenImg.id = 'camera_fullscreen_image';
        overlay.appendChild(fullscreenImg);

        indicator = document.createElement('div');
        indicator.id = 'camera_fullscreen_indicator';
        indicator.textContent = 'Live Camera \u2014 Esc to exit';
        overlay.appendChild(indicator);

        document.body.appendChild(overlay);
    }

    function showFullscreen(src) {
        createOverlay();
        if (src) {
            fullscreenImg.src = src;
            lastSrc = src;
        }
        overlay.classList.add('active');
        isActive = true;
    }

    function hideFullscreen() {
        if (overlay) {
            overlay.classList.remove('active');
        }
        isActive = false;
        lastSrc = '';
        stopPolling();
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(pollForImages, 150);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // Find the preview image from #preview_image (progress_window component)
    // Gradio hides components with display:none on their wrapper — we walk up
    // to check visibility since the elem_id is on the component root but Gradio
    // may wrap it in an extra container for visibility control.
    function getProgressWindowImage() {
        var pw = document.getElementById('preview_image');
        if (!pw) return null;

        // Walk up to check no ancestor is hidden
        var el = pw;
        while (el && el !== document.body) {
            var style = el.style;
            if (style && style.display === 'none') return null;
            el = el.parentElement;
        }

        // Find any img inside — Gradio Image components render an <img> when a value is set
        var img = pw.querySelector('img');
        return (img && img.src) ? img : null;
    }

    // Get the latest (first) image from the final gallery
    function getLatestGalleryImage() {
        var gallery = document.getElementById('final_gallery');
        if (!gallery) return null;

        // Check visibility
        var el = gallery;
        while (el && el !== document.body) {
            var style = el.style;
            if (style && style.display === 'none') return null;
            el = el.parentElement;
        }

        var img = gallery.querySelector('.grid-container > .thumbnail-item:first-child img');
        if (!img) {
            img = gallery.querySelector('.thumbnails > .thumbnail-item:first-child img');
        }
        return (img && img.src) ? img : null;
    }

    // Core polling function — runs every 150ms while camera is active
    function pollForImages() {
        var cameraActive = window.cameraCapture
            && window.cameraCapture.getState() !== 'IDLE';

        if (!cameraActive) {
            if (isActive) hideFullscreen();
            return;
        }

        // Find best available image: preview frames take priority over gallery
        var previewImg = getProgressWindowImage();
        var galleryImg = getLatestGalleryImage();
        var bestSrc = null;

        if (previewImg) {
            bestSrc = previewImg.src;
        } else if (galleryImg) {
            bestSrc = galleryImg.src;
        }

        if (!bestSrc) return;

        if (!isActive) {
            // First image appeared — activate fullscreen immediately
            showFullscreen(bestSrc);
            return;
        }

        // Update image if src changed
        if (bestSrc !== lastSrc) {
            fullscreenImg.src = bestSrc;
            lastSrc = bestSrc;
        }
    }

    // Escape key handler — capture phase fires before any other handler
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && isActive) {
            e.preventDefault();
            e.stopPropagation();
            if (window.cameraCapture) {
                window.cameraCapture.stop();
            }
            hideFullscreen();
        }
    }, true);

    // Detect camera activation to start polling
    onAfterUiUpdate(function() {
        var cameraActive = window.cameraCapture
            && window.cameraCapture.getState() !== 'IDLE';

        if (cameraActive && !isActive && !pollTimer) {
            // Camera just became active — start watching for first image
            startPolling();
        } else if (!cameraActive && isActive) {
            hideFullscreen();
        }
    });

    // Patch cameraCapture.stop for immediate cleanup
    onUiLoaded(function() {
        if (window.cameraCapture) {
            var origStop = window.cameraCapture.stop;
            window.cameraCapture.stop = function() {
                origStop();
                hideFullscreen();
            };
        }
    });

    // Expose API
    window.cameraFullscreen = {
        show: showFullscreen,
        hide: hideFullscreen,
        isActive: function() { return isActive; }
    };
})();
