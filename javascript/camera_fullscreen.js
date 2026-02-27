// Camera Fullscreen Preview: shows generated images fullscreen during live camera mode
// Creates a seamless loop: completed image → live preview → completed image
(function() {
    'use strict';

    var overlay = null;
    var fullscreenImg = null;
    var indicator = null;
    var isActive = false;
    var firstImageReceived = false;
    var lastSrc = '';

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
        firstImageReceived = false;
        lastSrc = '';
    }

    // progress_window is the .main_view that is NOT .image_gallery (not a gallery component)
    function getProgressWindowImage() {
        var pw = document.querySelector('.main_view:not(.image_gallery)');
        if (!pw) return null;
        // Check visibility: Gradio hides via style="display: none" on wrapper
        if (pw.offsetParent === null) return null;
        var parent = pw.closest('[style*="display: none"], [style*="display:none"]');
        if (parent) return null;
        var img = pw.querySelector('img');
        return (img && img.src) ? img : null;
    }

    // Get the latest (first) image from the final gallery
    function getLatestGalleryImage() {
        var gallery = document.getElementById('final_gallery');
        if (!gallery) return null;
        if (gallery.offsetParent === null) return null;
        var parent = gallery.closest('[style*="display: none"], [style*="display:none"]');
        if (parent) return null;
        var img = gallery.querySelector('.grid-container > .thumbnail-item:first-child img');
        if (!img) {
            // Also try thumbnail view
            img = gallery.querySelector('.thumbnails > .thumbnail-item:first-child img');
        }
        return (img && img.src) ? img : null;
    }

    function updateFullscreenImage() {
        // Priority: progress_window (live preview) > final_gallery (completed)
        var previewImg = getProgressWindowImage();
        if (previewImg && previewImg.src !== lastSrc) {
            fullscreenImg.src = previewImg.src;
            lastSrc = previewImg.src;
            return;
        }

        var galleryImg = getLatestGalleryImage();
        if (galleryImg && galleryImg.src !== lastSrc) {
            fullscreenImg.src = galleryImg.src;
            lastSrc = galleryImg.src;
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

    // Monitor camera state and image updates
    onAfterUiUpdate(function() {
        var cameraActive = window.cameraCapture
            && window.cameraCapture.getState() !== 'IDLE';

        if (!cameraActive) {
            if (isActive) hideFullscreen();
            firstImageReceived = false;
            return;
        }

        // Camera is active. Detect first completed image to activate fullscreen.
        if (!firstImageReceived) {
            var galleryImg = getLatestGalleryImage();
            if (galleryImg) {
                firstImageReceived = true;
                showFullscreen(galleryImg.src);
            }
            return;
        }

        // Fullscreen is active — update image from best available source
        if (isActive) {
            updateFullscreenImage();
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
