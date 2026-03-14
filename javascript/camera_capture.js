// Camera Capture: flag-toggle camera targets + Live Generate continuous loop
// Camera buttons toggle which inputs receive camera frames (multiple can be flagged).
// "Live Generate" starts the webcam stream + capture loop, injecting each frame into
// ALL flagged targets, optionally generating a mask first, then clicking Generate.
(function() {
    'use strict';

    // ---- State ----
    var liveState = 'IDLE'; // IDLE | PREVIEWING | CAPTURING | WAITING_FOR_IDLE | WAITING_FOR_MASK
    var cameraTargets = new Set();  // Set of target selectors, e.g. '#uov_input_image'
    var mediaStream = null;
    var pollInterval = null;
    var previewContainer = null;
    var videoElement = null;
    var statusElement = null;
    var deviceSelect = null;

    // ---- Constants ----
    var PREF_DEVICE_ID = 'fjord_camera_device_id';

    // Map button elem_ids to their Gradio image target selectors
    var BUTTON_TARGET_MAP = {
        'uov_camera_btn': '#uov_input_image',
        'inpaint_camera_btn': '#inpaint_canvas',
        'mask_camera_btn': '#inpaint_mask_canvas',
        'enhance_camera_btn': '#enhance_input_image',
        'ip_camera_btn_1': '#ip_image_1',
        'ip_camera_btn_2': '#ip_image_2',
        'ip_camera_btn_3': '#ip_image_3',
        'ip_camera_btn_4': '#ip_image_4'
    };

    // ---- Helpers ----

    function isGenerationIdle() {
        var genBtnWrap = document.getElementById('generate_button');
        var stopBtnWrap = document.getElementById('stop_button');
        var queueDisplay = document.getElementById('prompt_queue_display');

        var genVisible = genBtnWrap && genBtnWrap.offsetParent !== null
                         && !genBtnWrap.classList.contains('hidden');
        var stopHidden = !stopBtnWrap || !stopBtnWrap.offsetParent
                         || stopBtnWrap.classList.contains('hidden');
        var queueEmpty = !queueDisplay || !queueDisplay.offsetParent
                         || !queueDisplay.innerText.includes('Queue');

        return genVisible && stopHidden && queueEmpty;
    }

    function setStatus(text) {
        if (statusElement) statusElement.textContent = text;
    }

    // ---- Create floating preview overlay ----

    function createPreviewOverlay() {
        if (previewContainer) return;

        previewContainer = document.createElement('div');
        previewContainer.id = 'camera_preview_overlay';

        // Close button
        var closeBtn = document.createElement('button');
        closeBtn.className = 'camera-close-btn';
        closeBtn.textContent = '\u2715';
        closeBtn.title = 'Stop live generate';
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            stopLiveGenerate();
        });
        previewContainer.appendChild(closeBtn);

        // Video element
        videoElement = document.createElement('video');
        videoElement.autoplay = true;
        videoElement.muted = true;
        videoElement.playsInline = true;
        videoElement.setAttribute('playsinline', '');
        previewContainer.appendChild(videoElement);

        // Controls row
        var controls = document.createElement('div');
        controls.className = 'camera-controls';

        deviceSelect = document.createElement('select');
        deviceSelect.id = 'camera_device_select_overlay';
        deviceSelect.addEventListener('change', function() {
            localStorage.setItem(PREF_DEVICE_ID, this.value);
            if (mediaStream) {
                stopStream();
                startStream(this.value);
            }
            syncSettingsSelector(this.value);
        });
        controls.appendChild(deviceSelect);
        previewContainer.appendChild(controls);

        // Status text
        statusElement = document.createElement('div');
        statusElement.className = 'camera-status';
        statusElement.textContent = 'Starting...';
        previewContainer.appendChild(statusElement);

        makeDraggable(previewContainer);
        document.body.appendChild(previewContainer);
    }

    function makeDraggable(el) {
        var isDragging = false;
        var offsetX = 0, offsetY = 0;

        el.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'VIDEO') return;
            isDragging = true;
            offsetX = e.clientX - el.getBoundingClientRect().left;
            offsetY = e.clientY - el.getBoundingClientRect().top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            el.style.left = (e.clientX - offsetX) + 'px';
            el.style.top = (e.clientY - offsetY) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', function() {
            isDragging = false;
        });
    }

    // ---- Device enumeration ----

    async function populateDeviceList(selectEl) {
        if (!selectEl) return;
        try {
            var devices = await navigator.mediaDevices.enumerateDevices();
            var videoDevices = devices.filter(function(d) { return d.kind === 'videoinput'; });

            selectEl.innerHTML = '';
            var savedId = localStorage.getItem(PREF_DEVICE_ID) || '';

            for (var i = 0; i < videoDevices.length; i++) {
                var opt = document.createElement('option');
                opt.value = videoDevices[i].deviceId;
                opt.textContent = videoDevices[i].label || ('Camera ' + (i + 1));
                if (videoDevices[i].deviceId === savedId) opt.selected = true;
                selectEl.appendChild(opt);
            }

            if (videoDevices.length === 0) {
                var opt = document.createElement('option');
                opt.textContent = 'No cameras found';
                opt.disabled = true;
                selectEl.appendChild(opt);
            }
        } catch (err) {
            console.error('Failed to enumerate devices:', err);
        }
    }

    function syncSettingsSelector(deviceId) {
        var settingsSelect = document.getElementById('camera_device_select_settings');
        if (settingsSelect && settingsSelect.value !== deviceId) {
            settingsSelect.value = deviceId;
        }
    }

    // ---- Stream management ----

    async function startStream(deviceId) {
        try {
            var constraints = {
                video: deviceId
                    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
                    : { width: { ideal: 1280 }, height: { ideal: 720 } }
            };
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            if (videoElement) {
                videoElement.srcObject = mediaStream;
            }

            mediaStream.getVideoTracks().forEach(function(track) {
                track.addEventListener('ended', function() {
                    if (liveState !== 'IDLE') {
                        console.warn('Camera track ended unexpectedly');
                        stopLiveGenerate();
                    }
                });
            });

            if (deviceSelect) await populateDeviceList(deviceSelect);
            var settingsSelect = document.getElementById('camera_device_select_settings');
            if (settingsSelect) await populateDeviceList(settingsSelect);

            return true;
        } catch (err) {
            console.warn('Camera access failed:', err.message);
            return false;
        }
    }

    function stopStream() {
        if (mediaStream) {
            mediaStream.getTracks().forEach(function(track) { track.stop(); });
            mediaStream = null;
        }
        if (videoElement) {
            videoElement.srcObject = null;
        }
    }

    // ---- Frame capture ----

    function captureFrame() {
        if (!videoElement || videoElement.readyState < 2) return null;

        var canvas = document.createElement('canvas');
        canvas.width = videoElement.videoWidth;
        canvas.height = videoElement.videoHeight;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(videoElement, 0, 0);

        return new Promise(function(resolve) {
            canvas.toBlob(function(blob) {
                if (blob) {
                    resolve(new File([blob], 'camera_frame.png', { type: 'image/png' }));
                } else {
                    resolve(null);
                }
            }, 'image/png');
        });
    }

    // ---- Auto-enable Input Image checkbox ----

    function ensureInputImageEnabled() {
        var labels = document.querySelectorAll('.advanced_check_row label');
        for (var i = 0; i < labels.length; i++) {
            var span = labels[i].querySelector('span');
            if (span && span.textContent.trim() === 'Input Image') {
                var input = labels[i].querySelector('input[type="checkbox"]');
                if (input && !input.checked) {
                    input.click();
                }
                return;
            }
        }
    }

    // ---- Advanced masking helpers ----

    function isAdvancedMaskingEnabled() {
        var labels = document.querySelectorAll('label');
        for (var i = 0; i < labels.length; i++) {
            var span = labels[i].querySelector('span');
            if (span && span.textContent.trim() === 'Enable Advanced Masking Features') {
                var input = labels[i].querySelector('input[type="checkbox"]');
                return input && input.checked;
            }
        }
        return false;
    }

    function clickGenerateMask() {
        var maskBtnWrap = document.getElementById('generate_mask_button');
        if (!maskBtnWrap) {
            console.warn('[LiveGen] generate_mask_button not found');
            return false;
        }
        var maskBtn = maskBtnWrap.querySelector('button') || maskBtnWrap;
        maskBtn.click();
        return true;
    }

    function waitForMaskCompletion(callback) {
        // Poll until the Gradio mask generation call completes.
        // Detect completion by checking that the generate_mask_button is no longer
        // in a loading/progress state.
        var maskPollInterval = setInterval(function() {
            if (liveState === 'IDLE') {
                clearInterval(maskPollInterval);
                return;
            }

            // Gradio wraps queued-call components in a .wrap element with class
            // 'generating' while processing. Check the mask button's ancestor.
            var maskBtnWrap = document.getElementById('generate_mask_button');
            if (!maskBtnWrap) {
                clearInterval(maskPollInterval);
                callback();
                return;
            }

            // Walk up to find any ancestor with .generating class
            var el = maskBtnWrap;
            var isGenerating = false;
            while (el && el !== document.body) {
                if (el.classList.contains('generating')) {
                    isGenerating = true;
                    break;
                }
                el = el.parentElement;
            }

            // Also check for the Gradio progress-bar within the mask output area
            var maskCanvas = document.getElementById('inpaint_mask_canvas');
            if (maskCanvas) {
                var wrap = maskCanvas.closest('.wrap');
                if (wrap && wrap.classList.contains('generating')) {
                    isGenerating = true;
                }
            }

            if (!isGenerating) {
                clearInterval(maskPollInterval);
                setTimeout(callback, 300);
            }
        }, 500);

        // Safety timeout: 60s
        setTimeout(function() {
            clearInterval(maskPollInterval);
            if (liveState === 'WAITING_FOR_MASK') {
                console.warn('[LiveGen] Mask generation timeout, proceeding');
                callback();
            }
        }, 60000);
    }

    // ---- Trigger generation ----

    function triggerGenerate() {
        if (liveState === 'IDLE') return;

        var genBtnWrap = document.getElementById('generate_button');
        var genBtn = genBtnWrap ? genBtnWrap.querySelector('button') || genBtnWrap : null;
        if (genBtn) {
            genBtn.click();
        }

        liveState = 'WAITING_FOR_IDLE';
        setStatus('Generating...');
        updateAllCameraButtonUI();
        startIdlePolling();
    }

    // ---- Capture and generate (multi-target) ----

    async function captureAndGenerate() {
        if (liveState === 'IDLE') return;

        liveState = 'CAPTURING';
        setStatus('Capturing frame...');
        updateAllCameraButtonUI();

        var file = await captureFrame();
        if (!file || liveState === 'IDLE') {
            if (liveState !== 'IDLE') {
                liveState = 'PREVIEWING';
                setStatus('Capture failed, retrying...');
                setTimeout(function() {
                    if (liveState === 'PREVIEWING') startIdlePolling();
                }, 2000);
            }
            return;
        }

        // Inject frame into ALL flagged targets
        var inpaintIsFlagged = false;
        var targetCount = 0;
        cameraTargets.forEach(function(target) {
            if (typeof injectImageIntoGradio === 'function') {
                injectImageIntoGradio(target, file);
                targetCount++;
            }
            if (target === '#inpaint_canvas') {
                inpaintIsFlagged = true;
            }
        });

        setStatus('Injected into ' + targetCount + ' target(s)...');

        // Check if we need to generate a mask first
        if (inpaintIsFlagged && isAdvancedMaskingEnabled()) {
            liveState = 'WAITING_FOR_MASK';
            setStatus('Generating mask...');
            updateAllCameraButtonUI();

            // Wait for Gradio to process the injected image, then click mask generation
            setTimeout(function() {
                if (liveState === 'IDLE') return;
                if (!clickGenerateMask()) {
                    // Mask button not found, proceed without mask
                    triggerGenerate();
                    return;
                }
                waitForMaskCompletion(function() {
                    if (liveState === 'IDLE') return;
                    // Small delay for Gradio to finalize mask output
                    setTimeout(function() {
                        if (liveState === 'IDLE') return;
                        triggerGenerate();
                    }, 300);
                });
            }, 800);
        } else {
            // No mask needed — proceed directly
            setTimeout(function() {
                if (liveState === 'IDLE') return;
                triggerGenerate();
            }, 600);
        }
    }

    // ---- Idle polling ----

    function startIdlePolling() {
        if (pollInterval) clearInterval(pollInterval);

        pollInterval = setInterval(function() {
            if (liveState === 'IDLE') {
                clearInterval(pollInterval);
                pollInterval = null;
                return;
            }

            if (liveState === 'WAITING_FOR_IDLE' && isGenerationIdle()) {
                clearInterval(pollInterval);
                pollInterval = null;

                // Wait a bit to avoid racing with queue auto-continue
                setTimeout(function() {
                    if (liveState === 'WAITING_FOR_IDLE' || liveState === 'PREVIEWING') {
                        captureAndGenerate();
                    }
                }, 1500);
            }
        }, 500);
    }

    // ---- File-picker camera fallback (works on HTTP / Android) ----

    var _cameraFileInput = null;
    function getCameraFileInput() {
        if (!_cameraFileInput) {
            _cameraFileInput = document.createElement('input');
            _cameraFileInput.type = 'file';
            _cameraFileInput.accept = 'image/*';
            _cameraFileInput.setAttribute('capture', 'environment');
            _cameraFileInput.style.display = 'none';
            document.body.appendChild(_cameraFileInput);
        }
        return _cameraFileInput;
    }

    function captureWithFilePicker(targetSelector) {
        ensureInputImageEnabled();

        var fileInput = getCameraFileInput();
        var newInput = fileInput.cloneNode(true);
        fileInput.parentNode.replaceChild(newInput, fileInput);
        _cameraFileInput = newInput;

        newInput.onchange = function() {
            if (newInput.files && newInput.files.length > 0) {
                var file = newInput.files[0];
                if (file.type.startsWith('image/')) {
                    // Inject into ALL flagged targets (not just the one clicked)
                    cameraTargets.forEach(function(target) {
                        if (typeof injectImageIntoGradio === 'function') {
                            injectImageIntoGradio(target, file);
                        }
                    });
                }
            }
            newInput.value = '';
        };

        newInput.click();
    }

    // ---- Camera flag toggle ----

    window.toggleCamera = function(targetSelector) {
        if (cameraTargets.has(targetSelector)) {
            cameraTargets.delete(targetSelector);
        } else {
            cameraTargets.add(targetSelector);
            ensureInputImageEnabled();
        }
        updateAllCameraButtonUI();
    };

    // ---- Live Generate toggle / start / stop ----

    window.toggleLiveGenerate = function() {
        if (liveState !== 'IDLE') {
            stopLiveGenerate();
        } else {
            startLiveGenerate();
        }
    };

    async function startLiveGenerate() {
        if (cameraTargets.size === 0) {
            console.warn('[LiveGen] No camera targets flagged');
            setStatus('Flag at least one camera target first');
            return;
        }

        ensureInputImageEnabled();

        createPreviewOverlay();
        previewContainer.style.display = 'block';
        setStatus('Starting camera...');

        var deviceId = localStorage.getItem(PREF_DEVICE_ID) || '';
        var success = await startStream(deviceId || undefined);
        if (!success) {
            stopLiveGenerate();
            captureWithFilePicker(Array.from(cameraTargets)[0]);
            return;
        }

        liveState = 'PREVIEWING';
        setStatus('Camera active \u2014 waiting to capture...');
        updateAllCameraButtonUI();

        setTimeout(function() {
            if (liveState === 'PREVIEWING') {
                if (isGenerationIdle()) {
                    captureAndGenerate();
                } else {
                    liveState = 'WAITING_FOR_IDLE';
                    setStatus('Waiting for generation to finish...');
                    startIdlePolling();
                }
            }
        }, 1000);
    }

    function stopLiveGenerate() {
        liveState = 'IDLE';
        // Flags persist — don't clear cameraTargets
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        stopStream();
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
        setStatus('');
        updateAllCameraButtonUI();
    }

    // ---- UI updates ----

    function updateAllCameraButtonUI() {
        // Update each camera button's flagged state
        Object.keys(BUTTON_TARGET_MAP).forEach(function(btnId) {
            var wrap = document.getElementById(btnId);
            if (!wrap) return;
            var btn = wrap.querySelector('button') || wrap;
            var target = BUTTON_TARGET_MAP[btnId];
            if (cameraTargets.has(target)) {
                btn.classList.add('camera-flagged');
            } else {
                btn.classList.remove('camera-flagged');
            }
        });

        // Update Live Generate button
        var liveWrap = document.getElementById('live_generate_button');
        if (liveWrap) {
            var liveBtn = liveWrap.querySelector('button') || liveWrap;
            if (liveState !== 'IDLE') {
                liveBtn.classList.add('camera-active');
                liveBtn.textContent = '\u23F9 Stop Live';
            } else {
                liveBtn.classList.remove('camera-active');
                liveBtn.textContent = '\uD83C\uDFA5 Live Generate';
            }
        }
    }

    // ---- Settings tab device selector ----

    function buildSettingsDeviceSelector() {
        var container = document.getElementById('camera_device_settings');
        if (!container) return;

        container.innerHTML = '';

        var label = document.createElement('label');
        label.textContent = 'Camera Device';
        label.style.cssText = 'font-size: 13px; color: var(--body-text-color-subdued, #aaa); display: block; margin-bottom: 4px;';
        container.appendChild(label);

        var select = document.createElement('select');
        select.id = 'camera_device_select_settings';
        select.style.cssText = 'width: 100%; background: var(--background-fill-secondary, #1a1a2e); color: var(--body-text-color, #e0e0e0); border: 1px solid var(--border-color-primary, #444); border-radius: 6px; padding: 6px 8px; font-size: 13px;';
        select.addEventListener('change', function() {
            localStorage.setItem(PREF_DEVICE_ID, this.value);
            var overlaySelect = document.getElementById('camera_device_select_overlay');
            if (overlaySelect && overlaySelect.value !== this.value) {
                overlaySelect.value = this.value;
            }
            if (mediaStream && liveState !== 'IDLE') {
                stopStream();
                startStream(this.value);
            }
        });
        container.appendChild(select);

        populateDeviceList(select);
    }

    // ---- Hooks ----

    onUiLoaded(function() {
        var origCancel = window.cancelGenerateForever;
        window.cancelGenerateForever = function() {
            if (typeof origCancel === 'function') origCancel();
            if (liveState !== 'IDLE') stopLiveGenerate();
        };

        buildSettingsDeviceSelector();
    });

    // Expose for external use (camera_fullscreen.js depends on this API)
    window.cameraCapture = {
        toggleTarget: window.toggleCamera,
        toggleLive: window.toggleLiveGenerate,
        stop: stopLiveGenerate,
        getState: function() { return liveState; },
        getTargets: function() { return Array.from(cameraTargets); }
    };
})();
