/* OmNote — Book Mode: authentic lofi study room overlay */
(function () {
  let active = false;
  let overlay = null;
  let tickRAF = null;
  let quoteTimer = null;
  let lofiAudio = null;
  let rainAudio = null;

  const QUOTES = {
    en: [
      "One page at a time.",
      "Small steps, steady mind.",
      "You don't have to be fast — just consistent.",
      "The lamp is on. The world is quiet. Study.",
      "Discipline is choosing what you want most over what you want now.",
      "Focus is a love letter to your future self.",
      "Breathe. Read the next sentence.",
      "Progress hides in the pages you almost skipped.",
      "Rain outside. Warmth inside. Keep going.",
      "You've done harder things than this chapter.",
      "The clock ticks. Your mind sharpens.",
      "Show up for the person you're becoming.",
      "Every note is a promise to remember.",
      "Slow is smooth. Smooth is fast.",
      "Curiosity is the quietest superpower.",
      "The desk is a temple tonight.",
      "You are the story between the highlights.",
      "Softly, seriously — begin.",
      "Attention is the rarest gift you can give.",
      "One more chunk. One more win.",
      "The stars are studying too.",
      "Warm tea, warm mind.",
      "You can rest after the timer.",
      "Not perfect. Just present.",
    ],
    ar: [
      "صفحة واحدة تكفي الآن.",
      "خطوات صغيرة، عقل ثابت.",
      "لست مضطراً للسرعة، فقط للاستمرار.",
      "المصباح مضاء والعالم هادئ، ابدأ.",
      "الانضباط: أن تختار ما تريده أكثر لا ما تريده الآن.",
      "التركيز رسالة حبّ لنفسك القادمة.",
      "تنفّس. اقرأ الجملة التالية.",
      "التقدم يختبئ في الصفحات التي كدت تتجاوزها.",
      "المطر بالخارج، الدفء بالداخل، استمر.",
      "لقد أنجزت أصعب من هذا الفصل.",
      "الساعة تدق وعقلك يزداد صفاءً.",
      "احضر لمن ستكونه غداً.",
      "كل ملاحظة وعد بأن تتذكّر.",
      "الهدوء نعومة، والنعومة سرعة.",
      "الفضول أهدأ قواك الخارقة.",
      "المكتب معبد الليلة.",
      "أنت القصة بين السطور المميّزة.",
      "بهدوء وجدية، ابدأ.",
      "الانتباه أندر هدية تمنحها.",
      "قطعة أخرى، انتصار آخر.",
      "النجوم تذاكر معك.",
      "شاي دافئ، عقل دافئ.",
      "ستستريح بعد المؤقت.",
      "ليس مثاليًا، فقط حاضرًا.",
    ],
    "ar-eg": [
      "صفحة واحدة بس دلوقتي.",
      "خطوات صغيّرة وعقل ثابت.",
      "مش لازم تكون سريع، بس كمّل.",
      "اللمبة ولعانة والدنيا هادية، يلا ذاكر.",
      "الانضباط إنك تختار اللي عايزه أكتر، مش اللي عايزه دلوقتي.",
      "التركيز جواب حب لنفسك بكرة.",
      "خد نفس، واقرا الجملة اللي بعدها.",
      "التقدم بيتخبى في الصفحات اللي كدت تعديها.",
      "الدنيا مطر برة، دفا جوة، كمّل.",
      "انت عملت حاجات أصعب من الفصل ده.",
      "الساعة بتدق وعقلك بيصفى.",
      "احضر عشان اللي هتبقاه بكرة.",
      "كل ملحوظة وعد إنك هتفتكر.",
      "الهدوء نعومة، والنعومة سرعة.",
      "الفضول أهدى قوة عندك.",
      "المكتب النهاردة زي المعبد.",
      "انت القصة اللي بين السطور.",
      "بهدوء وبجدية، ابدأ.",
      "الانتباه أندر هدية تقدر تديها.",
      "قطعة كمان، مكسب كمان.",
      "النجوم بتذاكر معاك.",
      "شاي دافي، عقل دافي.",
      "هترتاح بعد المؤقت.",
      "مش مثالي، بس حاضر.",
    ],
    es: [
      "Una página a la vez.",
      "Pasos pequeños, mente firme.",
      "No tienes que ser rápido, solo constante.",
      "La lámpara está encendida. El mundo, en silencio. Estudia.",
      "La disciplina es elegir lo que más quieres sobre lo que quieres ahora.",
      "Concentrarse es una carta de amor a tu yo futuro.",
      "Respira. Lee la siguiente frase.",
      "El progreso se esconde en las páginas que casi saltas.",
      "Lluvia fuera. Calidez dentro. Sigue.",
      "Has hecho cosas más difíciles que este capítulo.",
      "El reloj avanza. Tu mente se afila.",
      "Preséntate por la persona en la que te estás convirtiendo.",
      "Cada apunte es una promesa de recordar.",
      "Lento es suave. Suave es rápido.",
      "La curiosidad es el superpoder más silencioso.",
      "El escritorio es un templo esta noche.",
      "Eres la historia entre los subrayados.",
      "Suave, en serio — empieza.",
      "La atención es el regalo más raro.",
      "Un bloque más. Una victoria más.",
      "Las estrellas también estudian.",
      "Té caliente, mente cálida.",
      "Descansarás después del temporizador.",
      "No perfecto. Solo presente.",
    ],
    fr: [
      "Une page à la fois.",
      "Petits pas, esprit constant.",
      "Tu n'as pas besoin d'être rapide — juste régulier.",
      "La lampe est allumée. Le monde est calme. Étudie.",
      "La discipline, c'est choisir ce que tu veux le plus, pas ce que tu veux maintenant.",
      "La concentration est une lettre d'amour à ton futur toi.",
      "Respire. Lis la phrase suivante.",
      "Le progrès se cache dans les pages que tu allais sauter.",
      "Pluie dehors. Chaleur dedans. Continue.",
      "Tu as traversé plus dur que ce chapitre.",
      "L'horloge tourne. Ton esprit s'affine.",
      "Sois là pour celui que tu deviens.",
      "Chaque note est une promesse de se souvenir.",
      "Lent, c'est fluide. Fluide, c'est rapide.",
      "La curiosité est le plus discret des super-pouvoirs.",
      "Le bureau est un temple ce soir.",
      "Tu es l'histoire entre les surlignages.",
      "Doucement, sérieusement — commence.",
      "L'attention est le plus rare des cadeaux.",
      "Encore un chapitre. Encore une victoire.",
      "Les étoiles étudient aussi.",
      "Thé chaud, esprit chaud.",
      "Tu te reposeras après la minuterie.",
      "Pas parfait. Juste présent.",
    ],
  };

  const BACKGROUNDS = [
    { id: "city",   label: "City",   url: "/app/images/book-mode-bg.jpg" },
    { id: "rain",   label: "Rain",   url: "/app/images/book-mode-rain.jpg" },
    { id: "forest", label: "Forest", url: "/app/images/book-mode-forest.jpg" },
    { id: "cafe",   label: "Cafe",   url: "/app/images/book-mode-cafe.jpg" },
    { id: "beach",  label: "Beach",  url: "/app/images/book-mode-beach.jpg" },
    { id: "train",  label: "Train",  url: "/app/images/book-mode-train.jpg" },
  ];
  const BG_LS_KEY = "omn-book-bg";
  function getSelectedBg() {
    try {
      const saved = localStorage.getItem(BG_LS_KEY);
      const hit = BACKGROUNDS.find(b => b.id === saved);
      if (hit) return hit;
    } catch (_) {}
    return BACKGROUNDS[0];
  }
  function setSelectedBg(id) {
    const hit = BACKGROUNDS.find(b => b.id === id);
    if (!hit) return;
    try { localStorage.setItem(BG_LS_KEY, id); } catch (_) {}
    // Don't override the shared party background if we're in a party
    const inParty = window.StudyParty && window.StudyParty.isInParty && window.StudyParty.isInParty();
    if (!inParty) {
      const bg = document.querySelector("#book-mode-overlay .book-bg");
      if (bg) bg.style.backgroundImage = `url("${hit.url}")`;
    }
    document.querySelectorAll(".book-bg-thumb").forEach(t => {
      t.classList.toggle("active", t.dataset.bg === id);
    });
  }
  // Expose for StudyParty to snapshot/restore personal choice
  window.getSelectedBookBg = getSelectedBg;
  window.setSelectedBookBg = function (bgOrId) {
    if (!bgOrId) return;
    const id = typeof bgOrId === "string" ? bgOrId : bgOrId.id;
    setSelectedBg(id);
    const hit = BACKGROUNDS.find(b => b.id === id);
    const bg = document.querySelector("#book-mode-overlay .book-bg");
    if (bg && hit) bg.style.backgroundImage = `url("${hit.url}")`;
  };


  const LOFI_URL = "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3?filename=lofi-study-112191.mp3";
  const RAIN_URL = "https://cdn.pixabay.com/download/audio/2022/03/10/audio_e3d5f8a2fb.mp3?filename=rain-and-thunder-16705.mp3";

  function getLang() {
    try {
      // Motivation quotes follow Interface Language, not AI/document language.
      const candidates = [];
      if (typeof window.getUiLanguage === "function") candidates.push(window.getUiLanguage());
      if (window.db && window.db.settings) candidates.push(window.db.settings.uiLanguage);
      try { candidates.push(localStorage.getItem("omnote_ui_language")); } catch (_) {}
      candidates.push(document.documentElement.getAttribute("data-ui-lang"));

      for (const raw of candidates) {
        const l = (raw || "").toLowerCase();
        if (l && QUOTES[l]) return l;
        if (l.startsWith("ar")) return "ar";
        if (l.startsWith("es")) return "es";
        if (l.startsWith("fr")) return "fr";
      }
    } catch (_) {}
    return "en";
  }

  function pickQuote() {
    const arr = QUOTES[getLang()] || QUOTES.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function buildScene() {
    const bg = getSelectedBg();
    const dust = Array.from({ length: 22 }).map((_, i) =>
      `<span style="--i:${i};--x:${Math.random() * 100}%;--d:${(Math.random() * 22 + 24).toFixed(1)}s;--dl:${(Math.random() * -30).toFixed(1)}s"></span>`
    ).join("");
    return `
      <div class="book-bg" style="background-image:url('${bg.url}')" aria-hidden="true"></div>
      <div class="book-bg-tint" aria-hidden="true"></div>
      <div class="book-grain" aria-hidden="true"></div>

      <div class="book-vignette" aria-hidden="true"></div>
      <div class="book-dust" aria-hidden="true">${dust}</div>
    `;
  }

  function buildOverlay() {
    const el = document.createElement("div");
    el.id = "book-mode-overlay";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Book Mode");
    el.innerHTML = `
      ${buildScene()}

      <div class="book-topbar">
        <div class="book-brand">
          <i data-lucide="book-open"></i>
          <span>Om Space</span>
        </div>
        <div class="book-topbar-actions">
          <div class="book-bg-picker" id="book-bg-picker">
            <button class="book-chip" id="book-bg-toggle" title="Change scene"><i data-lucide="image"></i></button>
            <div class="book-bg-thumbs" role="menu">
              ${BACKGROUNDS.map(b => `
                <button class="book-bg-thumb${b.id === getSelectedBg().id ? " active" : ""}" data-bg="${b.id}" title="${b.label}" style="background-image:url('${b.url}')">
                  <span class="book-bg-thumb-label">${b.label}</span>
                </button>`).join("")}
            </div>
          </div>
          <button class="book-chip${lofiAudio && !lofiAudio.paused ? ' active' : ''}" id="book-audio-lofi" title="Lofi music"><i data-lucide="music-2"></i></button>
          <button class="book-chip${rainAudio && !rainAudio.paused ? ' active' : ''}" id="book-audio-rain" title="Rain"><i data-lucide="cloud-drizzle"></i></button>
          <button class="book-chip" id="book-party" title="Study Together"><i data-lucide="users"></i><span>party</span></button>
          <button class="book-chip book-chip-exit" id="book-exit" title="Exit (Esc)"><i data-lucide="x"></i><span>exit</span></button>

        </div>
      </div>


      <div class="book-stage">
        <div class="book-timer-card">
          <div class="book-phase" id="book-phase">focus session</div>
          <div class="book-clock" id="book-clock">25:00</div>
          <div class="book-timer-controls">
            <button class="book-timer-btn" id="book-reset" title="Reset"><i data-lucide="rotate-ccw"></i></button>
            <button class="book-timer-btn book-timer-btn-lg" id="book-play" title="Start / Pause"><i data-lucide="play"></i></button>
            <button class="book-timer-btn" id="book-skip" title="Skip"><i data-lucide="skip-forward"></i></button>
          </div>
        </div>

        <div class="book-quote-note" id="book-quote-card">
          <span class="book-tape"></span>
          <div class="book-quote" id="book-quote">${pickQuote()}</div>
        </div>
      </div>


    `;
    document.body.appendChild(el);
    bindControls(el);
    if (window.lucide) window.lucide.createIcons();
    return el;
  }

  function bindControls(root) {
    root.querySelector("#book-exit").addEventListener("click", () => setBookMode(false));
    root.querySelector("#book-play").addEventListener("click", () => { try { window.togglePomo && window.togglePomo(); } catch (_) {} });
    root.querySelector("#book-reset").addEventListener("click", () => { try { window.resetPomo && window.resetPomo(); } catch (_) {} });
    root.querySelector("#book-skip").addEventListener("click", () => { try { window.skipPomo && window.skipPomo(); } catch (_) {} });

    root.querySelector("#book-audio-lofi").addEventListener("click", () => toggleAudio("lofi"));
    root.querySelector("#book-audio-rain").addEventListener("click", () => toggleAudio("rain"));
    const partyBtn = root.querySelector("#book-party");
    if (partyBtn) partyBtn.addEventListener("click", () => {
      if (window.StudyParty && typeof window.StudyParty.togglePanel === "function") {
        try { window.StudyParty.togglePanel(); }
        catch (e) { console.error("[StudyParty] togglePanel failed:", e); alert("Study Together failed to open. Please refresh the page."); }
      } else {
        console.error("[StudyParty] not loaded — study-party.js missing or failed to execute.");
        alert("Study Together isn't loaded yet. Please hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).");
      }
    });



    // Background picker
    const picker = root.querySelector("#book-bg-picker");
    root.querySelector("#book-bg-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      picker.classList.toggle("open");
    });
    root.querySelectorAll(".book-bg-thumb").forEach(t => {
      t.addEventListener("click", () => {
        setSelectedBg(t.dataset.bg);
        picker.classList.remove("open");
      });
    });
    document.addEventListener("click", (e) => {
      if (picker && !picker.contains(e.target)) picker.classList.remove("open");
    });



  }

  function toggleAudio(kind) {
    const url = kind === "lofi" ? LOFI_URL : RAIN_URL;
    const btnId = kind === "lofi" ? "book-audio-lofi" : "book-audio-rain";
    const btn = document.getElementById(btnId);
    const cur = kind === "lofi" ? lofiAudio : rainAudio;
    if (cur && !cur.paused) {
      cur.pause();
      btn && btn.classList.remove("active");
      return;
    }
    let a = cur;
    if (!a) {
      a = new Audio(url);
      a.loop = true;
      a.volume = kind === "lofi" ? 0.35 : 0.4;
      a.crossOrigin = "anonymous";
      if (kind === "lofi") lofiAudio = a; else rainAudio = a;
    }
    a.play().then(() => { btn && btn.classList.add("active"); }).catch(() => {});
  }

  function stopAllAudio() {
    [lofiAudio, rainAudio].forEach((a) => { if (a && !a.paused) a.pause(); });
    document.getElementById("book-audio-lofi")?.classList.remove("active");
    document.getElementById("book-audio-rain")?.classList.remove("active");
  }

  async function onChatSubmit(e) {
    e.preventDefault();
    const input = document.getElementById("book-chat-input");
    const log = document.getElementById("book-chat-log");
    const q = (input.value || "").trim();
    if (!q) return;
    input.value = "";
    const userEl = document.createElement("div");
    userEl.className = "book-chat-msg book-chat-user";
    userEl.textContent = q;
    log.appendChild(userEl);
    const botEl = document.createElement("div");
    botEl.className = "book-chat-msg book-chat-bot book-chat-loading";
    botEl.textContent = "…";
    log.appendChild(botEl);
    log.scrollTop = log.scrollHeight;

    try {
      if (typeof window.aiTask !== "function") throw new Error("AI unavailable");
      const res = await window.aiTask("chat_tutor", { context: "", question: q });
      if (res && typeof res === "object" && res._error) {
        botEl.classList.remove("book-chat-loading");
        botEl.textContent = res._error;
      } else {
        const text = typeof res === "string" ? res : String(res || "");
        botEl.classList.remove("book-chat-loading");
        if (window.marked && window.DOMPurify) {
          botEl.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
        } else {
          botEl.textContent = text;
        }
      }
    } catch (err) {
      botEl.classList.remove("book-chat-loading");
      botEl.textContent = (err && err.message) || "Something went wrong.";
    }
    log.scrollTop = log.scrollHeight;
  }

  function tickClock() {
    if (!active) return;
    const pill = document.getElementById("pomo-pill-time");
    const clock = document.getElementById("book-clock");
    const phase = document.getElementById("book-phase");
    if (clock && pill) {
      const t = (pill.textContent || "").trim();
      // Show mm:ss only; fall back to "25:00" if the pill shows a label.
      clock.textContent = /^\d{1,2}:\d{2}$/.test(t) ? t : "25:00";
    }
    if (phase) {
      // Detect play state by looking at the pill play icon (pause icon = running)
      const play = document.getElementById("pomo-pill-play");
      let running = false;
      if (play) {
        running = !!play.querySelector('[data-lucide="pause"], .lucide-pause') || play.textContent.includes('⏸');
      }
      const playBtn = document.getElementById("book-play");
      if (playBtn) {
        const isCurrentlyRunning = playBtn.classList.contains("running");
        if (running !== isCurrentlyRunning) {
          if (running) {
            playBtn.classList.add("running");
            playBtn.innerHTML = '<i data-lucide="pause"></i>';
          } else {
            playBtn.classList.remove("running");
            playBtn.innerHTML = '<i data-lucide="play"></i>';
          }
          if (window.lucide) window.lucide.createIcons({root: playBtn});
        }
      }
    }
    tickRAF = requestAnimationFrame(tickClock);
  }

  function refreshPlayIcon() {
    if (window.lucide) window.lucide.createIcons();
  }

  function rotateQuote() {
    const el = document.getElementById("book-quote");
    if (!el) return;
    el.classList.add("fading");
    setTimeout(() => {
      el.textContent = pickQuote();
      el.classList.remove("fading");
    }, 400);
  }

  function setBookMode(on) {
    if (on === active) return;
    // Mutually exclusive with Focus Mode
    if (on && document.body.classList.contains("focus-mode")) {
      try { window.setFocusMode && window.setFocusMode(false); } catch (_) {}
    }
    active = !!on;
    document.body.classList.toggle("book-mode", active);
    const btn = document.getElementById("book-mode-btn");
    if (btn) {
       btn.classList.toggle("active", active);
       if (active) btn.classList.remove("running-bg");
    }
    try { localStorage.setItem("omn-book-mode", active ? "1" : "0"); } catch (_) {}

    if (active) {
      overlay = buildOverlay();
      requestAnimationFrame(() => overlay.classList.add("visible"));
      
      // If we are in a party, let study-party apply its background over our personal one
      if (window.StudyParty && window.StudyParty.isInParty()) {
         try { window.StudyParty.applySharedBackground(window.StudyParty.getSharedBackground()); } catch(e) {}
      }

      tickRAF = requestAnimationFrame(tickClock);
      quoteTimer = setInterval(rotateQuote, 20000);
      // rebuild lucide after 1 frame
      setTimeout(refreshPlayIcon, 50);
    } else {
      if (quoteTimer) { clearInterval(quoteTimer); quoteTimer = null; }
      if (tickRAF) { cancelAnimationFrame(tickRAF); tickRAF = null; }
      // Removed stopAllAudio() and StudyParty.leaveParty(true) so they continue in background
      const pp = document.getElementById("study-party-panel");
      if (pp) pp.classList.add("hidden");
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;

      // Check if anything is running in the background
      const inParty = window.StudyParty && window.StudyParty.isInParty();
      const hasAudio = (lofiAudio && !lofiAudio.paused) || (rainAudio && !rainAudio.paused);
      if (btn) btn.classList.toggle("running-bg", inParty || hasAudio);
    }

  }

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable);
    if (e.key === "Escape" && active) { setBookMode(false); return; }
    if (typing) return;
    if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setBookMode(!active);
    }
  });

  // Restore on load
  window.addEventListener("load", () => {
    try {
      if (localStorage.getItem("omn-book-mode") === "1") {
        // Wait briefly for other modules (auth, pomo) to initialize
        setTimeout(() => setBookMode(true), 800);
      }
    } catch (_) {}
  });

  window.toggleBookMode = () => setBookMode(!active);
  window.setBookMode = setBookMode;
  window.isBookModeActive = () => active;

  // Delegated fallback: guarantees the party button responds even if the
  // per-render click listener didn't attach for any reason (icon SVG swap,
  // race with lucide, overlay rebuild timing, etc.).
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("#book-party");
    if (!btn) return;
    console.log("[BookMode] party button clicked (delegated)");
    e.preventDefault();
    e.stopPropagation();
    if (window.StudyParty && typeof window.StudyParty.togglePanel === "function") {
      try { window.StudyParty.togglePanel(); }
      catch (err) {
        console.error("[StudyParty] togglePanel threw:", err);
        alert("Study Together failed to open: " + (err && err.message || err));
      }
    } else {
      console.error("[StudyParty] module missing on window. Scripts:",
        [...document.querySelectorAll('script[src*=study-party]')].map(s => s.src));
      alert("Study Together isn't loaded yet. Please hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).");
    }
  }, true);
})();
