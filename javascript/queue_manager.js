// Queue Manager: drag-to-reorder and remove queue items
(function() {
    'use strict';

    var dragSrcIndex = null;

    function sendQueueMutation(mutationStr) {
        var el = document.querySelector('#queue_mutation_request textarea') ||
                 document.querySelector('#queue_mutation_request input');
        if (el) {
            el.value = mutationStr;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // Remove a queue item by index (called from inline onclick)
    window.removeQueueItem = function(index) {
        sendQueueMutation('remove:' + index);
    };

    // Set up drag-and-drop on queue items
    function setupQueueDragDrop() {
        var container = document.getElementById('queue_container');
        if (!container) return;

        var items = container.querySelectorAll('.queue-item[draggable="true"]');
        items.forEach(function(item) {
            if (item.dataset.dragBound) return;
            item.dataset.dragBound = '1';

            item.addEventListener('dragstart', function(e) {
                dragSrcIndex = parseInt(this.dataset.queueIndex, 10);
                this.classList.add('queue-item-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', this.dataset.queueIndex);
            });

            item.addEventListener('dragend', function() {
                this.classList.remove('queue-item-dragging');
                container.querySelectorAll('.queue-item').forEach(function(el) {
                    el.classList.remove('queue-drag-over');
                });
                dragSrcIndex = null;
            });

            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                this.classList.add('queue-drag-over');
            });

            item.addEventListener('dragleave', function() {
                this.classList.remove('queue-drag-over');
            });

            item.addEventListener('drop', function(e) {
                e.preventDefault();
                this.classList.remove('queue-drag-over');
                var dropIndex = parseInt(this.dataset.queueIndex, 10);
                if (dragSrcIndex === null || dragSrcIndex === dropIndex) return;

                // Build new order: move dragSrcIndex to dropIndex position
                var allItems = container.querySelectorAll('.queue-item[data-queue-index]');
                var count = allItems.length;
                var indices = [];
                for (var i = 0; i < count; i++) indices.push(i);

                // Remove source and insert at drop position
                indices.splice(dragSrcIndex, 1);
                indices.splice(dropIndex, 0, dragSrcIndex);

                sendQueueMutation('reorder:' + indices.join(','));
            });
        });
    }

    // Observe queue display for changes and rebind drag events
    var observer = null;
    function observeQueue() {
        var target = document.getElementById('prompt_queue_display');
        if (!target) {
            setTimeout(observeQueue, 1000);
            return;
        }
        observer = new MutationObserver(function() {
            setTimeout(setupQueueDragDrop, 50);
        });
        observer.observe(target, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observeQueue);
    } else {
        observeQueue();
    }
})();
