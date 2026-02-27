// Profile & Topic management
// Stored in localStorage, communicated to Python via hidden textboxes

(function() {
    'use strict';

    var PROFILE_KEY = 'fooocus_profile';
    var TOPICS_KEY = 'fooocus_topics';
    var ACTIVE_TOPIC_KEY = 'fooocus_active_topic';

    function getProfile() {
        return localStorage.getItem(PROFILE_KEY) || 'default';
    }

    function setProfile(name) {
        var val = (name || 'default').trim() || 'default';
        localStorage.setItem(PROFILE_KEY, val);
        sendToServer('profile_receiver', val);
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

    function setActiveTopic(name) {
        var val = (name || '').trim();
        localStorage.setItem(ACTIVE_TOPIC_KEY, val);
        sendToServer('topic_receiver', val);
        if (val) addTopic(val);
    }

    function addTopic(name) {
        if (!name || !name.trim()) return;
        var topics = getTopics();
        var trimmed = name.trim();
        if (topics.indexOf(trimmed) === -1) {
            topics.push(trimmed);
            topics.sort();
            saveTopics(topics);
        }
    }

    function sendToServer(elemId, value) {
        var el = document.querySelector('#' + elemId + ' textarea');
        if (!el) {
            el = document.querySelector('#' + elemId + ' input');
        }
        if (el) {
            el.value = value;
            var e = new Event('input', { bubbles: true });
            Object.defineProperty(e, 'target', { value: el });
            el.dispatchEvent(e);
        }
    }

    // Expose globally
    window.fooocusProfile = {
        getProfile: getProfile,
        setProfile: setProfile,
        getTopics: getTopics,
        addTopic: addTopic,
        saveTopics: saveTopics,
        getActiveTopic: getActiveTopic,
        setActiveTopic: setActiveTopic
    };

    function buildUI() {
        var container = document.getElementById('profile_topic_ui');
        if (!container) return;

        container.innerHTML = '';

        // Profile section
        var profileLabel = document.createElement('span');
        profileLabel.className = 'pt-label';
        profileLabel.textContent = 'Profile:';
        container.appendChild(profileLabel);

        var profileInput = document.createElement('input');
        profileInput.type = 'text';
        profileInput.className = 'pt-input';
        profileInput.id = 'profile_name_input';
        profileInput.value = getProfile();
        profileInput.placeholder = 'default';
        profileInput.addEventListener('change', function() {
            setProfile(this.value);
        });
        profileInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                this.blur();
            }
        });
        container.appendChild(profileInput);

        // Divider
        var divider = document.createElement('span');
        divider.className = 'pt-divider';
        divider.textContent = '|';
        container.appendChild(divider);

        // Topic section
        var topicLabel = document.createElement('span');
        topicLabel.className = 'pt-label';
        topicLabel.textContent = 'Topic:';
        container.appendChild(topicLabel);

        var topicInput = document.createElement('input');
        topicInput.type = 'text';
        topicInput.className = 'pt-input pt-topic-input';
        topicInput.id = 'topic_name_input';
        topicInput.setAttribute('list', 'topic_datalist');
        topicInput.value = getActiveTopic();
        topicInput.placeholder = '(none)';
        topicInput.addEventListener('change', function() {
            setActiveTopic(this.value);
            rebuildDatalist();
        });
        topicInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                this.blur();
            }
        });
        container.appendChild(topicInput);

        var datalist = document.createElement('datalist');
        datalist.id = 'topic_datalist';
        container.appendChild(datalist);

        // Clear topic button
        var clearBtn = document.createElement('button');
        clearBtn.className = 'pt-clear-btn';
        clearBtn.textContent = '\u2715';
        clearBtn.title = 'Clear topic';
        clearBtn.addEventListener('click', function() {
            topicInput.value = '';
            setActiveTopic('');
        });
        container.appendChild(clearBtn);

        rebuildDatalist();
    }

    function rebuildDatalist() {
        var datalist = document.getElementById('topic_datalist');
        if (!datalist) return;
        datalist.innerHTML = '';
        var topics = getTopics();
        for (var i = 0; i < topics.length; i++) {
            var opt = document.createElement('option');
            opt.value = topics[i];
            datalist.appendChild(opt);
        }
    }

    onUiLoaded(function() {
        // Send stored values to Python on page load
        setTimeout(function() {
            sendToServer('profile_receiver', getProfile());
            sendToServer('topic_receiver', getActiveTopic());
            buildUI();
        }, 500);
    });
})();
