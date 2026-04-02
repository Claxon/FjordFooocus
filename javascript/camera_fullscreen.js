// Camera Fullscreen Preview: shows generated images fullscreen during live camera mode
// Creates a seamless loop: completed image → live preview → completed image
// Features: flash on capture, freeze-frame of completed image, countdown timer
// Uses setInterval polling because Gradio updates img.src attributes directly
// without DOM childList mutations, so MutationObserver misses them.
(function() {
    'use strict';

    var overlay = null;
    var fullscreenImg = null;
    var indicator = null;
    var flashEl = null;
    var countdownEl = null;
    var countdownBarEl = null;
    var isActive = false;
    var lastSrc = '';
    var pollTimer = null;
    var countdownTimer = null;
    var freezeTimeout = null;
    var isFrozen = false;  // true while showing freeze-frame of completed image

    function createOverlay() {
        if (overlay) return;

        overlay = document.createElement('div');
        overlay.id = 'camera_fullscreen_overlay';

        fullscreenImg = document.createElement('img');
        fullscreenImg.id = 'camera_fullscreen_image';
        overlay.appendChild(fullscreenImg);

        // Flash overlay for capture effect
        flashEl = document.createElement('div');
        flashEl.id = 'camera_fullscreen_flash';
        overlay.appendChild(flashEl);

        // Countdown timer display
        countdownEl = document.createElement('div');
        countdownEl.id = 'camera_fullscreen_countdown';
        countdownEl.style.display = 'none';
        overlay.appendChild(countdownEl);

        // Countdown progress bar
        countdownBarEl = document.createElement('div');
        countdownBarEl.id = 'camera_fullscreen_bar';
        countdownBarEl.style.display = 'none';
        var barInner = document.createElement('div');
        barInner.id = 'camera_fullscreen_bar_inner';
        countdownBarEl.appendChild(barInner);
        overlay.appendChild(countdownBarEl);

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
        isFrozen = false;
        stopPolling();
        stopCountdown();
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

    // ---- Flash effect ----

    function triggerFlash() {
        if (!flashEl) return;
        // Remove then re-add class to retrigger animation
        flashEl.classList.remove('flash-active');
        // Force reflow so removing/adding class works
        void flashEl.offsetWidth;
        flashEl.classList.add('flash-active');
    }

    // ---- Freeze-frame: hold the completed image briefly ----

    function startFreeze() {
        isFrozen = true;
        if (freezeTimeout) clearTimeout(freezeTimeout);
        // Hold the completed image for 1.5 seconds before resuming live preview
        freezeTimeout = setTimeout(function() {
            isFrozen = false;
            freezeTimeout = null;
        }, 1500);
    }

    // ---- Countdown timer ----

    function startCountdown(predictedMs) {
        if (!countdownEl || !countdownBarEl) return;
        if (predictedMs <= 0) {
            // No prediction yet — show indeterminate
            countdownEl.textContent = 'Generating...';
            countdownEl.style.display = 'block';
            countdownBarEl.style.display = 'none';
            return;
        }

        countdownEl.style.display = 'block';
        countdownBarEl.style.display = 'block';

        var startTime = Date.now();
        var barInner = countdownBarEl.querySelector('#camera_fullscreen_bar_inner');

        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = setInterval(function() {
            var elapsed = Date.now() - startTime;
            var remaining = Math.max(0, predictedMs - elapsed);
            var secs = Math.ceil(remaining / 1000);

            if (secs > 0) {
                countdownEl.textContent = 'Next image in ~' + secs + 's';
            } else {
                countdownEl.textContent = 'Almost ready...';
            }

            // Progress bar: 0% at start → 100% at predicted time
            var pct = Math.min(100, (elapsed / predictedMs) * 100);
            if (barInner) barInner.style.width = pct + '%';
        }, 250);
    }

    function stopCountdown() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        if (countdownEl) countdownEl.style.display = 'none';
        if (countdownBarEl) countdownBarEl.style.display = 'none';
    }

    // ---- Image source helpers ----

    function getProgressWindowImage() {
        // Check inline live preview first
        var lp = document.querySelector('.live-preview-item .live-preview-img');
        if (lp && lp.src && lp.src !== window.location.href) return lp;

        // Fallback to hidden live_preview_data pipe
        var pw = document.getElementById('live_preview_data');
        if (!pw) return null;
        var img = pw.querySelector('img');
        return (img && img.src) ? img : null;
    }

    function getLatestGalleryImage() {
        var gallery = document.getElementById('final_gallery');
        if (!gallery) return null;

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

    // ---- Core polling ----

    function pollForImages() {
        var cameraActive = window.cameraCapture
            && window.cameraCapture.getState() !== 'IDLE';

        if (!cameraActive) {
            if (isActive) hideFullscreen();
            return;
        }

        // Don't update the image while frozen (showing completed result)
        if (isFrozen) return;

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
            showFullscreen(bestSrc);
            return;
        }

        if (bestSrc !== lastSrc) {
            fullscreenImg.src = bestSrc;
            lastSrc = bestSrc;
        }
    }

    // ---- Event listeners for capture lifecycle ----

    // Generation started → show countdown
    window.addEventListener('livegenerate-start', function(e) {
        if (!isActive) return;
        var predictedMs = (e.detail && e.detail.predictedMs) || 0;
        startCountdown(predictedMs);
    });

    // Generation finished → flash + freeze + hide countdown
    window.addEventListener('livegenerate-captured', function() {
        if (!isActive) return;
        stopCountdown();
        triggerFlash();
        startFreeze();
    });

    // Escape key handler
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
