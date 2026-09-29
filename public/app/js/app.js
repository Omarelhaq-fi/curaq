// Core State & App Logic
let db = {
    documents: [],
    rems: [],
    flashcardsQueue: [],
    sections: []
};

let activeDocId = null;

async function initApp(user) {
    if (!user) {
        // Redirect to landing page for sign-in/sign-up
        try { window.hideGlobalLoader && window.hideGlobalLoader(); } catch (_) {}
        window.location.href = '/';
        return;
    }

    try {
    const loginEl = document.getElementById('login-screen');
    if (loginEl) loginEl.style.display = 'none';
    const appWrapper = document.getElementById('app-wrapper');
    if (appWrapper) appWrapper.style.display = 'block';
    window.clearStaleClickBlockers && window.clearStaleClickBlockers();
    try { window.updateProfileCircle && window.updateProfileCircle(user); } catch (e) {}

    let cloudDb = null;
    if (window.loadDbFromCloud) {
        try {
            cloudDb = await Promise.race([
                window.loadDbFromCloud(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('loadDb timeout')), 7000))
            ]);
        } catch (e) {
            try { console.warn('loadDbFromCloud failed/timeout, continuing with local db', e); } catch (_) {}
            cloudDb = null;
        }
    }

    if (cloudDb) {
        db = cloudDb;
    } else {
        db.documents = [];
        db.rems = [];
        db.flashcardsQueue = [];
        db.sections = [];
        db.subjects = [{ id: 's1', name: 'General' }];
        db.studyStats = {};
        saveDb();
    }


    // Ensure backwards compatibility (cloud payloads can be partial/malformed)
    if (!db || typeof db !== 'object') db = {};
    if (!Array.isArray(db.documents)) db.documents = [];
    if (!Array.isArray(db.rems)) db.rems = [];
    if (!Array.isArray(db.flashcardsQueue)) db.flashcardsQueue = [];
    if (!Array.isArray(db.sections)) db.sections = [];
    if (!db.subjects) {
        db.subjects = [{ id: 's1', name: 'General' }];
    }
    if (!db.studyStats) {
        db.studyStats = {};
    }

    // Welcome onboarding: anyone without a country on their profile
    // (brand-new signup or legacy account) sets name + country here.
    try {
        const u0 = window.firebase && firebase.auth().currentUser;
        // Authoritative check: does users_index/{uid} have a country?
        // Legacy accounts (no country) and fresh signups both get the welcome.
        if (u0 && typeof window.showWelcomeOnboarding === "function") {
            (async () => {
                try {
                    let hasCountry = false;
                    try {
                        if (window.getUsersIndexDoc) {
                            const rec = await window.getUsersIndexDoc(u0.uid);
                            hasCountry = !!(rec.exists && rec.data && rec.data.country);
                        } else {
                            const snap = await firebase.firestore().collection("users_index").doc(u0.uid).get();
                            hasCountry = !!(snap.exists && snap.data() && snap.data().country);
                        }
                    } catch (_) {}
                    if (!hasCountry) window.showWelcomeOnboarding();
                } catch (_) {}
            })();
        }
    } catch (_) {}
    if (!Array.isArray(db.schedule)) {
        db.schedule = [];
    }
    (db.documents || []).forEach(d => {
        if (!d || typeof d !== 'object') return;
        if (!d.sections) d.sections = [];
        if (d.pdfContextText === undefined) d.pdfContextText = "";
        if (!d.subjectId) d.subjectId = (db.subjects && db.subjects[0] && db.subjects[0].id) || 's1';
    });

    // Make refreshAppUI global if not already, and call it
    window.refreshAppUI = refreshAppUI;
    window.db = db;
    if (window.preloadQBank) window.preloadQBank().catch(() => {});
    if (window.i18nInit) window.i18nInit();
    // Try restoring the last viewed doc / tab / chunk from a previous session.
    let restored = false;
    try { restored = !!(window.restoreLastView && window.restoreLastView()); } catch (_) {}
    
    // Always boot into QBank mode
    localStorage.setItem("omnote_active_platform", "qbank");
    try {
        window.switchPlatform("qbank", true);
    } catch (e) {
        try { console.error('switchPlatform failed', e); } catch (_) {}
        try { window.hideGlobalLoader && window.hideGlobalLoader(); } catch (_) {}
        const area = document.getElementById("qbank-home-content");
        if (area) area.innerHTML = '<div style="padding:40px;text-align:center;color:#b91c1c;">Failed to start dashboard: ' + ((e && e.message) || e) + '</div>';
    }

    // Tour disabled - QBank only mode
    } catch (e) {
        try { console.error('initApp failed', e); } catch (_) {}
        try {
            const appWrapper2 = document.getElementById('app-wrapper');
            if (appWrapper2) appWrapper2.style.display = 'block';
            window.hideGlobalLoader && window.hideGlobalLoader();
            const area2 = document.getElementById("qbank-home-content");
            if (area2 && !area2.innerHTML) area2.innerHTML = '<div style="padding:40px;text-align:center;color:#b91c1c;">Failed to load dashboard. Please reload.</div>';
        } catch (_) {}
    }
}

window.switchPlatform = function(platform, isInit = false) {
    localStorage.setItem("omnote_active_platform", "qbank");
    
    const chooser = document.getElementById('platform-chooser');
    if (chooser) chooser.style.display = 'none';
    
    const _aw = document.getElementById('app-wrapper');
    if (_aw) _aw.style.display = 'block';
    
    // Hide learning-only sidebar elements
    const libGrp = document.getElementById("sidebar-library-group");
    const exLabel = document.getElementById("sidebar-extra-tools-label");
    const exCont = document.getElementById("extra-tools-container");
    const subGrp = document.getElementById("sidebar-subject-group");
    
    if (libGrp) libGrp.style.display = "none";
    if (exLabel) exLabel.style.display = "none";
    if (exCont) exCont.style.display = "none";
    if (subGrp) subGrp.style.display = "none";
    
    // Hide learning views
    const workspace = document.getElementById("workspace");
    const homeView = document.getElementById("home-view");
    const schedView = document.getElementById("scheduler-view");
    const statsView = document.getElementById("stats-view");
    if (workspace) workspace.style.display = "none";
    if (homeView) homeView.style.display = "none";
    if (schedView) schedView.style.display = "none";
    if (statsView) statsView.style.display = "none";
    
    // Show qbank view
    const qbankHome = document.getElementById("qbank-home-view");
    if (qbankHome) qbankHome.style.display = "flex";
    
    if (!isInit) {
        window.openQBank && window.openQBank();
    } else {
        setTimeout(() => window.openQBank && window.openQBank(), 100);
    }
    
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
};

window.togglePlatform = function() {
    // QBank only mode - no toggle needed
};

window.hideAllMainViews = function() {
    const views = [
        "qbank-home-view",
        "flashcards-explorer-view",
        "performance-view",
        "planner-view",
        "resources-view",
        "library-view"
    ];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
};

window.goHome = function() {
    window.openQBank && window.openQBank();
};


function saveDb() {
    if (window.firebase && firebase.auth().currentUser && window.syncDbToCloud) {
        window.syncDbToCloud(db);
    }
}

function generateId() {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const b = new Uint8Array(9); crypto.getRandomValues(b);
            return Array.from(b).map(x => x.toString(36)).join('').slice(0, 12);
        }
    } catch (_) {}
    return crypto.randomUUID().replace(/-/g,'').slice(0,9);
}

// Sidebar Logic
window.toggleSidebar = function () {
    const overlay = document.getElementById('sidebar-overlay');
    const menu = document.getElementById('sidebar-menu');
    if (!overlay || !menu) return;
    const isOpen = overlay.classList.contains('active') || menu.classList.contains('active');
    overlay.classList.toggle('active', !isOpen);
    menu.classList.toggle('active', !isOpen);
}

window.closeSidebar = function () {
    document.getElementById('sidebar-overlay')?.classList.remove('active');
    document.getElementById('sidebar-menu')?.classList.remove('active');
}

window.clearStaleClickBlockers = function () {
    window.closeSidebar && window.closeSidebar();
    const loading = document.getElementById('global-loading-overlay');
    if (loading) loading.style.display = 'none';
    const importBusy = document.getElementById('omn-import-busy');
    if (importBusy) importBusy.style.display = 'none';
    const importMenu = document.getElementById('omn-import-menu');
    if (importMenu) importMenu.style.display = 'none';
    document.querySelectorAll('.custom-popover').forEach((el) => el.classList.remove('active'));
}

// ---- Request Access: global delegation (works even if inline handlers break) ----
document.addEventListener("click", function (e) {
    const card = e.target && e.target.closest ? e.target.closest("[data-req-bank]") : null;
    if (!card) return;
    if (typeof window.qbankRequestAccess === "function") {
        e.preventDefault();
        window.qbankRequestAccess(card.getAttribute("data-req-bank"), card.getAttribute("data-req-name") || "");
    }
}, true);

// ---- Home search: live suggestions for subjects, chapters, and question IDs ----
// Delegates the lookup to the QBank module which owns the question cache.

// Debounce helper
let _searchDebounceTimer = null;
let _searchActiveIndex = -1;
let _searchResults = [];
let _searchLoading = false;
let _searchIndexCache = {}; // Separate cache for search to avoid corrupting QBank session

function _getSearchInput() {
    return document.getElementById('home-search-input');
}

function _getSearchDropdown() {
    return document.getElementById('home-search-dropdown');
}

function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[c]));
}

function _closeSearchDropdown() {
    const dd = _getSearchDropdown();
    if (dd) dd.classList.add('hidden');
    _searchActiveIndex = -1;
    _searchResults = [];
}

function _showSearchDropdown(html) {
    const dd = _getSearchDropdown();
    if (!dd) return;
    dd.innerHTML = html;
    dd.classList.remove('hidden');
}

function _highlightMatch(text, query) {
    if (!query) return _escHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return _escHtml(text);
    const before = _escHtml(text.substring(0, idx));
    const match = _escHtml(text.substring(idx, idx + query.length));
    const after = _escHtml(text.substring(idx + query.length));
    return `${before}<mark style="background:#fef08a;color:#000;padding:0 1px;">${match}</mark>${after}`;
}

// Main search function that finds subjects and chapters
function _performSearch(query) {
    const results = [];
    const q = (query || '').trim().toLowerCase();
    
    if (!q) {
        _closeSearchDropdown();
        return;
    }
    
    // Check if it looks like a question ID (alphanumeric, 3-64 chars)
    const looksLikeId = /^[A-Za-z0-9_-]{3,64}$/.test(q);
    
    // Get current qbank data
    const activeQBankId = window.db && window.db.selectedQBankId;
    
    if (!activeQBankId) {
        _showSearchDropdown('<div class="search-no-results">Please select a QBank first</div>');
        return;
    }
    
    // Use cached questions if available in memory or search index
    let questions = [];
    if (window.cachedQBanks && window.cachedQBanks[activeQBankId] && window.cachedQBanks[activeQBankId].questions) {
        questions = window.cachedQBanks[activeQBankId].questions || [];
    } else if (_searchIndexCache && _searchIndexCache[activeQBankId]) {
        questions = _searchIndexCache[activeQBankId];
    }
    
    // If not in memory, try loading from IndexedDB (local-first)
    if (questions.length === 0) {
        _showSearchDropdown('<div class="search-loading">Loading QBank data...</div>');
        if (!_searchLoading) {
            _searchLoading = true;
            _loadQBankFromCache(activeQBankId).then(qs => {
                _searchLoading = false;
                setTimeout(() => _performSearch(query), 50);
            }).catch(() => {
                _searchLoading = false;
                _showSearchDropdown('<div class="search-no-results">Failed to load QBank data</div>');
            });
        }
        return;
    }
    
    // Build subject and chapter index
    const subjectIndex = {};
    
    questions.forEach(question => {
        const data = question.data || {};
        const subject = data.subject || 'Uncategorized';
        const chapter = data.chapter || null;
        
        if (subject !== 'Uncategorized') {
            if (!subjectIndex[subject]) {
                subjectIndex[subject] = { total: 0, chapters: {} };
            }
            subjectIndex[subject].total++;
            
            if (chapter) {
                if (!subjectIndex[subject].chapters[chapter]) {
                    subjectIndex[subject].chapters[chapter] = 0;
                }
                subjectIndex[subject].chapters[chapter]++;
            }
        }
    });
    
    // Search subjects
    Object.keys(subjectIndex).forEach(subject => {
        const subLower = subject.toLowerCase();
        if (subLower.includes(q)) {
            results.push({
                type: 'subject',
                name: subject,
                total: subjectIndex[subject].total,
                matchScore: subLower === q ? 100 : (subLower.startsWith(q) ? 80 : 60)
            });
        }
    });
    
    // Search chapters
    Object.keys(subjectIndex).forEach(subject => {
        Object.keys(subjectIndex[subject].chapters).forEach(chapter => {
            const chLower = chapter.toLowerCase();
            if (chLower.includes(q)) {
                results.push({
                    type: 'chapter',
                    name: chapter,
                    subject: subject,
                    total: subjectIndex[subject].chapters[chapter],
                    matchScore: chLower === q ? 90 : (chLower.startsWith(q) ? 70 : 50)
                });
            }
        });
    });
    
    // Sort by match score, then by name
    results.sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return a.name.localeCompare(b.name);
    });
    
    _searchResults = results;
    _searchActiveIndex = -1;
    
    if (results.length === 0 && !looksLikeId) {
        _showSearchDropdown('<div class="search-no-results">No subjects or chapters found</div>');
    } else {
        _renderSearchResults(results, q, looksLikeId);
    }
}

// Load questions from IndexedDB cache (local-first)
// Uses a separate search index to avoid corrupting the main QBank session cache
function _loadQBankFromCache(qbankId) {
    return new Promise((resolve, reject) => {
        const loadFn = async () => {
            try {
                // Check if already in memory (either cache)
                if (window.cachedQBanks && window.cachedQBanks[qbankId] && window.cachedQBanks[qbankId].questions) {
                    return window.cachedQBanks[qbankId].questions;
                }
                
                // Check search index cache
                if (_searchIndexCache && _searchIndexCache[qbankId]) {
                    return _searchIndexCache[qbankId];
                }
                
                // Try IndexedDB first (local-first approach)
                if (window.getCachedQBank) {
                    const idbData = await window.getCachedQBank(qbankId);
                    if (idbData && idbData.questions && idbData.questions.length > 0) {
                        // Store in search index only (not in cachedQBanks to avoid corrupting session)
                        _searchIndexCache[qbankId] = idbData.questions;
                        return idbData.questions;
                    }
                }
                
                // Authenticated private static endpoint (per-bank key, stems-only).
                // No public CDN cache: requires Firebase ID token, 403s without access.
                const qCat = (window.cachedCategories || []).find(c => c.id === qbankId);
                const catUpdated = qCat ? (qCat.updatedAt || 0) : 0;

                const headers = await window.qbankAuthHeaders();
                const res = await fetch(`/api/qbank_static?qbankId=${encodeURIComponent(qbankId)}&v=${encodeURIComponent(catUpdated)}`, { headers });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "API error");
                
                let questions = data.questions || [];
                if (data.encryptedQuestions) {
                    try {
                        const jsonStr = await window.decryptQBankPayload(data.encryptedQuestions, qbankId);
                        questions = JSON.parse(jsonStr);
                    } catch (e) {
                        console.error("DRM decryption failed", e);
                    }
                }
                
                // Store in search index only
                _searchIndexCache[qbankId] = questions;
                
                // Save to IndexedDB for next time
                if (window.setCachedQBank) {
                    window.setCachedQBank(qbankId, { updatedAt: catUpdated, questions });
                }
                
                return questions;
            } catch (e) {
                throw e;
            }
        };
        
        loadFn().then(resolve).catch(reject);
    });
}

function _renderSearchResults(results, query, showIdOption) {
    let html = '';
    
    if (showIdOption) {
        html += `<div class="search-section-header">Search by Question ID</div>`;
        html += `
            <div class="search-suggestion-item" data-action="search-id" data-id="${_escHtml(query)}">
                <div class="suggestion-icon question">
                    <i class="fa-solid fa-search" style="font-size:12px;"></i>
                </div>
                <div class="suggestion-text">
                    <div class="suggestion-title">Search for "${_escHtml(query)}"</div>
                    <div class="suggestion-subtitle">Press Enter to search by question ID or code</div>
                </div>
            </div>`;
    }
    
    const subjects = results.filter(r => r.type === 'subject');
    const chapters = results.filter(r => r.type === 'chapter');
    
    if (subjects.length > 0) {
        html += `<div class="search-section-header">Subjects (${subjects.length})</div>`;
        subjects.slice(0, 5).forEach((item, idx) => {
            html += `
                <div class="search-suggestion-item" data-action="subject" data-name="${_escHtml(item.name)}" data-idx="${idx}">
                    <div class="suggestion-icon subject">
                        <i class="fa-solid fa-book-medical" style="font-size:12px;"></i>
                    </div>
                    <div class="suggestion-text">
                        <div class="suggestion-title">${_highlightMatch(item.name, query)}</div>
                        <div class="suggestion-subtitle">Subject</div>
                    </div>
                    <span class="suggestion-badge count">${item.total} Q</span>
                </div>`;
        });
    }
    
    if (chapters.length > 0) {
        html += `<div class="search-section-header">Chapters (${chapters.length})</div>`;
        chapters.slice(0, 5).forEach((item, idx) => {
            html += `
                <div class="search-suggestion-item" data-action="chapter" data-name="${_escHtml(item.name)}" data-subject="${_escHtml(item.subject)}" data-idx="${idx + subjects.length}">
                    <div class="suggestion-icon chapter">
                        <i class="fa-solid fa-book-open" style="font-size:12px;"></i>
                    </div>
                    <div class="suggestion-text">
                        <div class="suggestion-title">${_highlightMatch(item.name, query)}</div>
                        <div class="suggestion-subtitle">${_escHtml(item.subject)}</div>
                    </div>
                    <span class="suggestion-badge count">${item.total} Q</span>
                </div>`;
        });
    }
    
    if (results.length === 0 && !showIdOption) {
        html = '<div class="search-no-results">No subjects or chapters found</div>';
    }
    
    _showSearchDropdown(html);
    
    // Add click handlers
    const dd = _getSearchDropdown();
    dd.querySelectorAll('.search-suggestion-item').forEach(el => {
        el.addEventListener('click', () => {
            const action = el.getAttribute('data-action');
            if (action === 'subject') {
                const name = el.getAttribute('data-name');
                _openSubjectInQBank(name);
            } else if (action === 'chapter') {
                const name = el.getAttribute('data-name');
                const subject = el.getAttribute('data-subject');
                _openChapterInQBank(subject, name);
            } else if (action === 'search-id') {
                const id = el.getAttribute('data-id');
                _searchQuestionById(id);
            }
        });
    });
}

function _openSubjectInQBank(subjectName) {
    _closeSearchDropdown();
    const input = _getSearchInput();
    if (input) { input.value = ''; input.placeholder = 'Search subjects, chapters, or question ID...'; }
    
    if (!window.db || !window.db.selectedQBankId) {
        if (window.openQBankSelection) window.openQBankSelection();
        return;
    }
    
    const activeQBankId = window.db.selectedQBankId;
    const qbankName = (window.cachedCategories || []).find(q => q.id === activeQBankId)?.name || 'QBank';
    
    // Use startQBankSession which handles data loading and opens the subject
    if (window.startQBankSession) {
        window.startQBankSession(activeQBankId, qbankName, subjectName);
    }
}

function _openChapterInQBank(subjectName, chapterName) {
    _closeSearchDropdown();
    const input = _getSearchInput();
    if (input) { input.value = ''; input.placeholder = 'Search subjects, chapters, or question ID...'; }
    
    if (!window.db || !window.db.selectedQBankId) {
        if (window.openQBankSelection) window.openQBankSelection();
        return;
    }
    
    const activeQBankId = window.db.selectedQBankId;
    const qbankName = (window.cachedCategories || []).find(q => q.id === activeQBankId)?.name || 'QBank';
    
    // Open the subject first (shows chapters), then auto-select the chapter
    if (window.startQBankSession) {
        window.startQBankSession(activeQBankId, qbankName, subjectName).then(() => {
            // After subject view loads, auto-open the specific chapter
            setTimeout(() => {
                if (window.startQBankFiltered) {
                    window.startQBankFiltered(subjectName, chapterName);
                }
            }, 150);
        });
    }
}

function _searchQuestionById(term) {
    _closeSearchDropdown();
    const input = _getSearchInput();
    if (!input) return;
    
    const originalPlaceholder = input.placeholder;
    input.value = '';
    input.placeholder = 'Searching…';
    input.disabled = true;
    
    if (!window.qbankFindByRef) {
        alert("Search is still loading — try again in a second.");
        input.disabled = false;
        input.placeholder = originalPlaceholder;
        return;
    }
    
    window.qbankFindByRef(term).then(hit => {
        if (!hit) {
            alert(`No question found for "${term}". Check the ID and try again.`);
            return;
        }
        
        if (hit.alternatives && hit.alternatives.length) {
            const options = [{ bankId: hit.bankId, bankName: hit.bankName }, ...hit.alternatives];
            const listing = options.map((o, i) => `${i + 1}. ${o.bankName}`).join('\n');
            const ans = prompt(`This ID exists in ${options.length} banks:\n${listing}\n\nEnter the number to open:`, '1');
            if (ans === null) return;
            const idx = parseInt(ans, 10);
            if (!isNaN(idx) && idx > 1 && idx <= options.length) {
                const picked = options[idx - 1];
                return window.qbankFindByRef(term, picked.bankId).then(newHit => {
                    if (!newHit) { alert('Could not load that copy.'); return; }
                    return window.qbankOpenSingle(newHit.bankId, newHit.bankName, newHit.question);
                });
            }
        }
        
        return window.qbankOpenSingle(hit.bankId, hit.bankName, hit.question);
    }).catch(e => {
        alert('Search failed: ' + e.message);
    }).finally(() => {
        input.disabled = false;
        input.placeholder = originalPlaceholder;
    });
}

// Input handler with debouncing
window.handleHomeSearchInput = function(event) {
    const query = event.target.value;
    
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => {
        _performSearch(query);
    }, 200);
};

// Focus handler - show dropdown if there's content
window.handleHomeSearchFocus = function(event) {
    const query = event.target.value;
    if (query && query.trim()) {
        _performSearch(query);
    }
};

// Keydown handler for Enter, Up, Down arrows
window.handleHomeSearch = function(event) {
    const inputEl = event.target;
    const dropdown = _getSearchDropdown();
    
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (dropdown && !dropdown.classList.contains('hidden')) {
            const items = dropdown.querySelectorAll('.search-suggestion-item');
            if (items.length > 0) {
                _searchActiveIndex = Math.min(_searchActiveIndex + 1, items.length - 1);
                items.forEach((el, i) => {
                    el.classList.toggle('active', i === _searchActiveIndex);
                });
                items[_searchActiveIndex].scrollIntoView({ block: 'nearest' });
            }
        }
        return;
    }
    
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (dropdown && !dropdown.classList.contains('hidden')) {
            const items = dropdown.querySelectorAll('.search-suggestion-item');
            if (items.length > 0) {
                _searchActiveIndex = Math.max(_searchActiveIndex - 1, 0);
                items.forEach((el, i) => {
                    el.classList.toggle('active', i === _searchActiveIndex);
                });
                items[_searchActiveIndex].scrollIntoView({ block: 'nearest' });
            }
        }
        return;
    }
    
    if (event.key === 'Enter') {
        // If a suggestion is active, click it
        if (dropdown && !dropdown.classList.contains('hidden') && _searchActiveIndex >= 0) {
            const items = dropdown.querySelectorAll('.search-suggestion-item');
            if (items[_searchActiveIndex]) {
                items[_searchActiveIndex].click();
                return;
            }
        }
        
        // Otherwise, try ID search
        const term = (inputEl.value || '').trim();
        if (!term) return;
        
        inputEl.blur();
        _closeSearchDropdown();
        _searchQuestionById(term);
        return;
    }
    
    if (event.key === 'Escape') {
        _closeSearchDropdown();
        inputEl.blur();
        return;
    }
};

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
    const input = _getSearchInput();
    const dropdown = _getSearchDropdown();
    if (input && dropdown && !input.contains(e.target) && !dropdown.contains(e.target)) {
        _closeSearchDropdown();
    }
});

window.toggleRightPane = function () {
    const rightPane = document.getElementById('right-pane');
    if (rightPane) {
        rightPane.classList.toggle('collapsed');
        document.body.classList.toggle('sidebar-closed', rightPane.classList.contains('collapsed'));
    }
}

window.toggleFullScreen = function () {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.log(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

window.createNewDocument = function () {
    const docId = generateId();
    const subjectId = db.subjects && db.subjects.length > 0 ? db.subjects[0].id : 's1';
    db.documents.push({ id: docId, title: 'Untitled Document', created: Date.now(), pdfContextText: "", sections: [], subjectId });
    activeDocId = docId;
    window.addRem(docId, "", 0); // initial rem
    saveDb();
    refreshAppUI();
    window.closeSidebar && window.closeSidebar();
}

window.deleteDocument = function (docId) {
    if (!confirm("Are you sure you want to delete this document and all its notes?")) return;

    db.documents = db.documents.filter(d => d.id !== docId);
    db.rems = db.rems.filter(r => r.docId !== docId);

    if (window.pdfUrlCache && window.pdfUrlCache[docId]) {
        try { URL.revokeObjectURL(window.pdfUrlCache[docId]); } catch (_) {}
        delete window.pdfUrlCache[docId];
    }
    if (window.deletePersistedPdf) window.deletePersistedPdf(docId);

    saveDb();


    if (activeDocId === docId) {
        if (db.documents.length === 0) {
            window.createNewDocument();
        } else {
            window.switchDocument(db.documents[0].id);
        }
    } else {
        if (!activeDocId) {
            window.showHomeView();
        } else {
            refreshAppUI();
        }
    }
}

window.createNewSubject = function () {
    const name = prompt("Enter new subject name:");
    if (!name) return;
    db.subjects.push({ id: generateId(), name });
    saveDb();
    refreshAppUI();
}

window.moveDocument = function (docId) {
    const doc = db.documents.find(d => d.id === docId);
    if (!doc) return;

    let promptText = "Enter the number of the subject to move this document to:\n";
    db.subjects.forEach((s, idx) => {
        promptText += `${idx + 1}. ${s.name}\n`;
    });

    const choice = prompt(promptText);
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (!isNaN(idx) && db.subjects[idx]) {
        doc.subjectId = db.subjects[idx].id;
        saveDb();
        refreshAppUI();
    } else {
        alert("Invalid subject selection.");
    }
}

window.getActiveDoc = function () {
    return db.documents.find(d => d.id === activeDocId);
}

window.showHomeView = function () {
    const activePlatform = localStorage.getItem("omnote_active_platform");
    if (activePlatform === "qbank") {
        if (window.openQBank) window.openQBank();
        return;
    }

    activeDocId = null;
    if (window.saveLastView) window.saveLastView({ docId: null, summaryTopic: null, leftTab: null, rightTab: null, mainTab: null });
    const homeView = document.getElementById('home-view');
    homeView.style.display = 'block';
    
    // Ensure QBank is hidden
    const qbView = document.getElementById('qbank-home-view');
    if (qbView) qbView.style.display = 'none';
    
    document.getElementById('workspace').style.display = 'none';
    const schedView = document.getElementById('scheduler-view');
    if (schedView) schedView.style.display = 'none';
    const statsView = document.getElementById('stats-view');
    if (statsView) statsView.style.display = 'none';
    const recallView = document.getElementById('recall-view');
    if (recallView) recallView.style.display = 'none';
    document.body.classList.remove('doc-open');
    document.body.classList.remove('scheduler-open');
    document.body.classList.remove('stats-open');
    document.body.classList.remove('recall-open');

    // Toggle empty state (no documents = big centered upload CTA)
    const hasDocs = db.documents && db.documents.length > 0;
    homeView.classList.toggle('home-empty', !hasDocs);
    document.body.classList.toggle('home-empty', !hasDocs);

    if (document.getElementById('top-doc-title-group')) document.getElementById('top-doc-title-group').style.display = 'none';
    const navTabs = document.getElementById('main-nav-tabs');
    if (navTabs) navTabs.style.display = 'none';


    const grid = document.getElementById('home-subjects-grid');
    if (grid) {
        grid.innerHTML = '';
        if (db.subjects) {
            db.subjects.forEach(subject => {
                const docs = db.documents.filter(d => d.subjectId === subject.id);
                if (docs.length === 0) return;

                const group = document.createElement('div');
                group.className = 'home-subject-label';
                const dot = document.createElement('span');
                dot.className = 'subj-dot';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'subj-name';
                nameSpan.textContent = subject.name || '';
                group.appendChild(dot);
                group.appendChild(nameSpan);
                grid.appendChild(group);

                docs.forEach((doc, dIdx) => {
                    const now = Date.now();
                    const dueCount = db.rems.filter(r => r.isFlashcard && !r.leech && (!r.nextReview || r.nextReview <= now) && r.docId === doc.id).length;

                    const card = document.createElement('div');
                    card.className = 'home-doc-card';
                    card.style.animationDelay = `${dIdx * 0.06}s`;
                    card.onclick = () => window.switchDocument(doc.id);

                    const initial = (doc.title || '?').trim().charAt(0).toUpperCase();
                    const esc = (window.escapeHTML || ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))));
                    const dueBadge = dueCount > 0 ? `<div class="due-badge"><i data-lucide="flame"></i> ${dueCount} Due</div>` : '';
                    card.innerHTML = `
                        <div class="doc-card-accent"></div>
                        <div class="doc-card-head">
                            <div class="doc-card-icon">${esc(initial)}</div>
                            ${dueBadge}
                            <button class="doc-card-delete" data-doc-id="${esc(doc.id)}" title="Delete Document"><i data-lucide="trash-2"></i></button>
                        </div>
                        <div class="doc-card-title"></div>
                        <div class="doc-card-meta">
                            <span class="meta-chip"><i data-lucide="calendar-days"></i> ${esc(new Date(doc.created).toLocaleDateString())}</span>
                        </div>
                    `;
                    const titleEl = card.querySelector('.doc-card-title');
                    if (titleEl) titleEl.textContent = doc.title || '';
                    const delBtn = card.querySelector('.doc-card-delete');
                    if (delBtn) delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); window.deleteDocument(doc.id); });
                    grid.appendChild(card);
                });
            });
        }
    }

    refreshAppUI();
}

window.switchDocument = function (docId) {
    activeDocId = docId;
    if (window.saveLastView) window.saveLastView({ docId, summaryTopic: null });

    document.getElementById('home-view').style.display = 'none';
    document.getElementById('workspace').style.display = 'flex';
    const schedView = document.getElementById('scheduler-view');
    if (schedView) schedView.style.display = 'none';
    const statsView = document.getElementById('stats-view');
    if (statsView) statsView.style.display = 'none';
    const recallView = document.getElementById('recall-view');
    if (recallView) recallView.style.display = 'none';
    document.body.classList.add('doc-open');
    document.body.classList.remove('scheduler-open');
    document.body.classList.remove('stats-open');
    document.body.classList.remove('recall-open');


    if (document.getElementById('top-doc-title-group')) document.getElementById('top-doc-title-group').style.display = 'block';
    const navTabs = document.getElementById('main-nav-tabs');
    if (navTabs) navTabs.style.display = 'flex';

    // Switch to notes view by default on new doc
    const leftTabs = document.querySelectorAll('#left-pane-tabs .left-tab-item');
    if (leftTabs.length >= 3) {
        window.switchLeftView('notes-view', leftTabs[2]);
    }

    if (window.restorePdfForActiveDoc) window.restorePdfForActiveDoc();


    const summaryContent = document.getElementById('summary-content');
    if (summaryContent) {
        summaryContent.innerHTML = '<div style="color: var(--text-muted); margin-top: 50px; text-align: center;">Click "Read Summary" on a topic in your Study Plan to generate a detailed summary.</div>';
    }

    refreshAppUI();
    if (window.renderAccordionSections) window.renderAccordionSections();
    window.closeSidebar && window.closeSidebar();
}

window.updateDocTitle = function (newTitle) {
    if (!activeDocId) return;
    const doc = db.documents.find(d => d.id === activeDocId);
    if (doc) {
        doc.title = newTitle;
        saveDb();
        refreshAppUI();
    }
}

function refreshAppUI() {
    // Render sidebar list
    const list = document.getElementById('document-list');
    if (list) {
        list.innerHTML = '';

        if (db.subjects) {
            window.subjectToggleState = window.subjectToggleState || {};
            
            db.subjects.forEach(subject => {
                const docs = db.documents.filter(d => d.subjectId === subject.id);
                const hasActiveDoc = docs.some(d => d.id === activeDocId);
                
                let isOpen = window.subjectToggleState[subject.id];
                if (isOpen === undefined) {
                    isOpen = hasActiveDoc; // Open by default if it contains the active doc, otherwise minimized
                    window.subjectToggleState[subject.id] = isOpen;
                }
                
                const subHeader = document.createElement('div');
                subHeader.className = 'sidebar-section-label';
                subHeader.style.marginTop = '15px';
                subHeader.style.cursor = 'pointer';
                subHeader.style.display = 'flex';
                subHeader.style.alignItems = 'center';
                subHeader.style.justifyContent = 'space-between';
                
                subHeader.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i data-lucide="folder"></i> <span>${window.escapeHTML ? window.escapeHTML(subject.name) : subject.name}</span>
                    </div>
                    <i data-lucide="${isOpen ? 'chevron-down' : 'chevron-right'}" style="width:14px;height:14px; opacity:0.5;"></i>
                `;
                list.appendChild(subHeader);

                const docsContainer = document.createElement('div');
                docsContainer.style.display = isOpen ? 'block' : 'none';
                
                subHeader.addEventListener('click', () => {
                    isOpen = !isOpen;
                    window.subjectToggleState[subject.id] = isOpen;
                    docsContainer.style.display = isOpen ? 'block' : 'none';
                    subHeader.querySelector('i:last-child').setAttribute('data-lucide', isOpen ? 'chevron-down' : 'chevron-right');
                    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
                });

                docs.forEach(doc => {
                    const now = Date.now();
                    const dueCount = db.rems.filter(r => r.isFlashcard && !r.leech && (!r.nextReview || r.nextReview <= now) && r.docId === doc.id).length;
                    const dueBadge = dueCount > 0 ? `<span style="background: rgba(244,63,94,0.15); color: var(--accent-rose); font-size: 0.65rem; padding: 2px 8px; border-radius: 10px; margin-left: 8px; font-weight: 700;">${dueCount}</span>` : '';

                    const item = document.createElement('div');
                    item.className = `doc-list-item ${doc.id === activeDocId ? 'active' : ''}`;
                    item.style.display = 'flex';
                    item.style.justifyContent = 'space-between';
                    item.style.alignItems = 'center';
                    const esc2 = (window.escapeHTML || ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))));
                    item.innerHTML = `
                        <div class="doc-list-open" style="flex:1; cursor:pointer;"><i data-lucide="file-text"></i> <span class="doc-list-title"></span>${dueBadge}</div>
                        <div style="display:flex; gap:8px; opacity:${doc.id === activeDocId ? 1 : 0.4};">
                            <button class="doc-list-move" style="background:transparent; border:none; color:var(--text-primary); cursor:pointer; font-size:1rem;" title="Move Document"><i data-lucide="folder"></i></button>
                            <button class="doc-list-delete" style="background:transparent; border:none; color:var(--text-muted); cursor:pointer; font-size:1rem;" title="Delete Document"><i data-lucide="trash-2"></i></button>
                        </div>
                    `;
                    const t = item.querySelector('.doc-list-title'); if (t) t.textContent = doc.title || '';
                    const openBtn = item.querySelector('.doc-list-open'); if (openBtn) openBtn.addEventListener('click', () => window.switchDocument(doc.id));
                    const mvBtn = item.querySelector('.doc-list-move'); if (mvBtn) mvBtn.addEventListener('click', () => window.moveDocument(doc.id));
                    const delBtn2 = item.querySelector('.doc-list-delete'); if (delBtn2) delBtn2.addEventListener('click', () => window.deleteDocument(doc.id));
                    docsContainer.appendChild(item);
                });
                
                list.appendChild(docsContainer);
            });
            if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        }
    }

    // Update Topbar and Note title
    const doc = db.documents.find(d => d.id === activeDocId);
    if (doc) {
        document.getElementById('top-doc-title').innerText = doc.title;
        const input = document.getElementById('doc-title-input');
        if (input) input.value = doc.title;
    }

    // Update Rems
    if (window.renderRems) window.renderRems();

    // Update stats
    const mastered = db.rems.filter(r => r.isFlashcard && r.ease >= 2.6 && r.docId === activeDocId).length;
    if (document.getElementById('stat-mastered')) document.getElementById('stat-mastered').innerText = mastered;

    // Calculate Study Stats
    if (db.studyStats && document.getElementById('stat-today')) {
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

        let todaySec = db.studyStats[todayStr] || 0;
        let weekSec = 0;
        let monthSec = 0;

        const dayMs = 24 * 60 * 60 * 1000;
        // Week starts on Sunday
        const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).getTime();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        for (const [dateStr, sec] of Object.entries(db.studyStats)) {
            const dateObj = new Date(dateStr);
            const t = dateObj.getTime();
            if (t >= startOfWeek) weekSec += sec;
            if (t >= startOfMonth) monthSec += sec;
        }

        const formatSecs = (s) => {
            const hrs = Math.floor(s / 3600);
            const mins = Math.floor((s % 3600) / 60);
            if (hrs > 0) return `${hrs}h ${mins}m`;
            return `${mins}m`;
        };

        document.getElementById('stat-today').innerText = formatSecs(todaySec);
        document.getElementById('stat-week').innerText = formatSecs(weekSec);
        document.getElementById('stat-month').innerText = formatSecs(monthSec);
    }

    updateSRSQueue();
}

// UI Switching (Left Pane) — Updated for new tab structure
window.switchLeftView = function (viewId, tabElement) {
    document.querySelectorAll('.left-view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('#left-pane-tabs .left-tab-item').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if (tabElement) tabElement.classList.add('active');
    document.body.classList.toggle('summary-active', viewId === 'summary-view');
    if (window.saveLastView) window.saveLastView({ leftTab: viewId });
}

// UI Switching (Right Pane)
window.switchRightView = function (viewId, tabElement) {
    document.querySelectorAll('.right-view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.right-tab-item').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if (tabElement) tabElement.classList.add('active');
    if (window.saveLastView) window.saveLastView({ rightTab: viewId });
}

// Main Nav Tabs (top center) — handles Study Plan, Summary, AI Tutor, Review
window.switchMainTab = function (tabName, tabElement) {
    // Update active state on nav tabs
    document.querySelectorAll('.main-nav-tab').forEach(el => el.classList.remove('active'));
    tabElement.classList.add('active');
    if (window.saveLastView) window.saveLastView({ mainTab: tabName });

    switch (tabName) {
        case 'study-plan':
            // Focus right pane on study plan
            window.switchRightView('learn-view', document.querySelectorAll('.right-tab-item')[1]);
            break;
        case 'summary':
            // Focus left pane on summary
            window.switchLeftView('summary-view', document.querySelectorAll('#left-pane-tabs .left-tab-item')[1]);
            break;
        case 'ai-tutor':
            // Focus right pane on AI tutor
            window.switchRightView('ai-view', document.querySelectorAll('.right-tab-item')[2]);
            break;
        case 'review':
            // Open review queue
            startReview();
            break;
    }
}

// Modals
window.openModal = function (id) { document.getElementById(id).classList.add('active'); }
window.closeModal = function (id) { document.getElementById(id).classList.remove('active'); }
window.openFullscreen = window.openFullscreen || function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
};
window.closeFullscreen = window.closeFullscreen || function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
    if (id === 'qbank-modal') {
        const sidebar = document.getElementById('qbank-sidebar');
        if (sidebar) sidebar.style.display = 'none';
    }
};

window.updateSRSQueue = function () {
    const now = Date.now();
    if (activeDocId) {
        const due = db.rems.filter(r => r.isFlashcard && r.docId === activeDocId && !r.leech && (!r.nextReview || r.nextReview <= now));
        const navLabel = document.getElementById('nav-review-label');
        if (navLabel) navLabel.innerText = `Review (${due.length})`;
    }
    const badge = document.getElementById('review-due-badge');
    if (badge) {
        const total = (window.srs && window.srs.dueCountAll) ? window.srs.dueCountAll()
            : db.rems.filter(r => r.isFlashcard && !r.leech && (!r.nextReview || r.nextReview <= now)).length;
        badge.textContent = total;
        badge.style.display = total > 0 ? 'inline-flex' : 'none';
    }
}

// Toggle study plan accordion
window.toggleAccordion = function (headerElement) {
    const item = headerElement.parentElement;
    item.classList.toggle('expanded');
}


window.addEventListener('DOMContentLoaded', () => {
    if (window.firebase && firebase.auth) {
        // Single listener: re-init ONLY when the signed-in user actually
        // changes (sign-in / sign-out / account switch). Firebase also fires
        // onAuthStateChanged on silent token refreshes for the SAME user —
        // re-running initApp there reloads window.db from the cloud snapshot
        // and reverts just-made local changes (e.g. a bank switch whose
        // cloud write hasn't landed yet), besides racing in-flight loads.
        let booted = false;
        window.__initUid = undefined;
        firebase.auth().onAuthStateChanged(user => {
            const uid = user ? user.uid : null;
            if (!booted) {
                booted = true;
                window.__initUid = uid;
                initApp(user);
                return;
            }
            if (uid !== window.__initUid) {
                window.__initUid = uid;
                initApp(user);
            }
        });
    } else {
        initApp(null);
    }
});

// CSV Upload Logic
window.handleCsvUpload = function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        
        const parseCSV = (str) => {
            const result = [];
            let row = [];
            let inQuotes = false;
            let val = '';
            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '"') {
                    if (inQuotes && str[i+1] === '"') {
                        val += '"'; // escaped quote
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (char === '|' && !inQuotes) {
                    row.push(val);
                    val = '';
                } else if ((char === '\n' || char === '\r') && !inQuotes) {
                    if (char === '\r' && str[i+1] === '\n') i++;
                    row.push(val);
                    result.push(row);
                    row = [];
                    val = '';
                } else {
                    val += char;
                }
            }
            if (val || row.length > 0) {
                row.push(val);
                result.push(row);
            }
            return result;
        };

        const rows = parseCSV(text);
        
        const docId = generateId();
        const subjectId = db.subjects && db.subjects.length > 0 ? db.subjects[0].id : 's1';
        const docTitle = file.name.replace('.csv', '');
        
        db.documents.push({ id: docId, title: docTitle, created: Date.now(), pdfContextText: "", sections: [], subjectId });
        
        let count = 0;
        rows.forEach(parts => {
            // Filter empty rows
            if (parts.length === 1 && !parts[0].trim()) return;
            
            if (parts.length >= 2) {
                const front = parts[0].trim();
                const back = parts.slice(1).join('|').trim();
                if (front || back) {
                    window.addRem(docId, `${front} == ${back}`, 0);
                    count++;
                }
            } else if (parts.length === 1) {
                // Just a note
                if (parts[0].trim()) {
                    window.addRem(docId, parts[0].trim(), 0);
                    count++;
                }
            }
        });
        
        if (count === 0) {
            window.addRem(docId, "No valid flashcards found in CSV.", 0);
        }
        
        saveDb();
        window.switchDocument(docId);
        event.target.value = '';
    };
    reader.readAsText(file);
}

// Auth Logic
window.openAuthModal = function () {
    window.openModal('auth-modal');
}

// Auth Logic
window.handleLogin = async function () {
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-password').value;
    const err = document.getElementById('auth-error');
    err.style.display = 'none';

    try {
        await firebase.auth().signInWithEmailAndPassword(email, pass);
        initApp(firebase.auth().currentUser);
    } catch (e) {
        err.innerText = e.message;
        err.style.display = 'block';
    }
}

window.handleRegister = async function () {
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-password').value;
    const nameEl = document.getElementById('auth-name');
    const name = (nameEl && nameEl.value || '').trim();
    const err = document.getElementById('auth-error');
    err.style.display = 'none';

    if (name.length < 2) {
        err.innerText = 'Please enter your name (at least 2 characters).';
        err.style.display = 'block';
        return;
    }

    try {
        const cred = await firebase.auth().createUserWithEmailAndPassword(email, pass);
        try { await cred.user.updateProfile({ displayName: name }); } catch (e) {}
        // New users start in light mode.
        localStorage.setItem('omnote_theme', 'light');
        document.body.classList.add('app-light-mode');
        document.body.classList.remove('dark-exam');
        const themeBtn = document.getElementById('theme-toggle-btn');
        if (themeBtn) { themeBtn.innerHTML = '<i data-lucide="moon"></i>'; window.lucide && window.lucide.createIcons(); }
        // Migration logic
        const localData = localStorage.getItem('omnote_db_v2');
        if (localData) {
            db = JSON.parse(localData);
            saveDb();
        }
        initApp(firebase.auth().currentUser);
        alert("Account created!");
    } catch (e) {
        err.innerText = e.message;
        err.style.display = 'block';
    }
}

window.handleGoogleSignIn = async function () {
    const err = document.getElementById('auth-error');
    if (err) err.style.display = 'none';
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const result = await firebase.auth().signInWithPopup(provider);
        const isNew = result.additionalUserInfo && result.additionalUserInfo.isNewUser;
        if (isNew) {
            localStorage.setItem('omnote_theme', 'light');
            document.body.classList.add('app-light-mode');
            document.body.classList.remove('dark-exam');
            const themeBtn = document.getElementById('theme-toggle-btn');
            if (themeBtn) { themeBtn.innerHTML = '<i data-lucide="moon"></i>'; window.lucide && window.lucide.createIcons(); }
            const localData = localStorage.getItem('omnote_db_v2');
            if (localData) { db = JSON.parse(localData); saveDb(); }
        }
        initApp(firebase.auth().currentUser);
    } catch (e) {
        if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
        if (err) { err.innerText = (e && e.message) || 'Google sign-in failed.'; err.style.display = 'block'; }
    }
}

window.handleLogout = async function () {
    await firebase.auth().signOut();
    initApp(null);
}


// Global Loading Screen Logic
let loadingInterval = null;
const funMessages = [
    "Brewing some intelligence...",
    "Reading the whole textbook in 3 seconds...",
    "Double-checking the facts...",
    "Cross-referencing the universe...",
    "Analyzing semantic structures...",
    "Reticulating splines...",
    "Connecting the neural pathways...",
    "Synthesizing knowledge...",
    "Preparing your premium study materials..."
];

window.showLoadingScreen = function(title = "Generating...") {
    const overlay = document.getElementById('global-loading-overlay');
    const titleEl = document.getElementById('loading-title');
    const textEl = document.getElementById('loading-text');
    const progressFill = document.querySelector('.progress-bar-fill');
    
    if(!overlay || !titleEl || !textEl || !progressFill) return;
    
    titleEl.innerText = title;
    overlay.style.display = 'flex';
    
    // Simulate progress bar
    progressFill.style.width = '0%';
    setTimeout(() => progressFill.style.width = '30%', 100);
    setTimeout(() => progressFill.style.width = '70%', 3000);
    setTimeout(() => progressFill.style.width = '90%', 8000);
    
    let msgIndex = 0;
    textEl.style.opacity = 0;
    setTimeout(() => {
        textEl.innerText = funMessages[msgIndex];
        textEl.style.opacity = 1;
    }, 300);

    if(loadingInterval) clearInterval(loadingInterval);
    loadingInterval = setInterval(() => {
        textEl.style.opacity = 0;
        setTimeout(() => {
            msgIndex = (msgIndex + 1) % funMessages.length;
            textEl.innerText = funMessages[msgIndex];
            textEl.style.opacity = 1;
        }, 300);
    }, 3500);
}

window.hideLoadingScreen = function() {
    const overlay = document.getElementById('global-loading-overlay');
    const progressFill = document.querySelector('.progress-bar-fill');
    
    if(!overlay || !progressFill) return;
    
    if(loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
    
    progressFill.style.width = '100%';
    setTimeout(() => {
        overlay.style.display = 'none';
        progressFill.style.width = '0%';
    }, 300);
}

// Settings Modal Logic
window.openApiSettingsModal = function() {
    window.renderApiKeysList();
    window.openModal('api-settings-modal');
}

window.renderApiKeysList = function() {
    const listEl = document.getElementById('api-keys-list');
    if (!listEl) return;
    
    // Using global GEMINI_API_KEYS from ai.js
    if (!window.GEMINI_API_KEYS || window.GEMINI_API_KEYS.length === 0 || (window.GEMINI_API_KEYS.length === 1 && window.GEMINI_API_KEYS[0] === "")) {
        listEl.innerHTML = '<div style="color:var(--text-muted); font-size: 0.85rem;">No API keys added yet.</div>';
        return;
    }

    listEl.innerHTML = '';
    window.GEMINI_API_KEYS.forEach((key, index) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '10px';
        item.style.background = 'rgba(255,255,255,0.03)';
        item.style.border = '1px solid var(--border-medium)';
        item.style.borderRadius = '6px';
        
        const keyDisplay = document.createElement('div');
        keyDisplay.style.fontFamily = 'monospace';
        keyDisplay.style.fontSize = '0.85rem';
        keyDisplay.innerText = key.length > 15 ? key.substring(0, 10) + '...' + key.substring(key.length - 4) : key;
        
        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '8px';
        
        const testBtn = document.createElement('button');
        testBtn.innerText = 'Test';
        testBtn.className = 'btn-dark-pill';
        testBtn.onclick = () => window.handleTestApiKey(key, index);
        
        const delBtn = document.createElement('button');
        delBtn.innerText = 'Delete';
        delBtn.className = 'btn-dark-pill';
        delBtn.style.color = 'var(--accent-rose)';
        delBtn.onclick = () => window.handleRemoveApiKey(index);
        
        btnGroup.appendChild(testBtn);
        btnGroup.appendChild(delBtn);
        
        item.appendChild(keyDisplay);
        item.appendChild(btnGroup);
        
        listEl.appendChild(item);
    });
}

window.handleAddApiKey = function() {
    const input = document.getElementById('new-api-key-input');
    const resultEl = document.getElementById('api-key-test-result');
    const val = input.value.trim();
    if (!val) return;
    
    if (window.addApiKey(val)) {
        input.value = '';
        window.renderApiKeysList();
        resultEl.innerText = "Key added successfully.";
        resultEl.style.color = "var(--accent-emerald)";
    } else {
        resultEl.innerText = "Key already exists.";
        resultEl.style.color = "var(--accent-rose)";
    }
}

window.handleRemoveApiKey = function(index) {
    if (confirm("Remove this API key?")) {
        window.removeApiKey(index);
        window.renderApiKeysList();
        document.getElementById('api-key-test-result').innerText = '';
    }
}

window.handleTestApiKey = async function(key, index) {
    const resultEl = document.getElementById('api-key-test-result');
    resultEl.innerText = `Testing key #${index + 1}...`;
    resultEl.style.color = "var(--text-secondary)";
    
    const res = await window.testApiKey(key);
    if (res.success) {
        resultEl.innerText = `Key #${index + 1} is working correctly!`;
        resultEl.style.color = "var(--accent-emerald)";
    } else {
        resultEl.innerText = `Key #${index + 1} failed: ${res.message}`;
        resultEl.style.color = "var(--accent-rose)";
    }
}

// ============================================================
// Global Theme Toggle Logic (Light / Dark Mode)
// Single source of truth: keeps every legacy convention in sync
//   dark  -> html.dark + body.dark + body.dark-exam
//   light -> body.app-light-mode
// ============================================================
window.applyAppTheme = function (theme) {
    const isDark = theme === 'dark';
    const html = document.documentElement;
    const body = document.body;
    html.classList.toggle('dark', isDark);
    if (body) {
        body.classList.toggle('dark', isDark);
        body.classList.toggle('dark-exam', isDark);
        body.classList.toggle('app-light-mode', !isDark);
    }
    try { localStorage.setItem('omnote_theme', isDark ? 'dark' : 'light'); } catch (e) {}
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
        btn.innerHTML = isDark ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
        window.lucide && window.lucide.createIcons();
    }
    return isDark;
};

window.getAppTheme = function () {
    try { return localStorage.getItem('omnote_theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; }
};

window.toggleAppTheme = function () {
    window.applyAppTheme(window.getAppTheme() === 'dark' ? 'light' : 'dark');
};

window.addEventListener('DOMContentLoaded', () => {
    // Default to LIGHT mode when the user has no saved preference.
    window.applyAppTheme(window.getAppTheme());
});

// Profile circle: show user photo, custom base64 avatar, or initial letter
window.updateProfileCircle = function (user) {
    const u = user || (window.firebase && firebase.auth && firebase.auth().currentUser);
    if (!u) return;
    
    // Update the real name and role (if those elements exist elsewhere)
    const headerName = document.getElementById('header-user-name');
    if (headerName) headerName.textContent = u.displayName || u.email || 'Student';
    
    const headerRole = document.getElementById('header-user-role');
    if (headerRole) headerRole.textContent = 'Medical Student';

    const btn = document.getElementById('profile-circle-btn');
    if (btn) {
        const name = (u.displayName || u.email || '?').trim();
        const letter = name.charAt(0).toUpperCase() || 'U';
        let customAvatarUrl = (window.db && window.db.settings && window.db.settings.customAvatar) || u.photoURL;
        if (customAvatarUrl && customAvatarUrl.includes('/app/avatars/')) {
            customAvatarUrl = null;
        }
        
        btn.innerHTML = '';
        if (customAvatarUrl) {
            const img = document.createElement('img');
            img.src = customAvatarUrl;
            img.className = 'w-full h-full object-cover';
            img.addEventListener('error', () => {
                btn.innerHTML = `<span>${letter}</span>`;
            });
            btn.appendChild(img);
        } else {
            btn.innerHTML = `<span>${letter}</span>`;
        }
        btn.setAttribute('title', (u.displayName || u.email || 'Profile Settings'));
    }

    try {
        const nameEl = document.getElementById('home-title-name');
        if (nameEl) {
            const first = ((u.displayName || '').trim().split(/\s+/)[0]) || '';
            nameEl.textContent = first ? ', ' + first : '';
        }
    } catch (e) {}
};

try {
    if (window.firebase && firebase.auth) {
        firebase.auth().onAuthStateChanged(u => {
            if (u) {
                window.updateProfileCircle(u);
                if (typeof window.renderTopbarCreditChip === 'function') window.renderTopbarCreditChip();
            }
        });
    }
} catch (e) {}



// Per-bank DRM: keys live in server env only, fetched per bank via
// POST /api/qbank_key (auth + access-checked, rate-limited, logged) and held
// in memory ONLY — never localStorage/IndexedDB. No hardcoded key anywhere.
window.__qbankKeys = window.__qbankKeys || {};

window.getAppCheckToken = async function() {
    try {
        if (window.firebase && firebase.appCheck) {
            const ac = firebase.appCheck();
            if (ac && typeof ac.getToken === "function") {
                const t = await ac.getToken(false);
                const tok = (t && t.token) || (typeof t === "string" ? t : null);
                if (tok) return tok;
            }
        }
    } catch (_) {}
    return null;
};

window.qbankAuthHeaders = async function(extra) {
    const h = Object.assign({}, extra || {});
    try {
        const u = window.firebase && firebase.auth().currentUser;
        if (u) {
            const token = await u.getIdToken();
            if (token) h["Authorization"] = "Bearer " + token;
        }
        const ac = await window.getAppCheckToken();
        if (ac) h["X-Firebase-AppCheck"] = ac;
    } catch (_) {}
    return h;
};

window.getQBankKey = async function(qbankId) {
    if (!qbankId) throw new Error("Missing qbankId");
    if (window.__qbankKeys[qbankId]) return window.__qbankKeys[qbankId];
    if (!window.__qbankKeyPending) window.__qbankKeyPending = {};
    if (window.__qbankKeyPending[qbankId]) return window.__qbankKeyPending[qbankId];
    const p = (async () => {
        const headers = await window.qbankAuthHeaders({ "Content-Type": "application/json" });
        const res = await fetch("/api/qbank_key", {
            method: "POST",
            headers,
            body: JSON.stringify({ qbankId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        if (!data.key) throw new Error("Key missing");
        // Memory only — never persisted.
        window.__qbankKeys[qbankId] = data.key;
        return data.key;
    })();
    window.__qbankKeyPending[qbankId] = p;
    try {
        return await p;
    } finally {
        delete window.__qbankKeyPending[qbankId];
    }
};

window.decryptDRM = async function(base64Str, keyStr) {
    if (!keyStr) throw new Error("decryptDRM: per-bank key required (fetch via getQBankKey)");
    const binary_string = atob(base64Str);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
    const iv = bytes.slice(0, 12);
    const data = bytes.slice(12);
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keyStr);
    const key = await crypto.subtle.importKey("raw", keyData, { name: "AES-GCM" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(decrypted);
};

window.decryptQBankPayload = async function(encrypted, qbankId) {
    const key = await window.getQBankKey(qbankId);
    return window.decryptDRM(encrypted, key);
};

// Auto-render Lucide icons whenever new [data-lucide] nodes are inserted.
(function () {
    if (!('MutationObserver' in window)) return;
    let scheduled = false;
    const flush = () => {
        scheduled = false;
        try { window.lucide && window.lucide.createIcons(); } catch (e) {}
    };
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        (window.requestAnimationFrame || setTimeout)(flush, 16);
    };
    const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1 && (n.matches?.('[data-lucide]') || n.querySelector?.('[data-lucide]'))) {
                    schedule(); return;
                }
            }
        }
    });
    const start = () => obs.observe(document.body, { childList: true, subtree: true });
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
    // Initial pass.
    document.addEventListener('DOMContentLoaded', () => { try { window.lucide && window.lucide.createIcons(); } catch (e) {} });
})();
