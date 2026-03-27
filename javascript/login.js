// Login session management
// Persists login state in localStorage (survives browser close), masks password field,
// restores session on page load

(function() {
    'use strict';

    var STORAGE_USER_KEY = 'fjord_login_user';
    var STORAGE_PASS_KEY = 'fjord_login_pass';

    window.fjordLoggedIn = false;

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

    function maskPasswordField() {
        var container = document.getElementById('login_password');
        if (!container) return;
        var el = container.querySelector('textarea') || container.querySelector('input');
        if (el && el.type !== 'password') {
            el.type = 'password';
            el.autocomplete = 'current-password';
        }
    }

    function setupUsernameAutocomplete() {
        var container = document.getElementById('login_username');
        if (!container) return;
        var el = container.querySelector('textarea') || container.querySelector('input');
        if (el) {
            el.autocomplete = 'username';
        }
    }

    function saveSession(username, password) {
        if (username) {
            localStorage.setItem(STORAGE_USER_KEY, username);
            localStorage.setItem(STORAGE_PASS_KEY, password || '');
            window.fjordLoggedIn = true;
        }
    }

    function clearSession() {
        localStorage.removeItem(STORAGE_USER_KEY);
        localStorage.removeItem(STORAGE_PASS_KEY);
        window.fjordLoggedIn = false;
    }

    function restoreSession() {
        var user = localStorage.getItem(STORAGE_USER_KEY);
        var pass = localStorage.getItem(STORAGE_PASS_KEY);
        if (user) {
            // Send restore request to Python backend (pass may be '' for guest)
            var data = JSON.stringify({ username: user, password: pass || '' });
            setGradioTextboxValue('login_restore', data);
            window.fjordLoggedIn = true;
        }
    }

    // Watch for the login_page getting the page-hidden class to confirm successful login
    function watchLoginSuccess(username, password) {
        var loginPage = document.getElementById('login_page');
        if (!loginPage) return;
        var observer = new MutationObserver(function() {
            if (loginPage.classList.contains('page-hidden')) {
                saveSession(username, password);
                observer.disconnect();
            }
        });
        observer.observe(loginPage, { attributes: true, attributeFilter: ['class'] });
        setTimeout(function() { observer.disconnect(); }, 3000);
    }

    function hookLoginButton() {
        var loginBtn = document.getElementById('login_btn');
        if (!loginBtn) return;
        loginBtn.addEventListener('click', function() {
            var userEl = document.querySelector('#login_username textarea, #login_username input');
            var passEl = document.querySelector('#login_password textarea, #login_password input');
            if (userEl && passEl && userEl.value.trim()) {
                watchLoginSuccess(userEl.value.trim(), passEl.value);
            }
        }, true);
    }

    function hookGuestButton() {
        var guestBtn = document.getElementById('guest_btn');
        if (!guestBtn) return;
        guestBtn.addEventListener('click', function() {
            saveSession('guest', '');
        }, true);
    }

    function hookLogoutButton() {
        var logoutBtn = document.getElementById('logout_btn');
        if (!logoutBtn) return;
        logoutBtn.addEventListener('click', function() {
            clearSession();
        }, true);
    }

    function hookRegisterButton() {
        var registerBtn = document.getElementById('register_btn');
        if (!registerBtn) return;
        registerBtn.addEventListener('click', function() {
            var userEl = document.querySelector('#login_username textarea, #login_username input');
            var passEl = document.querySelector('#login_password textarea, #login_password input');
            if (userEl && passEl && userEl.value.trim()) {
                watchLoginSuccess(userEl.value.trim(), passEl.value);
            }
        }, true);
    }

    // Also handle restore: when session restores, switch page via JS
    function hookRestorePageSwitch() {
        var loginPage = document.getElementById('login_page');
        var mainApp = document.getElementById('main_app');
        if (!loginPage || !mainApp) return;
        // Watch for profile_input getting a value (set by Python restore handler)
        var profileContainer = document.getElementById('profile_input');
        if (!profileContainer) return;
        var profileEl = profileContainer.querySelector('textarea') || profileContainer.querySelector('input');
        if (!profileEl) return;
        var observer = new MutationObserver(function() {
            if (profileEl.value && profileEl.value.trim()) {
                loginPage.classList.add('page-hidden');
                mainApp.classList.remove('page-hidden');
                window.fjordLoggedIn = true;
                observer.disconnect();
            }
        });
        // Observe the input element's value attribute changes
        observer.observe(profileEl, { attributes: true });
        // Also listen for input events
        profileEl.addEventListener('input', function() {
            if (profileEl.value && profileEl.value.trim()) {
                loginPage.classList.add('page-hidden');
                mainApp.classList.remove('page-hidden');
                window.fjordLoggedIn = true;
                observer.disconnect();
            }
        });
        // Auto-disconnect after 5 seconds
        setTimeout(function() { observer.disconnect(); }, 5000);
    }

    // ---- Search image lightbox ----
    window._openSearchImage = function(src) {
        var overlay = document.getElementById('search-lightbox');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'search-lightbox';
            overlay.innerHTML = '<div class="search-lightbox-backdrop"></div><img class="search-lightbox-img" src="">';
            document.body.appendChild(overlay);
            overlay.querySelector('.search-lightbox-backdrop').addEventListener('click', function() {
                overlay.classList.remove('search-lightbox-open');
            });
            overlay.querySelector('.search-lightbox-img').addEventListener('click', function(e) {
                e.stopPropagation();
            });
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') overlay.classList.remove('search-lightbox-open');
            });
        }
        overlay.querySelector('.search-lightbox-img').src = src;
        overlay.classList.add('search-lightbox-open');
    };

    // ---- Search selection tracking ----
    window._searchSelectionChanged = function() {
        var cbs = document.querySelectorAll('#search_results_html .search-cb:checked');
        var btn = document.getElementById('search_delete_selected_btn');
        var countEl = document.getElementById('search_sel_count');
        var count = cbs.length;
        // Update the delete button text
        if (btn) {
            var inner = btn.querySelector('span') || btn;
            inner.textContent = count > 0 ? 'Delete Selected (' + count + ')' : 'Delete Selected';
        }
    };

    // ---- Admin search debounce ----
    function setupSearchDebounce() {
        var searchInput = document.querySelector('#admin_search_query textarea, #admin_search_query input');
        if (!searchInput) return;
        var timer = null;
        function triggerSearch() {
            var val = searchInput.value || '';
            // Fire the hidden trigger to invoke the Python handler
            var trigger = document.getElementById('search_trigger');
            if (!trigger) return;
            var el = trigger.querySelector('textarea') || trigger.querySelector('input');
            if (el) {
                el.value = val + '|' + Date.now(); // unique value to force input event
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        searchInput.addEventListener('input', function() {
            clearTimeout(timer);
            timer = setTimeout(triggerSearch, 400);
        });
        // Also trigger on preset dropdown change
        var presetContainer = document.querySelector('#search_filters_accordion');
        if (presetContainer) {
            presetContainer.addEventListener('change', function() {
                clearTimeout(timer);
                timer = setTimeout(triggerSearch, 300);
            });
        }
    }

    // Allow Enter key to trigger login from password field
    function hookEnterKey() {
        var passEl = document.querySelector('#login_password textarea, #login_password input');
        if (passEl) {
            passEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    var loginBtn = document.getElementById('login_btn');
                    if (loginBtn) loginBtn.click();
                }
            });
        }
    }

    onUiLoaded(function() {
        setTimeout(function() {
            maskPasswordField();
            setupUsernameAutocomplete();
            hookLoginButton();
            hookGuestButton();
            hookLogoutButton();
            hookRegisterButton();
            hookEnterKey();
            hookRestorePageSwitch();
            setupSearchDebounce();
            // Restore session after a brief delay to let Gradio initialize
            setTimeout(restoreSession, 500);
        }, 300);
    });
})();
