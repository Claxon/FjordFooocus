// Camera Fullscreen Preview: shows generated images fullscreen during live camera mode
// Creates a seamless loop: completed image → live preview → completed image
// Uses setInterval polling (not onAfterUiUpdate) because Gradio updates img.src
// attributes directly without DOM childList mutations.
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
        pollTimer = setInterval(pollForImages, 200);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // progress_window is the .main_view that is NOT .image_gallery (not a gallery component)
    function getProgressWindowImage() {
        var pw = document.querySelector('.main_view:not(.image_gallery)');
        if (!pw) return null;
        // Check visibility: Gradio hides with display:none on wrapper
        if (pw.offsetParent === null) return null;
        var img = pw.querySelector('img');
        return (img && img.src) ? img : null;
    }

    // Get the latest (first) image from the final gallery
    function getLatestGalleryImage() {
        var gallery = document.getElementById('final_gallery');
        if (!gallery) return null;
        if (gallery.offsetParent === null) return null;
        var img = gallery.querySelector('.grid-container > .thumbnail-item:first-child img');
        if (!img) {
            img = gallery.querySelector('.thumbnails > .thumbnail-item:first-child img');
        }
        return (img && img.src) ? img : null;
    }

    // Core polling function — runs every 200ms while camera is active
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
