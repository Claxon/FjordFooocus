// From A1111

function closeModal() {
    gradioApp().getElementById("lightboxModal").style.display = "none";
}

function showModal(event) {
    const source = event.target || event.srcElement;
    const modalImage = gradioApp().getElementById("modalImage");
    const lb = gradioApp().getElementById("lightboxModal");
    modalImage.src = source.src;
    if (modalImage.style.display === 'none') {
        lb.style.setProperty('background-image', 'url(' + source.src + ')');
    }
    lb.style.display = "flex";
    lb.focus();
    updateStarredUI();

    event.stopPropagation();
}

function negmod(n, m) {
    return ((n % m) + m) % m;
}

function updateOnBackgroundChange() {
    const modalImage = gradioApp().getElementById("modalImage");
    if (modalImage && modalImage.offsetParent) {
        let currentButton = selected_gallery_button();

        if (currentButton?.children?.length > 0 && modalImage.src != currentButton.children[0].src) {
            modalImage.src = currentButton.children[0].src;
            if (modalImage.style.display === 'none') {
                const modal = gradioApp().getElementById("lightboxModal");
                modal.style.setProperty('background-image', `url(${modalImage.src})`);
            }
        }
    }
}

// Get all visible gallery thumbnail buttons from both grid and thumbnail views,
// across both the progress gallery and the final gallery
function all_gallery_buttons() {
    var allGalleryButtons = gradioApp().querySelectorAll(
        '.image_gallery .thumbnails > .thumbnail-item.thumbnail-small, ' +
        '.image_gallery .grid-container > .thumbnail-item, ' +
        '.image_gallery .grid-container .batch-group-grid > .thumbnail-item'
    );
    var visibleGalleryButtons = [];
    allGalleryButtons.forEach(function(elem) {
        if (elem.parentElement.offsetParent) {
            visibleGalleryButtons.push(elem);
        }
    });
    return visibleGalleryButtons;
}

function selected_gallery_button() {
    return all_gallery_buttons().find(elem => elem.classList.contains('selected')) ?? null;
}

function selected_gallery_index() {
    return all_gallery_buttons().findIndex(elem => elem.classList.contains('selected'));
}

function modalImageSwitch(offset) {
    var galleryButtons = all_gallery_buttons();

    if (galleryButtons.length > 1) {
        var currentButton = selected_gallery_button();

        var result = -1;
        galleryButtons.forEach(function(v, i) {
            if (v == currentButton) {
                result = i;
            }
        });

        if (result != -1) {
            var nextButton = galleryButtons[negmod((result + offset), galleryButtons.length)];
            nextButton.click();
            const modalImage = gradioApp().getElementById("modalImage");
            const modal = gradioApp().getElementById("lightboxModal");
            modalImage.src = nextButton.children[0].src;
            if (modalImage.style.display === 'none') {
                modal.style.setProperty('background-image', `url(${modalImage.src})`);
            }
            setTimeout(function() {
                modal.focus();
            }, 10);
            updateStarredUI();
        }
    }
}

function saveImage() {

}

// Send one or more image URLs to Python for deletion (newline-separated)
function sendDeleteRequest(urls) {
    if (!urls || urls.length === 0) return;
    var deleteInput = document.querySelector('#delete_image_request textarea');
    if (deleteInput) {
        deleteInput.value = urls.join('\n');
        var e = new Event("input", { bubbles: true });
        Object.defineProperty(e, "target", { value: deleteInput });
        deleteInput.dispatchEvent(e);
    }
}

// Remove gallery thumbnails whose image src matches any of the given URLs
function removeFromGalleryDOM(urls) {
    var urlSet = new Set(urls);
    var buttons = all_gallery_buttons();
    buttons.forEach(function(btn) {
        var img = btn.querySelector('img');
        if (img && urlSet.has(img.src)) {
            btn.remove();
        }
    });
}

function deleteCurrentImage() {
    var modalImage = gradioApp().getElementById("modalImage");
    if (!modalImage || !modalImage.src) return;

    var srcToDelete = modalImage.src;

    var galleryButtons = all_gallery_buttons();
    if (galleryButtons.length > 1) {
        modalNextImage(new Event('click'));
    } else {
        closeModal();
    }

    sendDeleteRequest([srcToDelete]);
    removeFromGalleryDOM([srcToDelete]);
}

function modalSaveImage(event) {
    event.stopPropagation();
}

function modalNextImage(event) {
    modalImageSwitch(1);
    event.stopPropagation();
}

function modalPrevImage(event) {
    modalImageSwitch(-1);
    event.stopPropagation();
}

function modalKeyHandler(event) {
    switch (event.key) {
    case "s":
        saveImage();
        break;
    case "f":
    case "F":
        var starBtn = document.getElementById('modalStar');
        if (starBtn) starBtn.click();
        break;
    case "Delete":
        deleteCurrentImage();
        break;
    case "ArrowLeft":
        modalPrevImage(event);
        break;
    case "ArrowRight":
        modalNextImage(event);
        break;
    case "Escape":
        closeModal();
        break;
    }
}

// ===== Multi-select gallery checkboxes =====

var gallerySelectedImages = new Set();
var lastClickedCheckboxIndex = -1;

function getImageSrcFromButton(button) {
    var img = button.querySelector('img');
    return img ? img.src : null;
}

function updateDeleteSelectedButton() {
    var btns = document.querySelectorAll('.delete-selected-btn');
    var count = gallerySelectedImages.size;
    btns.forEach(function(btn) {
        if (count > 0) {
            btn.style.display = 'inline-flex';
            btn.textContent = '\u{1F5D1} Delete Selected (' + count + ')';
        } else {
            btn.style.display = 'none';
        }
    });
}

function toggleGalleryCheckbox(button, checkbox) {
    var src = getImageSrcFromButton(button);
    if (!src) return;

    if (checkbox.checked) {
        gallerySelectedImages.add(src);
        button.classList.add('gallery-checked');
    } else {
        gallerySelectedImages.delete(src);
        button.classList.remove('gallery-checked');
    }
    updateDeleteSelectedButton();
}

function addCheckboxToGalleryButton(button) {
    if (button.querySelector('.gallery-select-checkbox')) return;

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'gallery-select-checkbox';
    checkbox.title = 'Select for deletion';

    // Restore checked state if this image was previously selected
    var src = getImageSrcFromButton(button);
    if (src && gallerySelectedImages.has(src)) {
        checkbox.checked = true;
        button.classList.add('gallery-checked');
    }

    checkbox.addEventListener('click', function(e) {
        e.stopPropagation();

        var allButtons = all_gallery_buttons();
        var currentIndex = allButtons.indexOf(button);

        if (e.shiftKey && lastClickedCheckboxIndex !== -1 && currentIndex !== -1 && currentIndex !== lastClickedCheckboxIndex) {
            var start = Math.min(lastClickedCheckboxIndex, currentIndex);
            var end = Math.max(lastClickedCheckboxIndex, currentIndex);
            var shouldCheck = checkbox.checked;

            for (var i = start; i <= end; i++) {
                var btn = allButtons[i];
                var cb = btn.querySelector('.gallery-select-checkbox');
                if (cb && cb.checked !== shouldCheck) {
                    cb.checked = shouldCheck;
                    toggleGalleryCheckbox(btn, cb);
                }
            }
        } else {
            toggleGalleryCheckbox(button, checkbox);
        }

        if (currentIndex !== -1) {
            lastClickedCheckboxIndex = currentIndex;
        }
    });
    checkbox.addEventListener('mousedown', function(e) {
        e.stopPropagation();
    });
    button.style.position = 'relative';
    button.appendChild(checkbox);
}

// ===== Star (approve) icons on gallery thumbnails =====

var galleryStarredImages = new Set();

function updateStarredUI() {
    // Update lightbox star button if modal is open
    var modalStar = document.getElementById('modalStar');
    if (modalStar) {
        var modalImage = document.getElementById('modalImage');
        if (modalImage && modalImage.src && galleryStarredImages.has(modalImage.src)) {
            modalStar.innerHTML = '&#9733;';
            modalStar.classList.add('starred');
        } else {
            modalStar.innerHTML = '&#9734;';
            modalStar.classList.remove('starred');
        }
    }
}

// Send a single image URL to Python for immediate approval
function sendApproveRequest(url) {
    var el = document.querySelector('#approve_images_request textarea') ||
             document.querySelector('#approve_images_request input');
    if (el) {
        el.value = url;
        var e = new Event('input', { bubbles: true });
        Object.defineProperty(e, 'target', { value: el });
        el.dispatchEvent(e);
    }
}

// Send a single image URL to Python for unapproval (remove from approved)
function sendUnapproveRequest(url) {
    var el = document.querySelector('#unapprove_images_request textarea') ||
             document.querySelector('#unapprove_images_request input');
    if (el) {
        el.value = url;
        var e = new Event('input', { bubbles: true });
        Object.defineProperty(e, 'target', { value: el });
        el.dispatchEvent(e);
    }
}

function addStarToGalleryButton(button) {
    if (button.querySelector('.gallery-star')) return;

    var star = document.createElement('span');
    star.className = 'gallery-star';
    star.title = 'Star for approval';

    var src = getImageSrcFromButton(button);
    if (src && galleryStarredImages.has(src)) {
        star.textContent = '\u2605';
        star.classList.add('starred');
    } else {
        star.textContent = '\u2606';
    }

    star.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        var imgSrc = getImageSrcFromButton(button);
        if (!imgSrc) return;
        if (galleryStarredImages.has(imgSrc)) {
            galleryStarredImages.delete(imgSrc);
            star.textContent = '\u2606';
            star.classList.remove('starred');
            sendUnapproveRequest(imgSrc);
        } else {
            galleryStarredImages.add(imgSrc);
            star.textContent = '\u2605';
            star.classList.add('starred');
            sendApproveRequest(imgSrc);
        }
        updateStarredUI();
    });
    star.addEventListener('mousedown', function(e) {
        e.stopPropagation();
    });
    button.appendChild(star);
}

function deleteSelectedImages() {
    if (gallerySelectedImages.size === 0) return;
    var urls = Array.from(gallerySelectedImages);
    sendDeleteRequest(urls);
    removeFromGalleryDOM(urls);
    // Also remove from starred if present
    urls.forEach(function(u) { galleryStarredImages.delete(u); });
    gallerySelectedImages.clear();
    lastClickedCheckboxIndex = -1;
    updateDeleteSelectedButton();
    updateStarredUI();
}

// Create a "Delete Selected" button for a gallery element
function createDeleteSelectedButton() {
    var btn = document.createElement('button');
    btn.className = 'delete-selected-btn';
    btn.textContent = '\u{1F5D1} Delete Selected';
    btn.style.display = 'none';
    btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        deleteSelectedImages();
    });
    return btn;
}

function setupImageForLightbox(e) {
    if (e.dataset.modded) {
        return;
    }

    e.dataset.modded = true;
    e.style.cursor = 'pointer';
    e.style.userSelect = 'none';

    var isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

    // For Firefox, listening on click first switched to next image then shows the lightbox.
    // If you know how to fix this without switching to mousedown event, please.
    // For other browsers the event is click to make it possiblr to drag picture.
    var event = isFirefox ? 'mousedown' : 'click';

    e.addEventListener(event, function(evt) {
        if (evt.button == 1) {
            open(evt.target.src);
            evt.preventDefault();
            return;
        }
        if (evt.button != 0) return;

        modalZoomSet(gradioApp().getElementById('modalImage'), true);
        evt.preventDefault();
        showModal(evt);
    }, true);

}

function modalZoomSet(modalImage, enable) {
    if (modalImage) modalImage.classList.toggle('modalImageFullscreen', !!enable);
}

function modalZoomToggle(event) {
    var modalImage = gradioApp().getElementById("modalImage");
    modalZoomSet(modalImage, !modalImage.classList.contains('modalImageFullscreen'));
    event.stopPropagation();
}

function modalTileImageToggle(event) {
    const modalImage = gradioApp().getElementById("modalImage");
    const modal = gradioApp().getElementById("lightboxModal");
    const isTiling = modalImage.style.display === 'none';
    if (isTiling) {
        modalImage.style.display = 'block';
        modal.style.setProperty('background-image', 'none');
    } else {
        modalImage.style.display = 'none';
        modal.style.setProperty('background-image', `url(${modalImage.src})`);
    }

    event.stopPropagation();
}

// Ensure a "Delete Selected" button exists after each gallery element
function ensureDeleteButtonForGallery(galleryElem) {
    if (!galleryElem) return;
    var nextSibling = galleryElem.nextElementSibling;
    if (nextSibling && nextSibling.classList.contains('delete-selected-btn')) return;
    var btn = createDeleteSelectedButton();
    galleryElem.parentElement.insertBefore(btn, galleryElem.nextSibling);
}

onAfterUiUpdate(function() {
    var fullImg_preview = gradioApp().querySelectorAll('.image_gallery > div > img');
    if (fullImg_preview != null) {
        fullImg_preview.forEach(setupImageForLightbox);
    }
    updateOnBackgroundChange();

    // Add star overlay to the large selected-image preview
    fullImg_preview.forEach(function(img) {
        var container = img.parentElement;
        if (!container || container.querySelector('.preview-star')) return;
        container.style.position = 'relative';
        var star = document.createElement('span');
        star.className = 'preview-star';
        star.title = 'Star for approval';
        star.textContent = '\u2606';
        star.addEventListener('click', function(e) {
            e.stopPropagation();
            e.preventDefault();
            var src = img.src;
            if (!src) return;
            if (galleryStarredImages.has(src)) {
                galleryStarredImages.delete(src);
                star.textContent = '\u2606';
                star.classList.remove('starred');
                sendUnapproveRequest(src);
            } else {
                galleryStarredImages.add(src);
                star.textContent = '\u2605';
                star.classList.add('starred');
                sendApproveRequest(src);
            }
            // Sync gallery thumbnail star
            all_gallery_buttons().forEach(function(btn) {
                var bimg = btn.querySelector('img');
                if (bimg && bimg.src === src) {
                    var s = btn.querySelector('.gallery-star');
                    if (s) {
                        s.textContent = galleryStarredImages.has(src) ? '\u2605' : '\u2606';
                        s.classList.toggle('starred', galleryStarredImages.has(src));
                    }
                }
            });
            updateStarredUI();
        });
        star.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        container.appendChild(star);
    });

    // Update preview star state when selected image changes
    fullImg_preview.forEach(function(img) {
        var star = img.parentElement && img.parentElement.querySelector('.preview-star');
        if (star && img.src) {
            if (galleryStarredImages.has(img.src)) {
                star.textContent = '\u2605';
                star.classList.add('starred');
            } else {
                star.textContent = '\u2606';
                star.classList.remove('starred');
            }
        }
    });

    // Add checkboxes and star icons only to grid (large) thumbnails, not thumbnail-small
    var galleryButtons = all_gallery_buttons();
    galleryButtons.forEach(function(btn) {
        if (!btn.classList.contains('thumbnail-small')) {
            addCheckboxToGalleryButton(btn);
            addStarToGalleryButton(btn);
        }
    });

    // Clean up selections and stars for images no longer in any gallery
    var currentSrcs = new Set();
    galleryButtons.forEach(function(btn) {
        var src = getImageSrcFromButton(btn);
        if (src) currentSrcs.add(src);
    });
    gallerySelectedImages.forEach(function(src) {
        if (!currentSrcs.has(src)) {
            gallerySelectedImages.delete(src);
        }
    });
    galleryStarredImages.forEach(function(src) {
        if (!currentSrcs.has(src)) {
            galleryStarredImages.delete(src);
        }
    });

    // Ensure "Delete Selected" button exists for the final gallery only
    ensureDeleteButtonForGallery(document.getElementById('final_gallery'));

    updateDeleteSelectedButton();
    updateStarredUI();
});

document.addEventListener("DOMContentLoaded", function() {
    //const modalFragment = document.createDocumentFragment();
    const modal = document.createElement('div');
    modal.onclick = closeModal;
    modal.id = "lightboxModal";
    modal.tabIndex = 0;
    modal.addEventListener('keydown', modalKeyHandler, true);

    const modalControls = document.createElement('div');
    modalControls.className = 'modalControls gradio-container';
    modal.append(modalControls);

    const modalZoom = document.createElement('span');
    modalZoom.className = 'modalZoom cursor';
    modalZoom.innerHTML = '&#10529;';
    modalZoom.addEventListener('click', modalZoomToggle, true);
    modalZoom.title = "Toggle zoomed view";
    modalControls.appendChild(modalZoom);

    const modalStar = document.createElement('span');
    modalStar.id = 'modalStar';
    modalStar.className = 'modalStar cursor';
    modalStar.innerHTML = '&#9734;';
    modalStar.title = 'Star / unstar for approval (F)';
    modalStar.addEventListener('click', function(event) {
        event.stopPropagation();
        var modalImage = document.getElementById('modalImage');
        if (!modalImage || !modalImage.src) return;
        var src = modalImage.src;
        if (galleryStarredImages.has(src)) {
            galleryStarredImages.delete(src);
            modalStar.innerHTML = '&#9734;';
            modalStar.classList.remove('starred');
            sendUnapproveRequest(src);
        } else {
            galleryStarredImages.add(src);
            modalStar.innerHTML = '&#9733;';
            modalStar.classList.add('starred');
            sendApproveRequest(src);
        }
        // Sync the gallery thumbnail star
        var galleryButtons = all_gallery_buttons();
        galleryButtons.forEach(function(btn) {
            var img = btn.querySelector('img');
            if (img && img.src === src) {
                var starEl = btn.querySelector('.gallery-star');
                if (starEl) {
                    if (galleryStarredImages.has(src)) {
                        starEl.textContent = '\u2605';
                        starEl.classList.add('starred');
                    } else {
                        starEl.textContent = '\u2606';
                        starEl.classList.remove('starred');
                    }
                }
            }
        });
        updateStarredUI();
    }, true);
    modalControls.appendChild(modalStar);

    const modalDelete = document.createElement('span');
    modalDelete.className = 'modalDelete cursor';
    modalDelete.innerHTML = '&#128465;';
    modalDelete.addEventListener('click', function(event) {
        deleteCurrentImage();
        event.stopPropagation();
    }, true);
    modalDelete.title = "Delete image (Del)";
    modalControls.appendChild(modalDelete);

    const modalClose = document.createElement('span');
    modalClose.className = 'modalClose cursor';
    modalClose.innerHTML = '&times;';
    modalClose.onclick = closeModal;
    modalClose.title = "Close image viewer";
    modalControls.appendChild(modalClose);

    const modalImage = document.createElement('img');
    modalImage.id = 'modalImage';
    modalImage.onclick = closeModal;
    modalImage.tabIndex = 0;
    modalImage.addEventListener('keydown', modalKeyHandler, true);
    modal.appendChild(modalImage);

    const modalPrev = document.createElement('a');
    modalPrev.className = 'modalPrev';
    modalPrev.innerHTML = '&#10094;';
    modalPrev.tabIndex = 0;
    modalPrev.addEventListener('click', modalPrevImage, true);
    modalPrev.addEventListener('keydown', modalKeyHandler, true);
    modal.appendChild(modalPrev);

    const modalNext = document.createElement('a');
    modalNext.className = 'modalNext';
    modalNext.innerHTML = '&#10095;';
    modalNext.tabIndex = 0;
    modalNext.addEventListener('click', modalNextImage, true);
    modalNext.addEventListener('keydown', modalKeyHandler, true);

    modal.appendChild(modalNext);

    try {
        gradioApp().appendChild(modal);
    } catch (e) {
        gradioApp().body.appendChild(modal);
    }

    document.body.appendChild(modal);

    // Insert "Delete Selected" button near the final gallery (retry for late renders)
    function insertDeleteButtons() {
        ensureDeleteButtonForGallery(document.getElementById('final_gallery'));
    }
    insertDeleteButtons();
    setTimeout(insertDeleteButtons, 1000);
    setTimeout(insertDeleteButtons, 3000);
});
