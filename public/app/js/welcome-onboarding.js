// Welcome screen — shown once after login to any signed-in user whose profile
// has no country (covers new signups AND pre-existing registered users).
// Collects name, country, and language.
(function () {
  const COUNTRIES = [
    { value: "egypt",   label: "Egypt",         flag: "eg" },
    { value: "tunisia", label: "Tunisia",       flag: "tn" },
    { value: "algeria", label: "Algeria",       flag: "dz" },
    { value: "morocco", label: "Morocco",       flag: "ma" },
    { value: "saudi",   label: "Saudi Arabia",  flag: "sa" },
    { value: "global",  label: "International", flag: null },
  ];

  const LANGUAGES = [
    { value: "en", label: "English" },
    { value: "fr", label: "Français" },
    { value: "ar", label: "العربية" },
  ];

  // Country → default language mapping
  const COUNTRY_LANG = {
    tunisia: 'fr',
    algeria: 'fr',
    morocco: 'fr',
    egypt: 'ar',
    saudi: 'ar',
    global: 'en',
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  window.ensureCountryProfile = async function (user) {
    if (!user) return false;
    try {
      const fsdb = firebase.firestore();
      const snap = await fsdb.collection("users_index").doc(user.uid).get();
      const country = (snap.exists && snap.data().country) || "";
      if (country) return true; // already onboarded

      return await new Promise((resolve) => {
        showWelcomeOverlay(user, async (name, countryValue, languageValue) => {
          try {
            await fsdb.collection("users_index").doc(user.uid).set(
              {
                country: countryValue,
                language: languageValue,
                displayName: name,
                email: (user.email || "").toLowerCase(),
                qbankGrants: [],
              },
              { merge: true }
            );
            try {
              await fsdb.collection("users").doc(user.uid).set(
                { country: countryValue, language: languageValue, qbankGrants: [] },
                { merge: true }
              );
            } catch (_) {}
            
            // Save language to local storage for instant application
            localStorage.setItem('omnote_lang', languageValue);
            
            resolve(true);
          } catch (e) {
            alert("Could not save your profile: " + (e.message || e));
            resolve(false);
          }
        });
      });
    } catch (e) {
      console.warn("ensureCountryProfile failed", e);
      return true; // never lock the user out on a transient error
    }
  };

  function showWelcomeOverlay(user, onSubmit) {
    const old = document.getElementById("welcome-onboarding");
    if (old) old.remove();

    const el = document.createElement("div");
    el.id = "welcome-onboarding";
    el.innerHTML = `
      <div class="wo-layout">
        <!-- Left Side: Dashboard Aesthetic Hero -->
        <div class="wo-hero">
          <div class="wo-ambient-1"></div>
          <div class="wo-ambient-2"></div>
          
          <div class="wo-hero-content">
            <div class="wo-brand-hero">
              <div class="wo-logo-hero"><i class="fa-solid fa-sparkles"></i></div>
              <span>CuraQ Workspace</span>
            </div>
            
            <h1 class="wo-hero-title">Personalize your study experience.</h1>
            <p class="wo-hero-desc">Tell us a bit about yourself. We'll optimize your workspace, language settings, and AI models to help you master medical concepts faster.</p>
            
            <div class="wo-hero-proof">
              <div class="wo-proof-avatars">
                <div class="wo-avatar"><i class="fa-solid fa-user"></i></div>
                <div class="wo-avatar"><i class="fa-solid fa-user-md"></i></div>
                <div class="wo-avatar"><i class="fa-solid fa-user-nurse"></i></div>
              </div>
              <p>Join thousands of med students globally.</p>
            </div>
          </div>
        </div>

        <!-- Right Side: Form -->
        <div class="wo-form-area">
          <div class="wo-card">
            <h2 class="wo-title">Welcome aboard!</h2>
            <p class="wo-sub">Let's set up your account preferences.</p>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-regular fa-user"></i> How should we call you?</label>
              <input id="wo-name" class="wo-input" type="text" maxlength="60"
                     placeholder="e.g. Dr. House or John" value="${esc(user.displayName || "")}" />
            </div>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-solid fa-globe"></i> Where are you studying?</label>
              <div class="wo-grid" id="wo-country-grid">
                ${COUNTRIES.map(c => `
                  <button type="button" class="wo-btn-opt wo-country" data-value="${c.value}">
                    ${c.flag ? `<img src="https://flagcdn.com/${c.flag}.svg" alt="" />` : `<span class="wo-globe">🌍</span>`}
                    <span>${esc(c.label)}</span>
                  </button>`).join("")}
              </div>
              <p class="wo-help-text">This helps us tailor medical guidelines to your region.</p>
            </div>

            <div class="wo-form-group">
              <label class="wo-label"><i class="fa-solid fa-language"></i> Preferred Language</label>
              <div class="wo-grid" id="wo-lang-grid">
                ${LANGUAGES.map(l => `
                  <button type="button" class="wo-btn-opt wo-lang" data-value="${l.value}">
                    <span>${esc(l.label)}</span>
                  </button>`).join("")}
              </div>
            </div>

            <div class="wo-err" id="wo-err"></div>
            <button id="wo-continue" class="wo-continue" disabled>
              Complete Setup <i class="fa-solid fa-arrow-right"></i>
            </button>
          </div>
        </div>
      </div>
      <style>${CSS}</style>`;
    document.body.appendChild(el);

    let chosenCountry = "";
    let chosenLang = "";

    const cGrid = el.querySelector("#wo-country-grid");
    cGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wo-country");
      if (!btn) return;
      chosenCountry = btn.dataset.value;
      cGrid.querySelectorAll(".wo-country").forEach(b => b.classList.toggle("selected", b === btn));
      
      // Auto-select language based on country if not explicitly chosen yet
      if (!chosenLang && COUNTRY_LANG[chosenCountry]) {
          const autoLang = COUNTRY_LANG[chosenCountry];
          const langBtn = el.querySelector(`.wo-lang[data-value="${autoLang}"]`);
          if (langBtn) langBtn.click();
      }
      
      checkValidity();
    });

    const lGrid = el.querySelector("#wo-lang-grid");
    lGrid.addEventListener("click", (e) => {
      const btn = e.target.closest(".wo-lang");
      if (!btn) return;
      chosenLang = btn.dataset.value;
      lGrid.querySelectorAll(".wo-lang").forEach(b => b.classList.toggle("selected", b === btn));
      checkValidity();
    });
    
    // Initial validation check in case language was pre-selected
    function checkValidity() {
        const hasName = (el.querySelector("#wo-name").value || "").trim().length >= 2;
        el.querySelector("#wo-continue").disabled = !(hasName && chosenCountry && chosenLang);
        el.querySelector("#wo-err").textContent = "";
    }
    
    el.querySelector("#wo-name").addEventListener("input", checkValidity);

    el.querySelector("#wo-continue").addEventListener("click", () => {
      const name = (el.querySelector("#wo-name").value || "").trim();
      if (name.length < 2) { el.querySelector("#wo-err").textContent = "Please enter your name."; return; }
      if (!chosenCountry) { el.querySelector("#wo-err").textContent = "Please select your country."; return; }
      if (!chosenLang) { el.querySelector("#wo-err").textContent = "Please select your preferred language."; return; }

      const btn = el.querySelector("#wo-continue");
      btn.disabled = true;
      btn.innerHTML = 'Setting up... <i class="fa-solid fa-spinner fa-spin"></i>';

      if (window.setSiteLanguage) {
        window.setSiteLanguage(chosenLang);
      } else if (window.setUserLanguage) {
        window.setUserLanguage(chosenLang);
      }

      const u = firebase.auth().currentUser;
      if (u && !(u.displayName || "").trim()) {
        u.updateProfile({ displayName: name }).catch(() => {});
      }

      onSubmit(name, chosenCountry, chosenLang).then((ok) => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 400);
        
        if (!ok) { /* overlay gone; user can retry */ }
        else if (typeof window.bootstrapAccess === "function") {
          window.db && (window.db.access = null); 
          window.bootstrapAccess().finally(() => {
            if (typeof window.openQBank === "function") window.openQBank();
          });
        }
      });
    });
  }

  const CSS = `
  #welcome-onboarding { 
    position:fixed; inset:0; z-index:999999; background:var(--surface, #f4f6f8);
    display:flex; font-family:'Figtree',sans-serif;
    transition: opacity 0.4s ease;
  }
  .wo-layout {
    display: flex;
    width: 100%;
    min-height: 100vh;
  }
  
  /* Left Hero */
  .wo-hero {
    flex: 1;
    background: rgba(14, 124, 134, 0.03);
    border-right: 1px solid rgba(0,0,0,0.05);
    position: relative;
    overflow: hidden;
    display: none;
    flex-direction: column;
    justify-content: center;
    padding: 60px;
  }
  @media (min-width: 900px) { .wo-hero { display: flex; } }
  
  .wo-ambient-1 {
    position: absolute; top: -10%; left: -10%; width: 400px; height: 400px;
    background: rgba(14, 124, 134, 0.2); border-radius: 50%; filter: blur(100px);
  }
  .wo-ambient-2 {
    position: absolute; bottom: -10%; right: -10%; width: 400px; height: 400px;
    background: rgba(139, 92, 246, 0.15); border-radius: 50%; filter: blur(100px);
  }
  
  .wo-hero-content {
    position: relative; z-index: 10; max-width: 480px;
  }
  .wo-brand-hero {
    display: flex; align-items: center; gap: 12px; font-family: 'Outfit', sans-serif;
    font-size: 1.5rem; font-weight: 800; color: #0a3d4a; margin-bottom: 40px;
  }
  .wo-logo-hero {
    width: 42px; height: 42px; background: #0e7c86; color: #fff;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px; box-shadow: 0 4px 12px rgba(14, 124, 134, 0.3);
  }
  .wo-hero-title {
    font-family: 'Outfit', sans-serif; font-size: 2.8rem; font-weight: 800;
    color: #0a3d4a; line-height: 1.1; margin-bottom: 20px; letter-spacing: -0.02em;
  }
  .wo-hero-desc {
    font-size: 1.1rem; color: #334e59; line-height: 1.6; margin-bottom: 40px; opacity: 0.9;
  }
  .wo-hero-proof {
    display: flex; align-items: center; gap: 16px; color: #6b7f88; font-weight: 600; font-size: 0.95rem;
  }
  .wo-proof-avatars { display: flex; }
  .wo-avatar {
    width: 36px; height: 36px; border-radius: 50%; background: #e6f4f5; color: #0e7c86;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid #fff; margin-left: -10px; font-size: 14px;
  }
  .wo-proof-avatars .wo-avatar:first-child { margin-left: 0; }

  /* Right Form */
  .wo-form-area {
    flex: 1;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; position: relative;
    background: #fff;
  }
  .wo-card { 
    width: min(480px, 100%); 
    padding: 40px; border-radius: 24px;
    background: #fff;
    border: 1px solid rgba(0,0,0,0.06);
    box-shadow: 0 10px 40px -10px rgba(0,0,0,0.05);
    animation: woFadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes woFadeUp {
    0% { opacity: 0; transform: translateY(20px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  .wo-title { 
    font-family:'Outfit',sans-serif; font-size: 2rem; font-weight: 800; color: #0a3d4a;
    margin:0 0 8px; letter-spacing:-0.02em; 
  }
  .wo-sub { color: #6b7f88; font-size: 1.05rem; line-height: 1.5; margin: 0 0 32px; }
  
  .wo-form-group { margin-bottom: 24px; text-align: left; }
  .wo-label { 
    display: flex; align-items: center; gap: 6px;
    font-size: 0.95rem; font-weight: 600; color: #0a3d4a; margin-bottom: 8px; 
  }
  .wo-label i { color: #0e7c86; }
  
  .wo-input { 
    width: 100%; box-sizing: border-box; padding: 14px 16px; border: 1.5px solid #dbe3e7;
    border-radius: 12px; font-size: 1rem; font-family: inherit; color: #0a3d4a; outline: none;
    transition: all .2s ease; background: #fbfcfd;
  }
  .wo-input:focus { 
    border-color: #0e7c86; background: #fff;
    box-shadow: 0 0 0 4px rgba(14,124,134,0.1); 
  }
  
  .wo-help-text {
    font-size: 0.8rem; color: #6b7f88; margin: 6px 0 0 4px;
  }

  .wo-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  
  .wo-btn-opt { 
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer;
    background: #fbfcfd; border: 1.5px solid #dbe3e7; border-radius: 12px; font-family: inherit;
    font-size: 0.95rem; font-weight: 600; color: #334e59; transition: all .2s ease; text-align: left; 
  }
  .wo-btn-opt img { width: 24px; height: auto; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .wo-btn-opt:hover { border-color: #0e7c86; transform: translateY(-1px); }
  .wo-btn-opt.selected { 
    border-color: #0e7c86; background: #e6f4f5; color: #0b6770;
    box-shadow: 0 0 0 3px rgba(14,124,134,0.15); 
  }
  .wo-globe { font-size: 1.2rem; }
  
  .wo-err { min-height: 20px; color: #c0392b; font-size: 0.9rem; margin-bottom: 16px; font-weight: 600; }
  
  .wo-continue { 
    width: 100%; padding: 16px; border: none; border-radius: 12px;
    background: #0e7c86; color: #fff; font-family: inherit;
    font-size: 1.1rem; font-weight: 700; cursor: pointer; transition: all .2s ease;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    box-shadow: 0 4px 12px rgba(14, 124, 134, 0.2);
  }
  .wo-continue:hover:not(:disabled) { background: #0b6770; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(14, 124, 134, 0.3); }
  .wo-continue:active:not(:disabled) { transform: translateY(0); }
  .wo-continue:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; transform: none; }
  \`;
})();
