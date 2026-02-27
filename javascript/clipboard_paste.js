// Clipboard paste support for image inputs
// Provides a pasteImageFromClipboard(targetSelector) function
// that reads an image from the clipboard and injects it into a Gradio Image component.
//
// Three strategies (tried in order):
// 1. Clipboard API (navigator.clipboard.read) — works on desktop Chrome/Edge on localhost/HTTPS
// 2. Paste event listener — prompts user to press Ctrl+V, captures the paste event
// 3. File picker fallback — opens a file picker dialog (best for mobile)

function injectImageIntoGradio(targetSelector, file) {
    var container = document.querySelector(targetSelector);
    if (!container) {
        console.log('Target element not found: ' + targetSelector);
        return false;
    }

    // Strategy A: Find the file input and set files via DataTransfer
    var fileInput = container.querySelector('input[type="file"]');
    if (fileInput) {
        var dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // Strategy B: Simulate drag-and-drop onto the upload container
    var dropZone = container.querySelector('.upload-container, [data-testid="image"]');
    if (dropZone) {
        var dt = new DataTransfer();
        dt.items.add(file);
        dropZone.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt
        }));
        return true;
    }

    console.log('Could not find upload mechanism in: ' + targetSelector);
    return false;
}

// Hidden file input for fallback (reused across calls)
var _fallbackFileInput = null;
function getFallbackFileInput() {
    if (!_fallbackFileInput) {
        _fallbackFileInput = document.createElement('input');
        _fallbackFileInput.type = 'file';
        _fallbackFileInput.accept = 'image/*';
        _fallbackFileInput.style.display = 'none';
        document.body.appendChild(_fallbackFileInput);
    }
    return _fallbackFileInput;
}

// Check if Clipboard API is likely to work
function isClipboardApiAvailable() {
    return !!(navigator.clipboard && typeof navigator.clipboard.read === 'function');
}

async function pasteImageFromClipboard(targetSelector) {
    // Strategy 1: Try Clipboard API (works on desktop Chrome/Edge over localhost/HTTPS)
    if (isClipboardApiAvailable()) {
        try {
            var clipboardItems = await navigator.clipboard.read();
            var imageBlob = null;

            for (var item of clipboardItems) {
                for (var type of item.types) {
                    if (type.startsWith('image/')) {
                        imageBlob = await item.getType(type);
                        break;
                    }
                }
                if (imageBlob) break;
            }

            if (imageBlob) {
                var file = new File([imageBlob], 'pasted_image.png', { type: imageBlob.type });
                if (injectImageIntoGradio(targetSelector, file)) return;
            } else {
                console.log('No image found in clipboard, falling back to file picker');
            }
        } catch (err) {
            console.log('Clipboard API failed (' + err.message + '), falling back to file picker');
        }
    }

    // Strategy 2: File picker fallback (works everywhere, best for mobile)
    // Opens the system file picker / camera roll
    var fileInput = getFallbackFileInput();

    // Remove previous handler and set up new one
    var newInput = fileInput.cloneNode(true);
    fileInput.parentNode.replaceChild(newInput, fileInput);
    _fallbackFileInput = newInput;

    newInput.onchange = function() {
        if (newInput.files && newInput.files.length > 0) {
            var file = newInput.files[0];
            if (file.type.startsWith('image/')) {
                injectImageIntoGradio(targetSelector, file);
            }
        }
        // Reset so the same file can be selected again
        newInput.value = '';
    };

    newInput.click();
}

// Global paste event listener: allows Ctrl+V to paste images into
// whichever image input tab is currently visible
document.addEventListener('paste', function(e) {
    if (!e.clipboardData || !e.clipboardData.items) return;

    // Don't interfere if user is typing in a text input or textarea
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        // Allow paste in text fields (prompts, etc.)
        return;
    }

    var imageFile = null;
    for (var i = 0; i < e.clipboardData.items.length; i++) {
        var item = e.clipboardData.items[i];
        if (item.type.startsWith('image/')) {
            imageFile = item.getAsFile();
            break;
        }
    }

    if (!imageFile) return;

    // Find the currently visible image upload target
    // Check each tab in order of likelihood
    var targets = [
        '#inpaint_canvas',
        '#uov_input_image',
        '#ip_tab',
        '#describe_input_image',
        '#enhance_input_image'
    ];

    for (var t = 0; t < targets.length; t++) {
        var container = document.querySelector(targets[t]);
        if (container && container.offsetParent !== null) {
            // This container is visible
            e.preventDefault();
            injectImageIntoGradio(targets[t], imageFile);
            return;
        }
    }
});
