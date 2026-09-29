// OmNote i18n — unified site language (UI + AI content).
// Replaces the old split interface/ai language system.
(function () {
    const LS_KEY = 'omnote_site_language';

    const LANGS = {
        en: { name: 'English', native: 'English', flag: '🇬🇧', rtl: false, ocr: 'eng' },
        ar: { name: 'Arabic', native: 'العربية', flag: '🇸🇦', rtl: true, ocr: 'ara' },
        fr: { name: 'French', native: 'Français', flag: '🇫🇷', rtl: false, ocr: 'fra' },
    };

    // Country → default language mapping
    const COUNTRY_LANG = {
        tunisia: 'fr',
        algeria: 'fr',
        morocco: 'fr',
        egypt: 'ar',
    };

    window.OMNOTE_LANGS = LANGS;
    window.OMNOTE_COUNTRY_LANG = COUNTRY_LANG;

    // ----- Unified language getter/setter -----
    window.getSiteLanguage = function () {
        try {
            if (window.db && window.db.settings && window.db.settings.siteLanguage && LANGS[window.db.settings.siteLanguage]) {
                return window.db.settings.siteLanguage;
            }
        } catch (e) {}
        const stored = localStorage.getItem(LS_KEY);
        if (stored && LANGS[stored]) return stored;
        return 'en';
    };

    window.setSiteLanguage = function (lang) {
        if (!LANGS[lang]) return;
        localStorage.setItem(LS_KEY, lang);
        try {
            if (window.db) {
                if (!window.db.settings) window.db.settings = {};
                window.db.settings.siteLanguage = lang;
                if (typeof saveDb === 'function') saveDb();
            }
        } catch (e) {}
        applyLanguageToUI(lang);
        // Reload so ui-i18n.js re-translates and RTL layout applies
        setTimeout(() => location.reload(), 150);
    };

    // Legacy aliases (kept for backward compat during transition)
    window.getUserLanguage = window.getSiteLanguage;
    window.setUserLanguage = window.setSiteLanguage;

    // ----- AI content helpers (unchanged behavior) -----
    window.getLangInstruction = function () {
        const lang = window.getSiteLanguage();
        const info = LANGS[lang];
        const rtlNote = info.rtl ? ' Ensure the layout works well with RTL text mixed with LTR technical terms.' : '';
        return `\n\nLANGUAGE REQUIREMENT: Write your entire response in ${info.name} (${info.native}). Keep all technical, medical, anatomical, or scientific terms and proper nouns in English; do not translate them.${rtlNote}`;
    };

    window.getOcrLangCode = function () {
        const lang = window.getSiteLanguage();
        return LANGS[lang].ocr;
    };

    // ----- Apply to UI -----
    function applyLanguageToUI(lang) {
        const info = LANGS[lang];
        if (!info) return;
        document.documentElement.setAttribute('data-user-lang', lang);
        document.documentElement.setAttribute('data-ui-lang', lang);
        document.documentElement.setAttribute('lang', lang);
        document.documentElement.setAttribute('dir', info.rtl ? 'rtl' : 'ltr');
        // Force reflow for RTL to take effect
        document.body.style.display = 'none';
        document.body.offsetHeight;
        document.body.style.display = '';
    }

    // ----- Profile settings modal -----
    function ensureModals() {
        if (document.getElementById('profile-settings-modal')) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = `
        <div id="profile-settings-modal" class="fixed inset-0 z-50 items-center justify-center bg-black/50 backdrop-blur-sm" style="display:none; font-family: 'Inter', sans-serif;">
            <div class="bg-surface-container-lowest w-full max-w-3xl rounded-3xl shadow-2xl flex flex-col border border-outline-variant/30 max-h-[90vh] m-4 overflow-hidden">
                <div class="px-8 py-6 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container/20">
                    <div>
                        <h2 class="text-2xl font-bold text-on-surface">Profile Settings</h2>
                        <div class="text-sm text-on-surface-variant mt-1" id="profile-header-email"></div>
                    </div>
                    <button class="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center text-on-surface hover:bg-outline-variant/30 transition-colors" id="profile-cancel-btn-x" style="border-radius: 50%;">
                        <i data-lucide="x"></i>
                    </button>
                </div>

                <div class="p-8 overflow-y-auto flex-1 flex flex-col gap-6">
                    <section class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-6">
                        <div class="mb-4">
                            <h3 class="text-lg font-bold text-on-surface">Display Name</h3>
                            <p class="text-sm text-on-surface-variant">Shown across the app and on your profile.</p>
                        </div>
                        <input type="text" id="profile-name-input" class="w-full bg-surface-container border border-outline-variant/50 rounded-xl px-4 py-3 text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors" maxlength="40" placeholder="Your name" />
                    </section>

                    <section class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-6">
                        <div class="mb-4">
                            <h3 class="text-lg font-bold text-on-surface">Custom Avatar</h3>
                            <p class="text-sm text-on-surface-variant">Upload a square image to be used as your avatar.</p>
                        </div>
                        <div class="flex items-center gap-6">
                            <div id="profile-avatar-preview" class="w-20 h-20 rounded-full bg-[#007a7a] text-white flex items-center justify-center font-bold text-2xl uppercase border-2 border-primary/20 overflow-hidden shrink-0 shadow-sm" style="border-radius: 50%;">
                                <span>U</span>
                            </div>
                            <div class="flex-1">
                                <input type="file" id="profile-avatar-upload" accept="image/*" class="hidden" />
                                <button class="px-5 py-2.5 rounded-xl bg-surface-container-highest text-on-surface font-semibold hover:bg-outline-variant/30 transition-colors" onclick="document.getElementById('profile-avatar-upload').click();">
                                    <i data-lucide="upload" class="inline-block w-4 h-4 mr-2 -mt-1"></i> Upload Image
                                </button>
                                <button class="px-4 py-2.5 rounded-xl text-error font-medium hover:bg-error/10 transition-colors ml-2" id="profile-avatar-remove">
                                    Remove
                                </button>
                                <p class="text-xs text-on-surface-variant mt-3">Recommended size: 256x256px. Image will be automatically compressed.</p>
                            </div>
                        </div>
                    </section>

                    <section class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-6">
                        <div class="mb-4">
                            <h3 class="text-lg font-bold text-on-surface">Site Language</h3>
                            <p class="text-sm text-on-surface-variant">Translates buttons, menus, labels, and AI content across the app.</p>
                        </div>
                        <div class="omn-lang-grid" id="profile-lang-grid"></div>
                    </section>

                    <section class="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-6">
                        <div class="mb-4">
                            <h3 class="text-lg font-bold text-on-surface">Account</h3>
                            <p class="text-sm text-on-surface-variant" id="profile-verify-status">Verify your email to unlock AI features.</p>
                        </div>
                        <button class="px-5 py-2.5 rounded-xl bg-surface-container-highest text-on-surface font-semibold hover:bg-outline-variant/30 transition-colors" id="profile-resend-verify-btn">Resend verification email</button>
                    </section>
                </div>

                <div class="px-8 py-5 border-t border-outline-variant/30 bg-surface-container/10 flex justify-end gap-3">
                    <button class="px-6 py-2.5 rounded-xl text-on-surface font-semibold hover:bg-surface-container-highest transition-colors" id="profile-cancel-btn">Cancel</button>
                    <button class="px-6 py-2.5 rounded-xl bg-primary text-on-primary font-bold hover:opacity-90 shadow-sm transition-opacity" id="profile-save-btn">Save Changes</button>
                </div>
            </div>
        </div>`;

        document.body.appendChild(wrap);

        function buildGrid(id, current, onPick) {
            const grid = document.getElementById(id);
            grid.innerHTML = '';
            Object.keys(LANGS).forEach(code => {
                const info = LANGS[code];
                const btn = document.createElement('button');
                btn.className = 'omn-lang-opt' + (code === current ? ' selected' : '');
                btn.dataset.code = code;
                btn.innerHTML = `<span class="omn-lang-flag">${info.flag}</span><span class="omn-lang-name">${info.native}</span><span class="omn-lang-en">${info.name}</span>`;
                btn.onclick = () => {
                    grid.querySelectorAll('.omn-lang-opt').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    onPick(code);
                };
                grid.appendChild(btn);
            });
        }

        // File uploader logic
        const fileInput = document.getElementById('profile-avatar-upload');
        const removeBtn = document.getElementById('profile-avatar-remove');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        canvas.width = 128;
                        canvas.height = 128;
                        const minSize = Math.min(img.width, img.height);
                        const sx = (img.width - minSize) / 2;
                        const sy = (img.height - minSize) / 2;
                        ctx.drawImage(img, sx, sy, minSize, minSize, 0, 0, 128, 128);
                        pendingAvatar = canvas.toDataURL('image/jpeg', 0.8);
                        updateAvatarPreview();
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                pendingAvatar = null;
                updateAvatarPreview();
            });
        }

        function updateAvatarPreview() {
            const preview = document.getElementById('profile-avatar-preview');
            if (!preview) return;
            if (pendingAvatar) {
                preview.innerHTML = `<img src="${pendingAvatar}" class="w-full h-full object-cover" />`;
            } else {
                let letter = 'U';
                const nameEl = document.getElementById('profile-name-input');
                if (nameEl && nameEl.value.trim().length > 0) {
                    letter = nameEl.value.trim().charAt(0).toUpperCase();
                } else if (pendingName && pendingName.length > 0) {
                    letter = pendingName.charAt(0).toUpperCase();
                } else {
                    try {
                        const u = firebase.auth().currentUser;
                        if (u && u.email) letter = u.email.charAt(0).toUpperCase();
                    } catch (e) {}
                }
                preview.innerHTML = `<span>${letter}</span>`;
            }
        }

        let pendingProfile = null;
        let pendingAvatar = null;
        let pendingName = null;
        const closeProfile = () => { document.getElementById('profile-settings-modal').style.display = 'none'; };
        document.getElementById('profile-cancel-btn').onclick = closeProfile;
        const xBtn = document.getElementById('profile-cancel-btn-x');
        if (xBtn) xBtn.onclick = closeProfile;
        document.getElementById('profile-settings-modal').addEventListener('click', (e) => {
            if (e.target && e.target.id === 'profile-settings-modal') closeProfile();
        });

        document.getElementById('profile-save-btn').onclick = async () => {
            const saveBtn = document.getElementById('profile-save-btn');
            const nameEl = document.getElementById('profile-name-input');
            const newName = (nameEl && nameEl.value || '').trim();
            try {
                const u = firebase.auth && firebase.auth().currentUser;
                if (u) {
                    const patch = {};
                    let nameChanged = false;
                    let avatarChanged = false;
                    if (newName && newName !== (u.displayName || '')) {
                        patch.displayName = newName;
                        nameChanged = true;
                    }
                    if (window.db && window.db.settings) {
                        if (window.db.settings.customAvatar !== pendingAvatar) {
                            window.db.settings.customAvatar = pendingAvatar;
                            avatarChanged = true;
                            if (typeof saveDb === 'function') saveDb();
                        }
                    }
                    if (Object.keys(patch).length) {
                        saveBtn.disabled = true;
                        saveBtn.innerHTML = '<i data-lucide="loader" class="animate-spin w-4 h-4 mr-2 inline"></i> Saving...';
                        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
                        await u.updateProfile(patch);
                    }
                    if (nameChanged || avatarChanged) {
                        if (typeof window.updateProfileCircle === 'function') window.updateProfileCircle(u);
                    }
                }
            } catch (e) { /* ignore */ }
            saveBtn.disabled = false;
            if (pendingProfile) window.setSiteLanguage(pendingProfile);
            document.getElementById('profile-settings-modal').style.display = 'none';
        };

        window.openProfileSettings = function () {
            const cur = window.getSiteLanguage();
            pendingProfile = cur;
            buildGrid('profile-lang-grid', cur, code => { pendingProfile = code; });
            try {
                const u = firebase.auth().currentUser;
                const nameEl = document.getElementById('profile-name-input');
                if (nameEl) {
                    nameEl.value = (u && u.displayName) || '';
                    nameEl.addEventListener('input', updateAvatarPreview);
                }
                pendingName = (u && u.displayName) || '';
                pendingAvatar = (window.db && window.db.settings && window.db.settings.customAvatar) || null;
                updateAvatarPreview();
            } catch (e) {}
            try {
                const u = firebase.auth().currentUser;
                const emailEl = document.getElementById('profile-header-email');
                if (emailEl) emailEl.textContent = (u && (u.email || u.displayName)) || '';
                const statusEl = document.getElementById('profile-verify-status');
                const btn = document.getElementById('profile-resend-verify-btn');
                if (u && statusEl && btn) {
                    if (u.emailVerified) {
                        statusEl.textContent = 'Your email is verified.';
                        btn.style.display = 'none';
                    } else {
                        statusEl.textContent = 'Your email is not verified. Verify to unlock AI features.';
                        btn.style.display = '';
                        btn.disabled = false;
                        btn.textContent = 'Resend verification email';
                        btn.onclick = async () => {
                            btn.disabled = true;
                            btn.textContent = 'Sending...';
                            try {
                                await u.sendEmailVerification();
                                btn.textContent = 'Sent — check your inbox';
                                statusEl.textContent = 'Verification email sent to ' + (u.email || 'your address') + '. After clicking the link, refresh the page.';
                            } catch (e) {
                                btn.disabled = false;
                                btn.textContent = 'Resend verification email';
                                statusEl.textContent = 'Could not send: ' + (e && e.message ? e.message : 'try again in a minute.');
                            }
                        };
                    }
                }
            } catch (e) {}
            if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
            document.getElementById('profile-settings-modal').style.display = 'flex';
        };
    }

    window.i18nInit = function () {
        ensureModals();
        const current = window.getSiteLanguage();
        applyLanguageToUI(current);
    };

    document.addEventListener('DOMContentLoaded', ensureModals);
})();
