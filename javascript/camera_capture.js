// Camera Capture: continuous webcam-to-generation loop
// Toggle camera on → shows live preview → captures frame when idle → triggers generation → repeats
(function() {
    'use strict';

    // ---- State ----
    var cameraState = 'IDLE'; // IDLE | PREVIEWING | CAPTURING | WAITING_FOR_IDLE
    var mediaStream = null;
    var activeTarget = null;  // e.g. '#uov_input_image'
    var pollInterval = null;
    var previewContainer = null;
    var videoElement = null;
    var statusElement = null;
    var deviceSelect = null;

    // ---- localStorage keys ----
    var PREF_DEVICE_ID = 'fjord_camera_device_id';

    // ---- Helpers ----

    function isSecureContext() {
        // getUserMedia requires HTTPS or localhost
        return window.isSecureContext ||
               location.protocol === 'https:' ||
               location.hostname === 'localhost' ||
               location.hostname === '127.0.0.1';
    }

    function isGenerationIdle() {
        var genBtnWrap = document.getElementById('generate_button');
        var stopBtnWrap = document.getElementById('stop_button');
        var queueDisplay = document.getElementById('prompt_queue_display');

        // generate_button wrapper must be visible
        var genVisible = genBtnWrap && genBtnWrap.offsetParent !== null
                         && !genBtnWrap.classList.contains('hidden');
        // stop_button must be hidden
        var stopHidden = !stopBtnWrap || !stopBtnWrap.offsetParent
                         || stopBtnWrap.classList.contains('hidden');
        // queue must be empty
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
        closeBtn.title = 'Stop camera';
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            stopCamera();
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
            // Restart stream with new device
            if (mediaStream) {
                stopStream();
                startStream(this.value);
            }
            // Sync settings tab selector
            syncSettingsSelector(this.value);
        });
        controls.appendChild(deviceSelect);
        previewContainer.appendChild(controls);

        // Status text
        statusElement = document.createElement('div');
        statusElement.className = 'camera-status';
        statusElement.textContent = 'Starting...';
        previewContainer.appendChild(statusElement);

        // Make draggable
        makeDraggable(previewContainer);

        document.body.appendChild(previewContainer);
    }

    function makeDraggable(el) {
        var isDragging = false;
        var offsetX = 0, offsetY = 0;

        el.addEventListener('mousedown', function(e) {
            // Don't drag from controls
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

            // Listen for track ending (camera disconnected)
            mediaStream.getVideoTracks().forEach(function(track) {
                track.addEventListener('ended', function() {
                    if (cameraState !== 'IDLE') {
                        console.warn('Camera track ended unexpectedly');
                        stopCamera();
                    }
                });
            });

            // Re-populate device lists after permission granted (labels now available)
            if (deviceSelect) await populateDeviceList(deviceSelect);
            var settingsSelect = document.getElementById('camera_device_select_settings');
            if (settingsSelect) await populateDeviceList(settingsSelect);

            return true;
        } catch (err) {
            console.error('Camera access failed:', err);
            alert('Could not access camera: ' + err.message);
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

    // ---- Capture and generate ----

    async function captureAndGenerate() {
        if (cameraState === 'IDLE') return;

        cameraState = 'CAPTURING';
        setStatus('Capturing frame...');
        updateButtonUI();

        var file = await captureFrame();
        if (!file || cameraState === 'IDLE') {
            // Camera was stopped or capture failed
            if (cameraState !== 'IDLE') {
                cameraState = 'PREVIEWING';
                setStatus('Capture failed, retrying...');
                setTimeout(function() {
                    if (cameraState === 'PREVIEWING') startIdlePolling();
                }, 2000);
            }
            return;
        }

        // Inject frame into the target Gradio image component
        if (typeof injectImageIntoGradio === 'function') {
            injectImageIntoGradio(activeTarget, file);
        } else {
            console.error('injectImageIntoGradio not available');
            stopCamera();
            return;
        }

        setStatus('Injected frame, starting generation...');

        // Wait for Gradio to process the image, then click generate
        setTimeout(function() {
            if (cameraState === 'IDLE') return;

            var genBtnWrap = document.getElementById('generate_button');
            var genBtn = genBtnWrap ? genBtnWrap.querySelector('button') || genBtnWrap : null;
            if (genBtn) {
                genBtn.click();
            }

            cameraState = 'WAITING_FOR_IDLE';
            setStatus('Generating...');
            updateButtonUI();
            startIdlePolling();
        }, 600);
    }

    // ---- Idle polling ----

    function startIdlePolling() {
        if (pollInterval) clearInterval(pollInterval);

        pollInterval = setInterval(function() {
            if (cameraState === 'IDLE') {
                clearInterval(pollInterval);
                pollInterval = null;
                return;
            }

            if (cameraState === 'WAITING_FOR_IDLE' && isGenerationIdle()) {
                clearInterval(pollInterval);
                pollInterval = null;

                // Wait a bit to avoid racing with queue auto-continue (1s delay)
                setTimeout(function() {
                    if (cameraState === 'WAITING_FOR_IDLE' || cameraState === 'PREVIEWING') {
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
            _cameraFileInput.setAttribute('capture', 'environment'); // opens rear camera on mobile
            _cameraFileInput.style.display = 'none';
            document.body.appendChild(_cameraFileInput);
        }
        return _cameraFileInput;
    }

    function captureWithFilePicker(targetSelector) {
        // Auto-enable Input Image checkbox
        ensureInputImageEnabled();

        var fileInput = getCameraFileInput();
        // Clone to reset any previous handler
        var newInput = fileInput.cloneNode(true);
        fileInput.parentNode.replaceChild(newInput, fileInput);
        _cameraFileInput = newInput;

        newInput.onchange = function() {
            if (newInput.files && newInput.files.length > 0) {
                var file = newInput.files[0];
                if (file.type.startsWith('image/')) {
                    if (typeof injectImageIntoGradio === 'function') {
                        injectImageIntoGradio(targetSelector, file);
                    }
                }
            }
            newInput.value = '';
        };

        newInput.click();
    }

    // ---- Toggle / Start / Stop ----

    window.toggleCamera = function(targetSelector) {
        // On insecure contexts (plain HTTP), fall back to file picker capture
        if (!isSecureContext()) {
            captureWithFilePicker(targetSelector);
            return;
        }

        if (cameraState !== 'IDLE') {
            if (activeTarget === targetSelector) {
                // Same target — toggle off
                stopCamera();
            } else {
                // Different target — switch
                stopCamera();
                setTimeout(function() { startCamera(targetSelector); }, 100);
            }
        } else {
            startCamera(targetSelector);
        }
    };

    async function startCamera(targetSelector) {
        activeTarget = targetSelector;

        // Auto-enable Input Image checkbox
        ensureInputImageEnabled();

        // Create overlay if needed
        createPreviewOverlay();
        previewContainer.style.display = 'block';
        setStatus('Starting camera...');

        // Start stream
        var deviceId = localStorage.getItem(PREF_DEVICE_ID) || '';
        var success = await startStream(deviceId || undefined);
        if (!success) {
            stopCamera();
            return;
        }

        cameraState = 'PREVIEWING';
        setStatus('Camera active — waiting to capture...');
        updateButtonUI();

        // Start first capture check after short delay
        setTimeout(function() {
            if (cameraState === 'PREVIEWING') {
                if (isGenerationIdle()) {
                    captureAndGenerate();
                } else {
                    cameraState = 'WAITING_FOR_IDLE';
                    setStatus('Waiting for generation to finish...');
                    startIdlePolling();
                }
            }
        }, 1000);
    }

    function stopCamera() {
        cameraState = 'IDLE';
        activeTarget = null;
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        stopStream();
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
        setStatus('');
        updateButtonUI();
    }

    // ---- UI updates ----

    function updateButtonUI() {
        var btnIds = ['uov_camera_btn', 'enhance_camera_btn'];
        btnIds.forEach(function(id) {
            var wrap = document.getElementById(id);
            if (!wrap) return;
            var btn = wrap.querySelector('button') || wrap;
            if (cameraState !== 'IDLE') {
                btn.classList.add('camera-active');
                btn.textContent = '\u23F9 Stop Camera';
            } else {
                btn.classList.remove('camera-active');
                btn.textContent = '\uD83D\uDCF7 Camera';
            }
        });
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
            // Sync overlay selector if open
            var overlaySelect = document.getElementById('camera_device_select_overlay');
            if (overlaySelect && overlaySelect.value !== this.value) {
                overlaySelect.value = this.value;
            }
            // Restart stream if active
            if (mediaStream && cameraState !== 'IDLE') {
                stopStream();
                startStream(this.value);
            }
        });
        container.appendChild(select);

        populateDeviceList(select);
    }

    // ---- Hooks ----

    onUiLoaded(function() {
        // Patch cancelGenerateForever to also stop camera
        var origCancel = window.cancelGenerateForever;
        window.cancelGenerateForever = function() {
            if (typeof origCancel === 'function') origCancel();
            if (cameraState !== 'IDLE') stopCamera();
        };

        // Build settings device selector
        buildSettingsDeviceSelector();
    });

    // Expose for external use
    window.cameraCapture = {
        toggle: window.toggleCamera,
        stop: stopCamera,
        getState: function() { return cameraState; }
    };
})();
