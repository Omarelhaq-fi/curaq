// Welcome onboarding — full-screen overlay shown once per account until the
// student provides their display name + country + language. Covers brand-new signups AND
// legacy accounts created before country existed. Saves to users_index +
// users/{uid} via Firestore compat SDK (same as syncDbToCloud).
//
// Design: 3-step wizard (name → country → language) in the app's clinical
// style (Inter, white 6px cards, #E2E8F0 borders, teal #007a7a primary).
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

  // Country → default language mapping (preselects step 3, still confirmable)
  const COUNTRY_LANG = {
    tunisia: 'fr',
    algeria: 'fr',
    morocco: 'fr',
    egypt: 'ar',
    saudi: 'ar',
    global: 'en',
  };

  const STEP_LABELS = { 1: "Your name", 2: "Your country", 3: "Your language" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function countryLabel(v) {
    const c = COUNTRIES.find(x => x.value === v);
    return c ? c.label : v;
  }

  window.showWelcomeOnboarding = function () {
    if (window.hideGlobalLoader) window.hideGlobalLoader();
    // Already completed? never show again
    try { if (localStorage.getItem("omnote_onboarded") === "1") return; } catch (_) {}
    if (document.getElementById("welcome-onboarding")) return;

    const user = window.firebase && firebase.auth().currentUser;
    if (!user) return;

    const defaultName = user.displayName || "";
    const avatar = user.photoURL || "";
    const firstName = defaultName ? esc(defaultName.split(" ")[0]) : "";

    const overlay = document.createElement("div");
    overlay.id = "welcome-onboarding";
    overlay.innerHTML = `
      <div class="wo-layout">
        <!-- Left Side: branded hero -->
        <div class="wo-hero">
          <div class="wo-hero-content">
            <div class="wo-brand-hero">
              <div class="wo-logo-hero"><img src="assets/logo.png" alt="CuraQ Logo" style="width: 100%; height: 100%; border-radius: 8px; object-fit: cover;"></div>
              <span>CuraQ QBank</span>
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

        <!-- Right Side: stepped form -->
        <div class="wo-form-area">
          <div class="wo-card">
            <div class="wo-brand-mobile">
              <div class="wo-logo-hero" style="width:28px;height:28px;"><img src="assets/logo.png" alt="CuraQ Logo" style="width: 100%; height: 100%; border-radius: 8px; object-fit: cover;"></div>
              <span>CuraQ QBank</span>
            </div>
            <div class="wo-stepper" id="wo-steps"></div>
            <div class="wo-step" id="wo-body"></div>
            <div class="wo-status" id="wo-status"></div>
            <div class="wo-nav" id="wo-nav"></div>
            ${avatar ? `<img src="${esc(avatar)}" style="display:none;" alt="" />` : ""}
          </div>
        </div>
      </div>
      <style>${CSS}</style>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";

    let step = 1;
    let chosenName = (defaultName || "").trim();
    let chosenCountry = "";
    let chosenLang = "";

    const stepsEl = overlay.querySelector("#wo-steps");
    const bodyEl = overlay.querySelector("#wo-body");
    const navEl = overlay.querySelector("#wo-nav");
    const statusEl = overlay.querySelector("#wo-status");

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg || "";
    }

    function renderStepper() {
      stepsEl.innerHTML = `
        <div class="wo-stepmeta"><span>Step ${step} of 3</span><span>${STEP_LABELS[step]}</span></div>
        <div class="wo-track"><div class="wo-fill" style="width:${Math.round((step / 3) * 100)}%;"></div></div>`;
    }

    function optBtn(kind, value, inner, selected) {
      return `<button type="button" class="wo-btn-opt wo-${kind}${selected ? " selected" : ""}" data-value="${value}">${inner}<i class="fa-solid fa-circle-check wo-check"></i></button>`;
    }

    function render() {
      renderStepper();
      setStatus("");
      // Re-trigger the step entrance animation
      bodyEl.style.animation = "none";
      void bodyEl.offsetWidth;
      bodyEl.style.animation = "";

      if (step === 1) {
        bodyEl.innerHTML = `
          <h2 class="wo-title">Welcome${firstName ? " back, " + firstName : ""}!</h2>
          <p class="wo-sub">Let's set up your account preferences.</p>
          <label class="wo-label" for="wo-name">How should we call you?</label>
          <input id="wo-name" class="wo-input" type="text" maxlength="60"
                 placeholder="e.g. Dr. House or John" value="${esc(chosenName)}" autocomplete="given-name" />`;
        navEl.innerHTML = `
          <button id="wo-next" class="wo-btn-primary wo-btn-block" ${chosenName.length >= 2 ? "" : "disabled"}>
            Continue <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const nameEl = bodyEl.querySelector("#wo-name");
        const next = navEl.querySelector("#wo-next");
        const valid = () => (nameEl.value || "").trim().length >= 2;
        nameEl.addEventListener("input", () => {
          chosenName = (nameEl.value || "").trim();
          next.disabled = !valid();
        });
        nameEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && valid()) next.click();
        });
        next.addEventListener("click", () => { if (valid()) { step = 2; render(); } });
        setTimeout(() => { nameEl.focus(); }, 60);
      }

      if (step === 2) {
        bodyEl.innerHTML = `
          <h2 class="wo-title">Where are you studying?</h2>
          <p class="wo-sub">This helps us tailor medical guidelines to your region.</p>
          <div class="wo-grid" id="wo-country-grid">
            ${COUNTRIES.map(c => optBtn("country", c.value,
              `${c.flag ? `<img src="https://flagcdn.com/${c.flag}.svg" alt="" />` : `<span class="wo-globe">🌍</span>`}<span>${esc(c.label)}</span>`,
              chosenCountry === c.value)).join("")}
          </div>`;
        navEl.innerHTML = `
          <button id="wo-back" class="wo-btn-ghost"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button id="wo-next" class="wo-btn-primary wo-btn-flex" ${chosenCountry ? "" : "disabled"}>
            Continue <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const grid = bodyEl.querySelector("#wo-country-grid");
        const next = navEl.querySelector("#wo-next");
        grid.addEventListener("click", (e) => {
          const btn = e.target.closest(".wo-country");
          if (!btn) return;
          chosenCountry = btn.dataset.value;
          grid.querySelectorAll(".wo-country").forEach(b => b.classList.toggle("selected", b === btn));
          // Preselect the matching language (confirmable on the next step)
          if (COUNTRY_LANG[chosenCountry] && !chosenLang) chosenLang = COUNTRY_LANG[chosenCountry];
          next.disabled = false;
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 1; render(); });
        next.addEventListener("click", () => { if (chosenCountry) { step = 3; render(); } });
      }

      if (step === 3) {
        const cLabel = countryLabel(chosenCountry);
        const nameVal = chosenName || defaultName;
        bodyEl.innerHTML = `
          <h2 class="wo-title">Preferred language</h2>
          <p class="wo-sub">Your workspace, questions and AI tutor will use this language.</p>
          <div class="wo-summary"><i class="fa-solid fa-circle-check"></i><span>${esc((nameVal || "").trim().split(" ")[0] || "You")} &middot; ${esc(cLabel)}</span></div>
          <div class="wo-col" id="wo-lang-grid">
            ${LANGUAGES.map(l => optBtn("lang", l.value, `<span>${esc(l.label)}</span>`, chosenLang === l.value)).join("")}
          </div>`;
        navEl.innerHTML = `
          <button id="wo-back" class="wo-btn-ghost"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button id="wo-go" class="wo-btn-primary wo-btn-flex" ${chosenLang ? "" : "disabled"}>
            Complete Setup <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const grid = bodyEl.querySelector("#wo-lang-grid");
        const go = navEl.querySelector("#wo-go");
        grid.addEventListener("click", (e) => {
          const btn = e.target.closest(".wo-lang");
          if (!btn) return;
          chosenLang = btn.dataset.value;
          grid.querySelectorAll(".wo-lang").forEach(b => b.classList.toggle("selected", b === btn));
          go.disabled = false;
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 2; render(); });
        go.addEventListener("click", save);
      }
    }

    async function save() {
      const name = (chosenName || defaultName || "").trim();
      if (name.length < 2 || !chosenCountry || !chosenLang) return;

      const go = overlay.querySelector("#wo-go");
      if (go) {
        go.disabled = true;
        go.innerHTML = 'Setting up... <i class="fa-solid fa-spinner fa-spin"></i>';
      }

      try {
        try { localStorage.setItem('omnote_lang', chosenLang); } catch (_) {}

        // Auth profile
        try { await user.updateProfile({ displayName: name }); } catch (_) {}

        // Firestore profile (both docs, merge)
        const fsdb = firebase.firestore();
        await fsdb.collection("users_index").doc(user.uid).set(
          { country: chosenCountry, displayName: name, email: user.email || "" },
          { merge: true }
        );
        await fsdb.collection("users").doc(user.uid).set(
          { country: chosenCountry, language: chosenLang },
          { merge: true }
        );

        try { localStorage.setItem("omnote_onboarded", "1"); } catch (_) {}

        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.remove();
          document.body.style.overflow = "";
        }, 400);

        // Re-run access bootstrap so their banks appear instantly
        if (window.db) delete window.db.access;
        if (typeof saveDb === "function") saveDb();
        if (typeof window.openQBank === "function") window.openQBank();
        else if (typeof window.refreshAppUI === "function") window.refreshAppUI();

        // Set local language last (as it triggers a page reload)
        if (window.setSiteLanguage) {
          window.setSiteLanguage(chosenLang);
        } else if (window.setUserLanguage) {
          window.setUserLanguage(chosenLang);
        }
      } catch (e) {
        setStatus("Could not save: " + (e.message || e) + " — check your connection and retry.");
        if (go) {
          go.disabled = false;
          go.innerHTML = 'Complete Setup <i class="fa-solid fa-arrow-right"></i>';
        }
      }
    }

    render();
  };

  const CSS = `
  #welcome-onboarding {
    position:fixed; inset:0; z-index:999999; background:#F8FAFC;
    display:flex; font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
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
    background: url('images/exora-onboarding-bg.png') center/cover no-repeat;
    position: relative;
    overflow: hidden;
    display: none;
    flex-direction: column;
    justify-content: center;
    padding: 60px;
  }
  .wo-hero::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(135deg, rgba(10,30,40,0.85) 0%, rgba(14,124,134,0.4) 100%);
  }
  @media (min-width: 900px) { .wo-hero { display: flex; } }

  .wo-hero-content {
    position: relative; z-index: 10; max-width: 480px; text-shadow: 0 2px 10px rgba(0,0,0,0.5);
  }
  .wo-brand-hero {
    display: flex; align-items: center; gap: 12px;
    font-size: 1.5rem; font-weight: 800; color: #ffffff; margin-bottom: 40px;
  }
  .wo-logo-hero {
    width: 42px; height: 42px; background: #0e7c86; color: #fff;
    display: flex; align-items: center; justify-content: center;
    border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  .wo-hero-title {
    font-size: 2.8rem; font-weight: 800;
    color: #ffffff; line-height: 1.1; margin: 0 0 20px; letter-spacing: -0.02em;
  }
  .wo-hero-desc {
    font-size: 1.1rem; color: rgba(255,255,255,0.9); line-height: 1.6; margin: 0 0 40px;
  }
  .wo-hero-proof {
    display: flex; align-items: center; gap: 16px; color: rgba(255,255,255,0.8); font-weight: 600; font-size: 0.95rem;
  }
  .wo-hero-proof p { margin: 0; }
  .wo-proof-avatars { display: flex; }
  .wo-avatar {
    width: 36px; height: 36px; border-radius: 50%; background: #0e7c86; color: #ffffff;
    display: flex; align-items: center; justify-content: center;
    border: 2px solid rgba(255,255,255,0.2); margin-left: -10px; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .wo-proof-avatars .wo-avatar:first-child { margin-left: 0; }

  .wo-brand-mobile {
    display: none; align-items: center; gap: 8px;
    font-size: 1.1rem; font-weight: 800; color: #0F172A; margin-bottom: 20px;
  }
  .wo-brand-mobile span { color: #0F172A; }
  @media (max-width: 899px) { .wo-brand-mobile { display: flex; } }

  /* Right stepped form — clinical card */
  .wo-form-area {
    flex: 1;
    display: flex; align-items: center; justify-content: center;
    padding: 24px; position: relative;
    background: #F8FAFC;
    overflow-y: auto;
  }
  .wo-card {
    width: min(520px, 100%);
    padding: 32px; border-radius: 6px;
    background: #fff;
    border: 1px solid #E2E8F0;
    animation: woFadeUp 0.4s ease-out;
  }
  .wo-step { animation: woFadeUp 0.35s ease-out; }
  @keyframes woFadeUp {
    0% { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }

  .wo-stepper { margin-bottom: 20px; }
  .wo-stepmeta {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: #64748B; margin-bottom: 8px;
  }
  .wo-track { height: 6px; background: #E2E8F0; border-radius: 999px; overflow: hidden; }
  .wo-fill { height: 100%; background: #007a7a; border-radius: 999px; transition: width 0.3s ease; }

  .wo-title {
    font-size: 1.5rem; font-weight: 700; color: #0F172A;
    margin: 0 0 6px; letter-spacing: 0;
  }
  .wo-sub { color: #64748B; font-size: 0.9rem; line-height: 1.5; margin: 0 0 20px; }

  .wo-label {
    display: block;
    font-size: 13px; font-weight: 700; color: #0F172A; margin-bottom: 8px;
  }

  .wo-input {
    width: 100%; box-sizing: border-box; padding: 14px 16px; border: 1px solid #E2E8F0;
    border-radius: 6px; font-size: 1rem; font-family: inherit; color: #0F172A; outline: none;
    transition: border-color .2s ease, box-shadow .2s ease; background: #fff;
  }
  .wo-input:focus {
    border-color: #007a7a; background: #fff;
    box-shadow: 0 0 0 3px rgba(0,122,122,0.12);
  }
  .wo-input::placeholder { color: #94A3B8; }

  .wo-summary {
    display: flex; align-items: center; gap: 8px;
    background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 999px;
    padding: 6px 14px; font-size: 12.5px; font-weight: 600; color: #334155;
    margin-bottom: 16px; width: fit-content; max-width: 100%;
  }
  .wo-summary i { color: #007a7a; font-size: 13px; }

  .wo-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  @media (max-width: 480px) { .wo-grid { grid-template-columns: 1fr; } }
  .wo-col { display: flex; flex-direction: column; gap: 10px; }

  .wo-btn-opt {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer;
    background: #fff; border: 1px solid #E2E8F0; border-radius: 6px; font-family: inherit;
    font-size: 14px; font-weight: 600; color: #334155; transition: all .2s ease; text-align: left;
  }
  .wo-btn-opt img { width: 24px; height: auto; border-radius: 3px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); flex-shrink: 0; }
  .wo-btn-opt:hover { border-color: #007a7a; background: #F8FAFC; }
  .wo-btn-opt.selected {
    border-color: #007a7a; background: #e6f2f2; color: #007a7a;
  }
  .wo-check { display: none; margin-left: auto; font-size: 15px; color: #007a7a; flex-shrink: 0; }
  .wo-btn-opt.selected .wo-check { display: inline-block; }
  .wo-globe { font-size: 1.2rem; }

  .wo-status { min-height: 20px; color: #C62828; font-size: 12.5px; margin: 12px 0 4px; font-weight: 600; }

  .wo-nav { display: flex; gap: 10px; margin-top: 12px; }
  .wo-btn-primary {
    border: none; border-radius: 6px; padding: 12px 18px;
    background: #007a7a; color: #fff; font-family: inherit;
    font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s ease;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  }
  .wo-btn-primary:hover:not(:disabled) { background: #006666; }
  .wo-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .wo-btn-block { width: 100%; }
  .wo-btn-flex { flex: 1; }
  .wo-btn-ghost {
    border: 1px solid #E2E8F0; border-radius: 999px; padding: 12px 18px;
    background: #F8FAFC; color: #0F172A; font-family: inherit;
    font-size: 14px; font-weight: 700; cursor: pointer; transition: background .2s ease;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  }
  .wo-btn-ghost:hover { background: #E2E8F0; }
  `;
})();
