// Profile & Topic management
// Syncs localStorage with Gradio textbox components, adds topic suggestions datalist

(function() {
    'use strict';

    var PROFILE_KEY = 'fooocus_profile';
    var TOPICS_KEY = 'fooocus_topics';
    var ACTIVE_TOPIC_KEY = 'fooocus_active_topic';

    function getProfile() {
        return localStorage.getItem(PROFILE_KEY) || 'default';
    }

    function getTopics() {
        try {
            return JSON.parse(localStorage.getItem(TOPICS_KEY) || '[]');
        } catch(e) { return []; }
    }

    function saveTopics(topics) {
        localStorage.setItem(TOPICS_KEY, JSON.stringify(topics));
    }

    function getActiveTopic() {
        return localStorage.getItem(ACTIVE_TOPIC_KEY) || '';
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
        addTopic: addTopic,
        getActiveTopic: getActiveTopic
    };

    function initSync() {
        // Set profile textbox from localStorage
        var storedProfile = getProfile();
        if (storedProfile && storedProfile !== 'default') {
            setGradioTextboxValue('profile_input', storedProfile);
        }

        // Set topic textbox from localStorage
        var storedTopic = getActiveTopic();
        if (storedTopic) {
            setGradioTextboxValue('topic_input', storedTopic);
        }

        // Build topic suggestions datalist
        rebuildDatalist();

        // Listen for profile changes to save to localStorage
        var profileContainer = document.getElementById('profile_input');
        if (profileContainer) {
            var profileEl = profileContainer.querySelector('textarea') || profileContainer.querySelector('input');
            if (profileEl) {
                profileEl.addEventListener('change', function() {
                    var val = this.value.trim() || 'default';
                    localStorage.setItem(PROFILE_KEY, val);
                });
            }
        }

        // Listen for topic changes to save to localStorage and add to suggestions
        var topicContainer = document.getElementById('topic_input');
        if (topicContainer) {
            var topicEl = topicContainer.querySelector('textarea') || topicContainer.querySelector('input');
            if (topicEl) {
                topicEl.addEventListener('change', function() {
                    var val = this.value.trim();
                    localStorage.setItem(ACTIVE_TOPIC_KEY, val);
                    if (val) addTopic(val);
                });
            }
        }
    }

    onUiLoaded(function() {
        setTimeout(initSync, 300);
    });
})();
