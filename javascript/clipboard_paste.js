// Clipboard paste support for image inputs
// Provides a pasteImageFromClipboard(targetSelector) function
// that reads an image from the clipboard and injects it into a Gradio Image component.

async function pasteImageFromClipboard(targetSelector) {
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

        if (!imageBlob) {
            console.log('No image found in clipboard');
            return;
        }

        var file = new File([imageBlob], 'pasted_image.png', { type: imageBlob.type });
        var container = document.querySelector(targetSelector);
        if (!container) {
            console.log('Target element not found: ' + targetSelector);
            return;
        }

        // Strategy 1: Find the file input and set files
        var fileInput = container.querySelector('input[type="file"]');
        if (fileInput) {
            var dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            fileInput.files = dataTransfer.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        // Strategy 2: Simulate drag-and-drop
        var dropZone = container.querySelector('.upload-container, [data-testid="image"]');
        if (dropZone) {
            var dt = new DataTransfer();
            dt.items.add(file);
            dropZone.dispatchEvent(new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: dt
            }));
            return;
        }

        console.log('Could not find upload mechanism in: ' + targetSelector);
    } catch (err) {
        console.error('Clipboard paste failed:', err);
        // Fallback message for non-secure contexts
        if (err.name === 'NotAllowedError') {
            console.log('Clipboard access denied. Ensure the page is served over HTTPS or localhost.');
        }
    }
}
