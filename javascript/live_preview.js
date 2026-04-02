// Live Preview: floating overlay during generation + gallery iframe refresh
// Shows a preview thumbnail over the gallery iframe while images are being generated.
// When generation finishes, refreshes the gallery iframe to show new images.
(function() {
    'use strict';

    var livePreviewEl = null;
    var livePreviewImg = null;
    var liveProgressBar = null;
    var isGenerating = false;

    function getIframeWrap() {
        return document.getElementById('gallery_iframe_wrap');
    }

    function getIframe() {
        return document.getElementById('gallery_iframe');
    }

    function createLivePreview() {
        if (livePreviewEl) return livePreviewEl;

        livePreviewEl = document.createElement('div');
        livePreviewEl.className = 'live-preview-overlay';

        var badge = document.createElement('span');
        badge.className = 'live-preview-badge';
        badge.textContent = 'LIVE';
        livePreviewEl.appendChild(badge);

        livePreviewImg = document.createElement('img');
        livePreviewImg.className = 'live-preview-img';
        livePreviewImg.alt = 'Live preview';
        livePreviewEl.appendChild(livePreviewImg);

        var progressWrap = document.createElement('div');
        progressWrap.className = 'live-preview-progress';
        liveProgressBar = document.createElement('div');
        liveProgressBar.className = 'live-preview-progress-fill';
        progressWrap.appendChild(liveProgressBar);
        livePreviewEl.appendChild(progressWrap);

        var statusText = document.createElement('span');
        statusText.className = 'live-preview-status';
        statusText.textContent = 'Starting...';
        livePreviewEl.appendChild(statusText);

        return livePreviewEl;
    }

    function insertLivePreview() {
        var wrap = getIframeWrap();
        if (!wrap) return;
        // Ensure the wrap is positioned for absolute children
        wrap.style.position = 'relative';
        if (!wrap.contains(livePreviewEl)) {
            wrap.appendChild(livePreviewEl);
        }
    }

    function removeLivePreview() {
        if (livePreviewEl && livePreviewEl.parentNode) {
            livePreviewEl.classList.add('live-preview-fade-out');
            setTimeout(function() {
                if (livePreviewEl && livePreviewEl.parentNode) {
                    livePreviewEl.parentNode.removeChild(livePreviewEl);
                }
                livePreviewEl = null;
                livePreviewImg = null;
                liveProgressBar = null;
            }, 400);
        } else {
            livePreviewEl = null;
            livePreviewImg = null;
            liveProgressBar = null;
        }
    }

    function refreshGalleryIframe() {
        var iframe = getIframe();
        if (!iframe) return;
        try {
            // Try to call the gallery's refresh function if accessible
            if (iframe.contentWindow && iframe.contentWindow.loadImages) {
                iframe.contentWindow.loadImages();
            } else {
                // Fallback: reload the iframe
                iframe.src = iframe.src;
            }
        } catch (e) {
            // Cross-origin fallback
            iframe.src = iframe.src;
        }
    }

    function updateFromPreviewData() {
        // Look for the image inside the hidden live_preview_data Gradio component
        var dataEl = document.querySelector('#live_preview_data img');
        if (!dataEl) return;
        var src = dataEl.src;
        if (!src || src === '' || src === window.location.href || src.endsWith('/')) return;
        if (livePreviewImg && src !== livePreviewImg.src) {
            livePreviewImg.src = src;
        }
    }

    function updateProgress() {
        var progressBarEl = document.querySelector('#progress-bar');
        if (!progressBarEl) return;

        // Extract percentage from the progress bar HTML
        var progressText = progressBarEl.textContent || progressBarEl.innerText || '';
        var match = progressText.match(/(\d+)%/);
        var pct = match ? parseInt(match[1], 10) : 0;

        if (liveProgressBar) {
            liveProgressBar.style.width = pct + '%';
        }

        // Update status text
        var statusEl = livePreviewEl ? livePreviewEl.querySelector('.live-preview-status') : null;
        if (statusEl) {
            // Extract the title text (e.g. "Sampling step 5/20")
            var titleMatch = progressText.match(/^\s*(.+?)\s*\d+%/);
            if (titleMatch) {
                statusEl.textContent = titleMatch[1].trim();
            } else if (pct > 0) {
                statusEl.textContent = pct + '%';
            }
        }
    }

    // Detect generation start/stop by watching the progress bar visibility
    function checkGenerationState() {
        var progressBarEl = document.querySelector('#progress-bar');
        if (!progressBarEl) return;

        var isVisible = progressBarEl.offsetParent !== null &&
                        progressBarEl.style.display !== 'none' &&
                        !progressBarEl.classList.contains('hidden');

        if (isVisible && !isGenerating) {
            // Generation started
            isGenerating = true;
            createLivePreview();
            insertLivePreview();
        } else if (!isVisible && isGenerating) {
            // Generation finished
            isGenerating = false;
            removeLivePreview();
            // Refresh gallery iframe to show new images
            setTimeout(refreshGalleryIframe, 500);
        }

        if (isGenerating) {
            updateFromPreviewData();
            updateProgress();
        }
    }

    // Poll for state changes
    var pollInterval = null;

    function startPolling() {
        if (pollInterval) return;
        pollInterval = setInterval(checkGenerationState, 200);
    }

    // Fallback: if the login JS didn't trigger iframe auth (e.g. restored session),
    // poll until the iframe has a src or the user is detected, then authenticate.
    function ensureIframeLoaded() {
        var iframe = getIframe();
        if (!iframe) return;
        // Check if iframe already has a real src (loaded by login JS)
        var currentSrc = iframe.getAttribute('src') || '';
        if (currentSrc && currentSrc.indexOf('127.0.0.1:7867') !== -1) return;

        // Try to get the username from profile_input or logged_in_label
        var user = '';
        var profileEl = document.querySelector('#profile_input textarea, #profile_input input');
        if (profileEl && profileEl.value && profileEl.value.trim()) {
            user = profileEl.value.trim();
        }
        if (!user) {
            var label = document.querySelector('#user_status_bar');
            if (label) {
                var b = label.querySelector('b');
                if (b) user = b.textContent.trim();
            }
        }
        if (!user) return;

        // Authenticate via server-side redirect that sets HttpOnly cookie
        iframe.src = 'http://127.0.0.1:7867/embed-login?user=' + encodeURIComponent(user);
    }

    function watchForLogin() {
        var loginPoll = setInterval(function() {
            var iframe = getIframe();
            if (!iframe) return;
            // Stop polling once iframe has a real gallery src
            var src = iframe.getAttribute('src') || '';
            if (src.indexOf('127.0.0.1:7867') !== -1) {
                clearInterval(loginPoll);
                return;
            }
            ensureIframeLoaded();
        }, 500);
    }

    // Start polling once UI is loaded
    if (typeof onUiLoaded === 'function') {
        onUiLoaded(function() {
            startPolling();
            watchForLogin();
        });
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(startPolling, 2000);
            setTimeout(watchForLogin, 1000);
        });
    }

    // Expose for external use
    window.livePreview = {
        isActive: function() { return isGenerating; },
        getElement: function() { return livePreviewEl; },
        refreshGallery: refreshGalleryIframe
    };
})();
