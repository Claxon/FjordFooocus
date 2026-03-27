/**
 * Regenerate handler — detects ?regenerate=PATH in URL and loads the image
 * with its metadata into the main FjordFooocus interface.
 *
 * Flow:
 * 1. Detect ?regenerate=PATH query param on page load
 * 2. Load image into metadata_input_image (triggers read_info_from_image)
 * 3. Click metadata_import_button to apply all settings via native Gradio flow
 * 4. Load image into all Input Image slots (uov, inpaint, image prompts)
 * 5. Keep input_image_checkbox OFF
 */

(function () {
    'use strict';

    const GALLERY_PORT = 7867;

    function getRegeneratePath() {
        const params = new URLSearchParams(window.location.search);
        return params.get('regenerate');
    }

    function galleryApiUrl(path) {
        return `${window.location.protocol}//${window.location.hostname}:${GALLERY_PORT}${path}`;
    }

    async function fetchImageAsFile(url, filename) {
        const resp = await fetch(url, { credentials: 'include' });
        const blob = await resp.blob();
        return new File([blob], filename, { type: blob.type });
    }

    function waitFor(conditionFn, timeoutMs, pollMs) {
        return new Promise((resolve) => {
            const start = Date.now();
            pollMs = pollMs || 100;
            timeoutMs = timeoutMs || 5000;
            (function check() {
                const result = conditionFn();
                if (result) return resolve(result);
                if (Date.now() - start > timeoutMs) return resolve(null);
                setTimeout(check, pollMs);
            })();
        });
    }

    /**
     * Inject a File into a Gradio Image component via its hidden file input.
     * Uses the global injectImageIntoGradio from clipboard_paste.js if available.
     */
    function injectFile(selector, file) {
        if (typeof injectImageIntoGradio === 'function') {
            return injectImageIntoGradio(selector, file);
        }
        const container = document.querySelector(selector);
        if (!container) return false;
        const fi = container.querySelector('input[type="file"]');
        if (!fi) return false;
        const dt = new DataTransfer();
        dt.items.add(file);
        fi.files = dt.files;
        fi.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    async function handleRegenerate(imagePath) {
        console.log('[Regenerate] Loading image:', imagePath);

        // Clean the URL so it doesn't re-trigger on refresh
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, '', cleanUrl);

        const imageUrl = galleryApiUrl(`/api/image?path=${encodeURIComponent(imagePath)}`);
        const filename = imagePath.split('/').pop() || 'regenerate.png';

        // Step 1: Load image into metadata_input_image and click import button
        // This uses the native Gradio metadata import flow which properly handles
        // model name resolution, extension fixup, and all settings.
        try {
            const metaFile = await fetchImageAsFile(imageUrl, filename);
            console.log('[Regenerate] Loading image into metadata import...');

            if (injectFile('#metadata_input_image', metaFile)) {
                console.log('[Regenerate] Image loaded into metadata input');

                // Wait for image to be processed by Gradio
                await new Promise(r => setTimeout(r, 1000));

                // Click the metadata import button
                const importBtn = await waitFor(() => {
                    const btn = document.querySelector('#metadata_import_button');
                    if (btn && btn.offsetHeight > 0) return btn;
                    return null;
                }, 3000, 150);

                if (importBtn) {
                    importBtn.click();
                    console.log('[Regenerate] Clicked metadata import button');
                    // Wait for all downstream Gradio updates to complete
                    await new Promise(r => setTimeout(r, 2000));
                    console.log('[Regenerate] Parameters loaded via native import');
                } else {
                    console.warn('[Regenerate] metadata_import_button not found, trying manual approach');
                    await manualMetadataLoad(imagePath);
                }
            } else {
                console.warn('[Regenerate] Could not inject into metadata_input_image, trying manual approach');
                await manualMetadataLoad(imagePath);
            }
        } catch (e) {
            console.warn('[Regenerate] Native metadata import failed:', e);
            await manualMetadataLoad(imagePath);
        }

        // Step 2: Load image into all Input Image slots
        try {
            console.log('[Regenerate] Loading image into input slots');

            // Load into each input slot with a fresh File each time
            const slots = ['#uov_input_image', '#ip_image_1', '#inpaint_canvas', '#enhance_input_image'];
            for (const slot of slots) {
                const f = await fetchImageAsFile(imageUrl, filename);
                if (injectFile(slot, f)) {
                    console.log(`[Regenerate] Loaded into ${slot}`);
                }
            }
        } catch (e) {
            console.warn('[Regenerate] Could not load image into inputs:', e);
        }

        // Step 3: Ensure input_image_checkbox stays OFF
        await new Promise(r => setTimeout(r, 500));
        try {
            const checkboxes = document.querySelectorAll('.min_check input[type="checkbox"]');
            for (const cb of checkboxes) {
                const label = cb.closest('.min_check');
                if (label && label.textContent.includes('Input Image') && cb.checked) {
                    cb.click();
                    console.log('[Regenerate] Unchecked Input Image checkbox');
                    break;
                }
            }
        } catch (e) {
            // Not critical
        }

        console.log('[Regenerate] Done — image and metadata loaded');
    }

    /**
     * Fallback: fetch metadata from gallery API and paste as JSON into prompt.
     * Used only if the native metadata import approach fails.
     */
    async function manualMetadataLoad(imagePath) {
        try {
            const resp = await fetch(galleryApiUrl(`/api/metadata?path=${encodeURIComponent(imagePath)}`), { credentials: 'include' });
            if (!resp.ok) return;
            const data = await resp.json();
            const metadata = data.metadata;
            if (!metadata || typeof metadata !== 'object' || Object.keys(metadata).length === 0) return;

            const metaJson = JSON.stringify(metadata);
            console.log('[Regenerate] Fallback: setting metadata JSON in prompt');

            const promptContainer = document.querySelector('#positive_prompt');
            if (!promptContainer) return;
            const textarea = promptContainer.querySelector('textarea');
            if (!textarea) return;

            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, metaJson);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));

            const loadBtn = await waitFor(() => {
                const btn = document.querySelector('#load_parameter_button');
                if (btn && btn.style.display !== 'none' && btn.offsetHeight > 0) return btn;
                if (btn) {
                    const wrapper = btn.closest('.wrap');
                    if (wrapper && wrapper.style.display !== 'none') return btn;
                }
                return null;
            }, 3000, 150);

            if (loadBtn) {
                loadBtn.click();
                await new Promise(r => setTimeout(r, 1500));
                console.log('[Regenerate] Fallback: parameters loaded');
            }
        } catch (e) {
            console.warn('[Regenerate] Fallback metadata load failed:', e);
        }
    }

    // Wait for UI to load, then check for regenerate param
    if (typeof onUiLoaded === 'function') {
        onUiLoaded(function () {
            const path = getRegeneratePath();
            if (path) {
                // Delay to ensure all components are fully initialized
                setTimeout(() => handleRegenerate(path), 2000);
            }
        });
    } else {
        window.addEventListener('load', function () {
            const path = getRegeneratePath();
            if (path) {
                setTimeout(() => handleRegenerate(path), 3000);
            }
        });
    }
})();
