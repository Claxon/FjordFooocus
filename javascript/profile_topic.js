// Profile & Topic management
// Syncs localStorage with Gradio textbox components, adds topic suggestions datalist

(function() {
    'use strict';

    var PROFILE_KEY = 'fooocus_profile';
    var TOPICS_KEY = 'fooocus_topics';

    function getProfile() {
        // Return empty string for new users — they must set a name before generating
        return localStorage.getItem(PROFILE_KEY) || '';
    }

    function getTopics() {
        try {
            return JSON.parse(localStorage.getItem(TOPICS_KEY) || '[]');
        } catch(e) { return []; }
    }

    function saveTopics(topics) {
        localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
    }

    function addTopic(name) {
        if (!name || !name.trim()) return;
        var topics = getTopics();
        var trimmed = name.trim();
        if (topics.indexOf(trimmed) === -1) {
            topics.push(trimmed);
            topics.sort();
            saveTopics(topics);
            rebuildDatalist();
        }
    }

    function setGradioTextboxValue(elemId, value) {
        var container = document.getElementById(elemId);
        if (!container) return;
        var el = container.querySelector('textarea') || container.querySelector('input');
        if (el) {
            el.value = value;
            var e = new Event('input', { bubbles: true });
            Object.defineProperty(e, 'target', { value: el });
            el.dispatchEvent(e);
        }
    }

    function rebuildDatalist() {
        var datalist = document.getElementById('topic_suggestions');
        if (!datalist) {
            datalist = document.createElement('datalist');
            datalist.id = 'topic_suggestions';
            document.body.appendChild(datalist);
        }
        datalist.innerHTML = '';
        var topics = getTopics();
        for (var i = 0; i < topics.length; i++) {
            var opt = document.createElement('option');
            opt.value = topics[i];
            datalist.appendChild(opt);
        }
        // Attach datalist to the topic input
        var topicContainer = document.getElementById('topic_input');
        if (topicContainer) {
            var input = topicContainer.querySelector('textarea') || topicContainer.querySelector('input');
            if (input) {
                input.setAttribute('list', 'topic_suggestions');
            }
        }
    }

    // Expose globally
    window.fooocusProfile = {
        getProfile: getProfile,
        getTopics: getTopics,
        addTopic: addTopic
    };

    function initSync() {
        // Restore profile from localStorage (returning users get their name pre-filled)
        var storedProfile = getProfile();
        if (storedProfile) {
            setGradioTextboxValue('profile_input', storedProfile);
        }
        // Topic intentionally NOT restored — starts empty on every page load

        // Build topic suggestions datalist
        rebuildDatalist();

        // Listen for profile changes to save to localStorage
        var profileContainer = document.getElementById('profile_input');
        if (profileContainer) {
            var profileEl = profileContainer.querySelector('textarea') || profileContainer.querySelector('input');
            if (profileEl) {
                profileEl.addEventListener('change', function() {
                    var val = this.value.trim();
                    if (val) {
                        localStorage.setItem(PROFILE_KEY, val);
                    }
                });
            }
        }

        // Listen for topic changes to save to history list (not to active-topic localStorage)
        var topicContainer = document.getElementById('topic_input');
        if (topicContainer) {
            var topicEl = topicContainer.querySelector('textarea') || topicContainer.querySelector('input');
            if (topicEl) {
                topicEl.addEventListener('change', function() {
                    var val = this.value.trim();
                    if (val) addTopic(val);
                });
            }
        }

        // Guard: require a profile name before generating
        var genBtn = document.getElementById('generate_button');
        if (genBtn) {
            genBtn.addEventListener('click', function(event) {
                var profileContainer = document.getElementById('profile_input');
                if (!profileContainer) return;
                var el = profileContainer.querySelector('textarea') || profileContainer.querySelector('input');
                if (el && !el.value.trim()) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    var name = window.prompt('Enter your name to save your images.\n\nThis keeps your images separate from other users:', '');
                    if (name && name.trim()) {
                        var trimmed = name.trim();
                        localStorage.setItem(PROFILE_KEY, trimmed);
                        setGradioTextboxValue('profile_input', trimmed);
                        // Re-trigger the click after Gradio has a tick to process the input event
                        setTimeout(function() { genBtn.click(); }, 200);
                    } else {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.focus();
                    }
                }
            }, true); // capture phase — runs before Gradio's handlers
        }
    }

    onUiLoaded(function() {
        setTimeout(initSync, 300);
    });
})();
