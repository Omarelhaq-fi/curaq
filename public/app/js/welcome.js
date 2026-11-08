// Welcome onboarding — full-screen overlay shown once per account until the
// student provides a display name, contact and language. Saves to users_index
// + users/{uid} via Firestore compat SDK (same as syncDbToCloud).
//
// Design: 3-step wizard (name → Telegram → language) in the app's clinical
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

  const STEP_LABELS = {
    0: "Email verification",
    1: "Your name",
    2: "Your country",
    3: "Your major",
    4: "Your college",
    5: "Telegram",
    6: "Your language",
  };
  const TOTAL_STEPS = 6;

  // Academic catalogue (country -> major -> college), loaded from
  // /api/qbank?action=academic_structure. Fallback = built-in country list.
  let ACADEMIC = {
    countries: COUNTRIES.map(c => ({ id: c.value, name: c.label, code: c.flag || "" })),
    majors: [],
    colleges: [],
  };
  let academicLoaded = false;

  async function loadAcademic() {
    if (academicLoaded) return;
    try {
      const user = window.firebase && firebase.auth().currentUser;
      if (!user) return;
      const token = await user.getIdToken();
      const res = await fetch("/api/qbank?action=academic_structure", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && Array.isArray(data.countries) && data.countries.length) {
        ACADEMIC = {
          countries: data.countries,
          majors: Array.isArray(data.majors) ? data.majors : [],
          colleges: Array.isArray(data.colleges) ? data.colleges : [],
        };
      }
    } catch (_) { /* keep fallback */ }
    academicLoaded = true;
  }

  function countryLabel(id) {
    const c = ACADEMIC.countries.find(x => x.id === id);
    return c ? c.name : (id || "—");
  }
  function majorsFor(countryId) {
    return ACADEMIC.majors.filter(m => m.countryId === countryId);
  }
  function collegesFor(countryId, majorId) {
    return ACADEMIC.colleges.filter(c => c.majorId === majorId);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Arabic-Indic / Persian digits are common in the Middle East; normalise
  // them to ASCII so phone numbers validate and store consistently.
  function normalizeDigits(input) {
    return String(input == null ? "" : input)
      .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0));
  }

  // Exactly one contact method is accepted: a Telegram username (stored as
  // "@name") or a phone number. Mixed input such as "@name +20123" is rejected.
  function parseTelegram(raw) {
    const value = normalizeDigits(raw).trim();
    if (!value) return { ok: false, error: "Enter your Telegram username or phone number." };

    let username = value;
    if (username.startsWith("@")) username = username.slice(1);
    if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) {
      return { ok: true, type: "username", value: "@" + username };
    }

    if (/^[+\d][\d\s().-]*$/.test(value)) {
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15) {
        return {
          ok: true,
          type: "phone",
          value: value.startsWith("+") ? "+" + digits : digits,
        };
      }
      return { ok: false, error: "Enter a phone number with 7–15 digits (include country code if possible)." };
    }

    return { ok: false, error: "Enter one contact only: a username (e.g. @curaq_student) or a phone number (e.g. +20 100 123 4567)." };
  }

  window.showWelcomeOnboarding = async function () {
    if (window.hideGlobalLoader) window.hideGlobalLoader();
    if (document.getElementById("welcome-onboarding")) return;

    const user = window.firebase && firebase.auth().currentUser;
    if (!user) return;

    let existingProfile = {};
    try {
      const snap = await firebase.firestore().collection("users_index").doc(user.uid).get();
      if (snap.exists) existingProfile = snap.data() || {};
    } catch (_) {}

    const defaultName = user.displayName || existingProfile.displayName || "";
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

    let step = user.emailVerified === false ? 0 : 1;
    let chosenName = (defaultName || "").trim();
    let chosenCountry = existingProfile.country || "";
    let chosenMajorId = existingProfile.majorId || "";
    let chosenMajorName = existingProfile.major || "";
    let chosenCollegeId = existingProfile.collegeId || "";
    let chosenCollegeName = existingProfile.college || "";
    let chosenTelegram = existingProfile.telegram || "";
    let chosenLang = existingProfile.language || "";
    loadAcademic().then(() => {
      // Re-render the academic steps once real catalogue data arrives.
      if (step >= 2 && step <= 4 && document.body.contains(overlay)) render();
    });

    const stepsEl = overlay.querySelector("#wo-steps");
    const bodyEl = overlay.querySelector("#wo-body");
    const navEl = overlay.querySelector("#wo-nav");
    const statusEl = overlay.querySelector("#wo-status");

    function setStatus(msg) {
      if (statusEl) statusEl.textContent = msg || "";
    }

    const verifyStorageKey = `curaq_verify_sent_${user.uid}`;
    let verificationSending = false;
    let verificationSentAt = 0;
    try { verificationSentAt = Number(localStorage.getItem(verifyStorageKey) || 0); } catch (_) {}
    let verificationAutoSent = false;

    async function sendVerificationLink(manual = false) {
      if (!user || verificationSending) return;
      const now = Date.now();
      if (!manual && verificationSentAt && now - verificationSentAt < 10 * 60 * 1000) {
        setStatus("Verification link already sent recently. Check your inbox, then tap I have verified.");
        return;
      }
      verificationSending = true;
      setStatus("Sending verification link…");
      try {
        await user.sendEmailVerification({
          url: `${window.location.origin}/app/index.html`,
          handleCodeInApp: false,
        });
        verificationSending = false;
        verificationSentAt = Date.now();
        try { localStorage.setItem(verifyStorageKey, String(verificationSentAt)); } catch (_) {}
        setStatus(`Verification link sent to ${user.email || "your email"}. Open it, then tap Continue.`);
      } catch (e) {
        verificationSending = false;
        setStatus(`Could not send verification link: ${e.message || e}. You can continue with Google instead.`);
      }
    }

    async function checkEmailVerified() {
      setStatus("Checking verification…");
      try { await user.reload(); } catch (_) {}
      if (user.emailVerified) {
        step = 1;
        render();
        return;
      }
      setStatus("Your email is not verified yet. Open the link from your inbox, then tap Continue.");
    }

    async function continueWithGoogle() {
      setStatus("Opening Google…");
      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        provider.addScope("profile");
        provider.addScope("email");
        const current = firebase.auth().currentUser || user;
        if (current && current.providerData.some(p => p.providerId === "google.com")) {
          await current.reload();
        } else if (current) {
          await current.linkWithPopup(provider);
          await current.reload();
        } else {
          await firebase.auth().signInWithPopup(provider);
          const afterPopup = firebase.auth().currentUser;
          if (afterPopup) await afterPopup.reload();
        }
        const after = firebase.auth().currentUser;
        if (!after) {
          setStatus("Google sign-in did not complete.");
          return;
        }
        if (user && after.uid !== user.uid) {
          overlay.remove();
          document.body.style.overflow = "";
          window.location.reload();
          return;
        }
        if (after.emailVerified) {
          step = 1;
          render();
          return;
        }
        setStatus("Google connected, but your email is not marked verified yet. Tap Continue again, or use the verification link.");
      } catch (e) {
        if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) {
          setStatus("");
          return;
        }
        setStatus(`Could not continue with Google: ${e.message || e}. You can still use the verification link.`);
      }
    }

    function renderStepper() {
      if (step === 0) {
        stepsEl.innerHTML = `
          <div class="wo-stepmeta"><span>Verify your email</span><span>Required</span></div>
          <div class="wo-track"><div class="wo-fill" style="width:0%;"></div></div>`;
        return;
      }
      stepsEl.innerHTML = `
        <div class="wo-stepmeta"><span>Step ${step} of ${TOTAL_STEPS}</span><span>${STEP_LABELS[step]}</span></div>
        <div class="wo-track"><div class="wo-fill" style="width:${Math.round((step / TOTAL_STEPS) * 100)}%;"></div></div>`;
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

      if (step === 0) {
        bodyEl.innerHTML = `
          <h2 class="wo-title">Verify your email</h2>
          <p class="wo-sub">We sent a verification link to <b>${esc(user.email || "your inbox")}</b>. Open it on this device to finish setting up CuraQ.</p>
          <div class="wo-verify-actions">
            <button type="button" id="wo-resend" class="wo-btn-ghost wo-btn-flex"><i class="fa-solid fa-envelope"></i> Resend link</button>
            <button type="button" id="wo-checked" class="wo-btn-primary wo-btn-flex">I have verified <i class="fa-solid fa-arrow-right"></i></button>
          </div>
          <div class="wo-verify-or"><span>or</span></div>
          <button type="button" id="wo-google" class="wo-btn-google"><i class="fa-brands fa-google"></i> Continue with Google instead</button>
          <p class="wo-hint">If the link does not arrive, continue with Google to finish without waiting for email verification.</p>`;
        navEl.innerHTML = "";
        bodyEl.querySelector("#wo-resend").addEventListener("click", () => sendVerificationLink(true));
        bodyEl.querySelector("#wo-checked").addEventListener("click", checkEmailVerified);
        bodyEl.querySelector("#wo-google").addEventListener("click", continueWithGoogle);
        if (!verificationAutoSent) {
          verificationAutoSent = true;
          sendVerificationLink(false);
        }
      }

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
          <p class="wo-sub">Country, major and college decide which modules are shown to you.</p>
          <div class="wo-col" id="wo-country-grid">
            ${ACADEMIC.countries.map(c => optBtn("country", c.id, `${c.code ? `<img src="https://flagcdn.com/${esc(c.code)}.svg" alt="" />` : '<span class="wo-globe">🌍</span>'}<span>${esc(c.name)}</span>`, chosenCountry === c.id)).join("")}
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
          chosenMajorId = ""; chosenMajorName = ""; chosenCollegeId = ""; chosenCollegeName = "";
          grid.querySelectorAll(".wo-country").forEach(b => b.classList.toggle("selected", b === btn));
          next.disabled = false;
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 1; render(); });
        next.addEventListener("click", () => { if (!next.disabled) { step = 3; render(); } });
      }

      if (step === 3) {
        const majors = majorsFor(chosenCountry);
        const isCustom = chosenMajorName && !majors.some(m => m.id === chosenMajorId);
        bodyEl.innerHTML = `
          <h2 class="wo-title">What is your major?</h2>
          <p class="wo-sub">Pick your major in ${esc(countryLabel(chosenCountry))} (e.g. Medicine). Modules are linked to majors.</p>
          <div class="wo-col" id="wo-major-grid">
            ${majors.map(m => optBtn("major", m.id, `<span>${esc(m.name)}</span>`, chosenMajorId === m.id)).join("")}
            ${majors.length ? "" : '<div style="color:#64748B;font-size:13px;padding:4px 0;">No majors listed yet — type yours below.</div>'}
          </div>
          <label class="wo-label" for="wo-major-other" style="margin-top:14px;">Other major (type it)</label>
          <input id="wo-major-other" class="wo-input" type="text" maxlength="60" placeholder="e.g. Medicine" value="${isCustom ? esc(chosenMajorName) : ""}" autocomplete="off" />`;
        navEl.innerHTML = `
          <button id="wo-back" class="wo-btn-ghost"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button id="wo-next" class="wo-btn-primary wo-btn-flex" ${(chosenMajorId || (chosenMajorName || "").trim().length >= 2) ? "" : "disabled"}>
            Continue <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const grid = bodyEl.querySelector("#wo-major-grid");
        const otherEl = bodyEl.querySelector("#wo-major-other");
        const next = navEl.querySelector("#wo-next");
        const refresh = () => {
          next.disabled = !(chosenMajorId || (otherEl.value || "").trim().length >= 2);
        };
        grid.addEventListener("click", (e) => {
          const btn = e.target.closest(".wo-major");
          if (!btn) return;
          chosenMajorId = btn.dataset.value;
          chosenMajorName = btn.querySelector("span") ? btn.querySelector("span").textContent.trim() : "";
          otherEl.value = "";
          chosenCollegeId = ""; chosenCollegeName = "";
          grid.querySelectorAll(".wo-major").forEach(b => b.classList.toggle("selected", b === btn));
          refresh();
        });
        otherEl.addEventListener("input", () => {
          if ((otherEl.value || "").trim().length >= 2) {
            chosenMajorId = "";
            chosenMajorName = otherEl.value.trim();
            grid.querySelectorAll(".wo-major").forEach(b => b.classList.remove("selected"));
          }
          refresh();
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 2; render(); });
        next.addEventListener("click", () => {
          if (otherEl.value && otherEl.value.trim().length >= 2) chosenMajorName = otherEl.value.trim();
          if (!next.disabled) { step = 4; render(); }
        });
      }

      if (step === 4) {
        const colleges = collegesFor(chosenCountry, chosenMajorId);
        if (chosenCollegeId && !colleges.some(c => c.id === chosenCollegeId)) chosenCollegeId = "";
        const isCustomCollege = chosenCollegeName && !colleges.some(c => c.id === chosenCollegeId);
        const majorLabel = chosenMajorName || "your major";
        bodyEl.innerHTML = `
          <h2 class="wo-title">Which college do you attend?</h2>
          <p class="wo-sub">Your module access is based on ${esc(majorLabel)} at your college in ${esc(countryLabel(chosenCountry))}.</p>
          <div class="wo-col" id="wo-college-grid">
            ${colleges.map(c => optBtn("college", c.id, `<span>${esc(c.name)}</span>`, chosenCollegeId === c.id)).join("")}
            ${colleges.length ? "" : '<div style="color:#64748B;font-size:13px;padding:4px 0;">No colleges listed yet — type yours below and we will add it.</div>'}
          </div>
          <label class="wo-label" for="wo-college-other" style="margin-top:14px;">Other college (type it)</label>
          <input id="wo-college-other" class="wo-input" type="text" maxlength="80" placeholder="e.g. Faculty of Medicine, Cairo University" value="${isCustomCollege ? esc(chosenCollegeName) : ""}" autocomplete="off" />`;
        navEl.innerHTML = `
          <button id="wo-back" class="wo-btn-ghost"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button id="wo-next" class="wo-btn-primary wo-btn-flex" ${(chosenCollegeId || (chosenCollegeName || "").trim().length >= 2) ? "" : "disabled"}>
            Continue <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const grid = bodyEl.querySelector("#wo-college-grid");
        const otherEl = bodyEl.querySelector("#wo-college-other");
        const next = navEl.querySelector("#wo-next");
        const refresh = () => {
          next.disabled = !(chosenCollegeId || (otherEl.value || "").trim().length >= 2);
        };
        grid.addEventListener("click", (e) => {
          const btn = e.target.closest(".wo-college");
          if (!btn) return;
          chosenCollegeId = btn.dataset.value;
          chosenCollegeName = btn.querySelector("span") ? btn.querySelector("span").textContent.trim() : btn.textContent.trim();
          otherEl.value = "";
          grid.querySelectorAll(".wo-college").forEach(b => b.classList.toggle("selected", b === btn));
          refresh();
        });
        otherEl.addEventListener("input", () => {
          if ((otherEl.value || "").trim().length >= 2) {
            chosenCollegeId = "";
            chosenCollegeName = otherEl.value.trim();
            grid.querySelectorAll(".wo-college").forEach(b => b.classList.remove("selected"));
          }
          refresh();
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 3; render(); });
        next.addEventListener("click", () => {
          if (otherEl.value && otherEl.value.trim().length >= 2) chosenCollegeName = otherEl.value.trim();
          if (!next.disabled) { step = 5; render(); }
        });
      }

      if (step === 5) {
        const initialTelegram = parseTelegram(chosenTelegram);
        bodyEl.innerHTML = `
          <h2 class="wo-title">How can we reach you on Telegram?</h2>
          <p class="wo-sub">Enter either your Telegram username or your phone number — one is enough. We'll only use it for account and study updates.</p>
          <label class="wo-label" for="wo-telegram">Telegram username or phone number</label>
          <input id="wo-telegram" class="wo-input" type="text" maxlength="40"
                 placeholder="@username or +20 100 123 4567" value="${esc(chosenTelegram)}" autocomplete="off" />
          <div class="wo-hint" id="wo-telegram-hint"></div>`;
        navEl.innerHTML = `
          <button id="wo-back" class="wo-btn-ghost"><i class="fa-solid fa-arrow-left"></i> Back</button>
          <button id="wo-next" class="wo-btn-primary wo-btn-flex" ${initialTelegram.ok ? "" : "disabled"}>
            Continue <i class="fa-solid fa-arrow-right"></i>
          </button>`;
        const tgEl = bodyEl.querySelector("#wo-telegram");
        const hintEl = bodyEl.querySelector("#wo-telegram-hint");
        const next = navEl.querySelector("#wo-next");

        function refreshTelegram() {
          const parsed = parseTelegram(tgEl.value);
          chosenTelegram = (tgEl.value || "").trim();
          next.disabled = !parsed.ok;
          if (!chosenTelegram) {
            hintEl.textContent = "Username (e.g. @curaq_student) or phone with country code (e.g. +20 100 123 4567).";
            hintEl.classList.remove("is-error");
          } else if (parsed.ok) {
            hintEl.textContent = parsed.type === "username"
              ? "Telegram username — saved as " + parsed.value
              : "Phone number — saved as " + parsed.value;
            hintEl.classList.remove("is-error");
          } else {
            hintEl.textContent = parsed.error;
            hintEl.classList.add("is-error");
          }
        }

        tgEl.addEventListener("input", refreshTelegram);
        tgEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !next.disabled) next.click();
        });
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 4; render(); });
        next.addEventListener("click", () => {
          const parsed = parseTelegram(tgEl.value);
          if (!parsed.ok) return;
          chosenTelegram = parsed.value;
          step = 6;
          render();
        });
        refreshTelegram();
        setTimeout(() => { tgEl.focus(); }, 60);
      }

      if (step === 6) {
        const cLabel = countryLabel(chosenCountry);
        const nameVal = chosenName || defaultName;
        bodyEl.innerHTML = `
          <h2 class="wo-title">Preferred language</h2>
          <p class="wo-sub">Your workspace, questions and AI tutor will use this language.</p>
          <div class="wo-summary"><i class="fa-solid fa-circle-check"></i><span>${esc((nameVal || "").trim().split(" ")[0] || "You")} &middot; ${esc(cLabel)} &middot; ${esc(chosenMajorName || "Major")} &middot; ${esc(chosenCollegeName || "College")} &middot; ${esc(chosenTelegram || "Telegram")}</span></div>
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
        navEl.querySelector("#wo-back").addEventListener("click", () => { step = 5; render(); });
        go.addEventListener("click", save);
      }
    }

    async function save() {
      const name = (chosenName || defaultName || "").trim();
      const parsedTelegram = parseTelegram(chosenTelegram);
      if (name.length < 2 || !chosenLang || !parsedTelegram.ok) return;
      chosenTelegram = parsedTelegram.value;

      const go = overlay.querySelector("#wo-go");
      if (go) {
        go.disabled = true;
        go.innerHTML = 'Setting up... <i class="fa-solid fa-spinner fa-spin"></i>';
      }

      try {
        const token = await user.getIdToken();
        const res = await fetch("/api/qbank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "complete_onboarding",
            name,
            language: chosenLang,
            telegram: parsedTelegram.value,
            countryId: chosenCountry || undefined,
            majorId: chosenMajorId || undefined,
            majorName: chosenMajorName || undefined,
            collegeId: chosenCollegeId || undefined,
            collegeName: chosenCollegeName || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not save your profile.");

        try { localStorage.setItem('omnote_lang', chosenLang); } catch (_) {}
        try { localStorage.setItem("omnote_onboarded", "1"); } catch (_) {}
        try { await user.updateProfile({ displayName: name }); } catch (_) {}

        if (window.db) {
          if (data.access && typeof window.applyAccessBundle === "function") {
            window.applyAccessBundle(data.access);
          } else {
            delete window.db.access;
            if (typeof window.bootstrapAccess === "function") await window.bootstrapAccess(true);
          }
          window.__academicProfile = data.profile || null;
          if (typeof saveDb === "function") saveDb();
        }

        overlay.style.opacity = '0';
        setTimeout(() => {
          overlay.remove();
          document.body.style.overflow = "";
        }, 400);

        if (typeof window.openQBank === "function") window.openQBank();
        else if (typeof window.refreshAppUI === "function") window.refreshAppUI();

        if (window.setSiteLanguage) {
          window.setSiteLanguage(chosenLang);
        } else if (typeof window.setUserLanguage) {
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

  .wo-hint {
    margin-top: 8px; font-size: 12px; line-height: 1.45; color: #64748B;
  }
  .wo-hint.is-error { color: #C62828; font-weight: 600; }

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
  .wo-verify-actions { display: flex; gap: 10px; margin: 4px 0 6px; }
  @media (max-width: 520px) { .wo-verify-actions { flex-direction: column; } }
  .wo-verify-or { display: flex; align-items: center; gap: 10px; margin: 14px 0; color: #94A3B8; font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; }
  .wo-verify-or::before, .wo-verify-or::after { content: ""; flex: 1; height: 1px; background: #E2E8F0; }
  .wo-btn-google {
    width: 100%; border: 1px solid #E2E8F0; border-radius: 6px; padding: 12px 18px;
    background: #ffffff; color: #111827; font-family: inherit; font-size: 14px; font-weight: 700;
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    transition: background .2s ease, border-color .2s ease;
  }
  .wo-btn-google:hover { background: #F8FAFC; border-color: #cbd5e1; }
  `;
})();
