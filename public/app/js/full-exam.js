/* Full Document Exam — real-exam simulation across the WHOLE document.
   - A–E single-best-answer questions, ultra hard, linking multiple sections
   - Auto-sized question count + countdown timer
   - Instant reveal + explanation per question (same as chunk exam)
   - Score report at the end, retake, and saved attempt history
   Stored on the active doc as:
     doc.fullExam         = { questions, generatedAt, totalSeconds }
     doc.fullExamAttempts = [{ ts, score, total, percent, secondsUsed, perQuestion }]
*/
(function () {
  const SEC_PER_Q = 90;
  const MAX_ATTEMPTS_KEPT = 20;
  const BATCH_SIZE = 12;

  function esc(s) {
    if (window.escapeHTML) return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const doc_ = () => (window.getActiveDoc ? window.getActiveDoc() : null);
  const save = () => { if (window.saveDb) window.saveDb(); };

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Fallback size if the AI blueprint call fails: ~3 questions per section.
  function fallbackCount(doc) {
    const sections = (doc && doc.sections) || [];
    const chars = sections.reduce((a, s) => a + String(s.chunkText || '').length, 0)
      || String((doc && doc.pdfContextText) || '').length;
    return Math.max(10, Math.min(150, Math.max(sections.length * 3, Math.round(chars / 900))));
  }

  function showBar(pct) {
    const el = content();
    if (!el) return;
    el.innerHTML = `<div class="usmle-question-card fdx-loading">
        <div class="fdx-bar"><div class="fdx-bar-fill" style="width:${Math.max(4, Math.min(99, pct || 0))}%"></div></div>
      </div>`;
  }

  function content() { return document.getElementById('exam-modal-content'); }

  // ---------------- Setup screen ----------------

  window.openFullDocExam = function () {
    const doc = doc_();
    if (!doc || !doc.sections || !doc.sections.length) {
      return alert('Please upload a PDF and generate a study plan first.');
    }
    openFullDocExamFlow();
  };

  async function openFullDocExamFlow() {
    window.openFullscreen('exam-modal');
    stopTimer();
    renderSetup();
  }

  // Blueprint (AI decides count + timing) then generate, in one flow.
  async function planAndGenerate() {
    const doc = doc_();
    if (!doc) return;
    showBar(0);
    if (!doc.fullExamPlan) {
      const reply = await window.aiTask('exam_blueprint_full_doc', {
        docTitle: doc.name || doc.title || 'Document',
        sectionList: (doc.sections || []).map((s, i) => `${i + 1}. ${s.title}`).join('\n'),
        combinedText: docText(doc),
      });
      const data = reply && !reply._error
        ? (window.parseAIJson ? window.parseAIJson(reply) : safeParse(reply))
        : null;
      const n = data && Number(data.count);
      doc.fullExamPlan = {
        count: n && isFinite(n) ? Math.max(10, Math.min(150, Math.round(n))) : fallbackCount(doc),
        secondsPerQuestion: data && Number(data.secondsPerQuestion)
          ? Math.max(60, Math.min(150, Math.round(Number(data.secondsPerQuestion))))
          : SEC_PER_Q,
        rationale: (data && data.rationale) || '',
      };
      save();
    }
    const plan = doc.fullExamPlan;
    await generate(plan.count, plan.count * plan.secondsPerQuestion);
  }

  function renderSetup() {
    const doc = doc_();
    const el = content();
    if (!el) return;
    const cached = doc.fullExam && doc.fullExam.questions && doc.fullExam.questions.length
      ? doc.fullExam : null;
    const count = cached ? cached.questions.length : null;
    const totalSeconds = cached ? (cached.totalSeconds || count * SEC_PER_Q) : null;
    const attempts = (doc.fullExamAttempts || []).slice().reverse();
    const best = attempts.reduce((b, a) => (b === null || a.percent > b ? a.percent : b), null);

    const sidebar = document.getElementById('exam-sidebar');
    if (sidebar) sidebar.innerHTML = '';
    const totalEl = document.getElementById('exam-total-num');
    if (totalEl) totalEl.textContent = count || '–';
    const navCounter = document.getElementById('exam-nav-counter');
    if (navCounter) navCounter.textContent = '– / –';
    const blockEl = document.getElementById('exam-block-info');
    if (blockEl) blockEl.textContent = 'Full Document';
    setTimerText('Not started');

    el.innerHTML = `
      <div class="usmle-question-card fdx-setup">
        <div class="usmle-question-num">Full Document Exam</div>
        <h2 style="margin:6px 0 4px; font-size:1.4rem;">${esc(doc.name || doc.title || 'Your document')}</h2>
        <p style="color:#555; margin-bottom:18px;">
          A final-style paper across the entire document: 5 options (A–E), single best answer.
          Answers and explanations appear as you go — the timer keeps running.
        </p>
        ${cached ? `
        <div class="fdx-stats">
          <div class="fdx-stat"><span>${count}</span><small>Questions</small></div>
          <div class="fdx-stat"><span>${fmt(totalSeconds)}</span><small>Time limit</small></div>
          <div class="fdx-stat"><span>${(doc.sections || []).length}</span><small>Sections covered</small></div>
          ${best !== null ? `<div class="fdx-stat"><span>${best}%</span><small>Best score</small></div>` : ''}
        </div>` : ''}
        <div class="fdx-actions">
          ${cached
            ? `<button class="usmle-proceed-btn" id="fdx-start">Start Exam (${count} questions)</button>`
            : `<button class="usmle-proceed-btn" id="fdx-generate">Generate Exam</button>`}
        </div>
        ${attempts.length ? `
          <div class="fdx-history">
            <h3>Past attempts</h3>
            <table>
              <thead><tr><th>#</th><th>Date</th><th>Score</th><th>%</th><th>Time used</th><th></th></tr></thead>
              <tbody>
                ${attempts.map((a, i) => `
                  <tr class="${a.percent === best ? 'is-best' : ''}">
                    <td>${attempts.length - i}</td>
                    <td>${esc(new Date(a.ts).toLocaleString())}</td>
                    <td>${a.score} / ${a.total}</td>
                    <td>${a.percent}%</td>
                    <td>${fmt(a.secondsUsed)}</td>
                    <td>${attemptQuestions(a)
                        ? `<button class="fdx-review-btn" data-ts="${a.ts}">Review answers</button>`
                        : ''}</td>

                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : ''}
      </div>`;

    const gen = document.getElementById('fdx-generate');
    if (gen) gen.onclick = () => planAndGenerate();
    const start = document.getElementById('fdx-start');
    if (start) start.onclick = () => startExam(cached.questions, totalSeconds);
    el.querySelectorAll('.fdx-review-btn').forEach((btn) => {
      btn.onclick = () => {
        const ts = Number(btn.getAttribute('data-ts'));
        const a = (doc.fullExamAttempts || []).find((x) => x.ts === ts);
        if (a) reviewAttempt(a);
      };
    });
    if (window.lucide) window.lucide.createIcons();
  }

  // ---------------- Attempt review (read-only) ----------------

  // Attempts store only the question ORDER (indices into doc.fullExam.questions)
  // plus the answers, so the saved profile never blows past the cloud size limit.
  function attemptQuestions(attempt) {
    if (Array.isArray(attempt.questions) && attempt.questions.length) return attempt.questions; // legacy
    const doc = doc_();
    const base = (doc && doc.fullExam && doc.fullExam.questions) || [];
    if (!base.length) return null;
    const order = Array.isArray(attempt.order) ? attempt.order : base.map((_, i) => i);
    const qs = order.map((i) => base[i]).filter(Boolean);
    return qs.length ? qs : null;
  }

  function reviewAttempt(attempt) {
    const qs = attemptQuestions(attempt);
    if (!qs) return alert('This attempt can no longer be reviewed — its exam paper is missing.');
    stopTimer();
    removeFinishBar();
    finished = true;
    window.openFullscreen('exam-modal');
    const answers = {};
    Object.keys(attempt.answers || {}).forEach((k) => { answers[Number(k)] = attempt.answers[k]; });
    window.renderExamQuestions(qs, {
      blockLabel: 'Review — ' + new Date(attempt.ts).toLocaleString(),
      answers,
      review: true,
    });
    setTimerText(`Reviewed attempt — ${attempt.score}/${attempt.total} (${attempt.percent}%)`);
    addBackBar(() => renderSetup());
  }


  function addBackBar(onBack) {
    const bar = document.querySelector('#exam-modal .usmle-action-bar');
    if (!bar || document.getElementById('fdx-back-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'fdx-back-btn';
    btn.className = 'usmle-proceed-btn';
    btn.style.background = '#475569';
    btn.textContent = 'Back';
    btn.onclick = () => { btn.remove(); onBack(); };
    bar.insertBefore(btn, bar.firstChild);
  }
  function removeBackBar() {
    const b = document.getElementById('fdx-back-btn');
    if (b) b.remove();
  }


  // ---------------- Generation ----------------

  function docText(doc) {
    let out = '';
    (doc.sections || []).forEach((sec, i) => {
      out += `\n\n--- SECTION ${i + 1}: ${sec.title} ---\n\n${sec.chunkText || ''}`;
    });
    return out || (doc.pdfContextText || '');
  }

  async function generate(count, totalSeconds) {
    const doc = doc_();
    if (!doc) return;
    const el = content();
    const sectionList = (doc.sections || []).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    const combinedText = docText(doc);

    const batches = [];
    let remaining = count;
    while (remaining > 0) { batches.push(Math.min(BATCH_SIZE, remaining)); remaining -= BATCH_SIZE; }

    const questions = [];
    for (let b = 0; b < batches.length; b++) {
      showBar(Math.round((questions.length / count) * 100));
      const avoid = questions.slice(-20).map((q) => String(q.q || '').slice(0, 160)).join('\n');
      const reply = await window.aiTask('hard_exam_full_doc', {
        docTitle: doc.name || doc.title || 'Document',
        sectionList,
        count: batches[b],
        avoid,
        combinedText,
      });

      if (!reply || reply._error) {
        if (questions.length === 0) {
          const msg = reply ? reply._error : 'Unknown AI error';
          if (el) {
            el.innerHTML = `<div class="usmle-question-card" style="text-align:center;">
                <div style="color:#b91c1c; font-weight:700; margin-bottom:10px;">Could not generate the exam</div>
                <div style="color:#555;">${esc(msg)}</div>
                <button class="usmle-proceed-btn" style="margin-top:18px;" onclick="window.openFullDocExam()">Try again</button>
              </div>`;
          }
          return;
        }
        break; // keep what we have
      }
      const data = window.parseAIJson ? window.parseAIJson(reply) : safeParse(reply);
      const got = (data && data.questions) || [];
      got.forEach((q) => {
        if (!q || !q.q || !Array.isArray(q.options) || q.options.length < 2) return;
        const key = String(q.q).slice(0, 120).toLowerCase();
        if (questions.some((x) => String(x.q).slice(0, 120).toLowerCase() === key)) return;
        questions.push(q);
      });
    }

    if (!questions.length) {
      if (el) el.innerHTML = `<div class="usmle-question-card" style="text-align:center;color:#b91c1c;">Failed to generate exam questions.</div>`;
      return;
    }

    const perQ = (doc.fullExamPlan && doc.fullExamPlan.secondsPerQuestion) || SEC_PER_Q;
    const seconds = questions.length * perQ;
    doc.fullExam = { questions, generatedAt: Date.now(), totalSeconds: seconds };
    save();
    if (window.renderAccordionSections) window.renderAccordionSections();
    startExam(questions, seconds);
  }

  function safeParse(txt) {
    try {
      const m = String(txt).match(/\{[\s\S]*\}/);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { return null; }
  }

  // ---------------- Timer ----------------

  let timerId = null;
  let endsAt = 0;
  let startedAt = 0;
  let running = false;

  function setTimerText(txt, cls) {
    const el = document.getElementById('exam-timer-display');
    if (!el) return;
    el.innerHTML = `<i data-lucide="clock" style="width:14px;height:14px;vertical-align:-2px;"></i> ${esc(txt)}`;
    el.className = cls || '';
    if (window.lucide) window.lucide.createIcons();
  }

  function stopTimer() {
    running = false;
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function startTimer(seconds) {
    stopTimer();
    running = true;
    startedAt = Date.now();
    endsAt = startedAt + seconds * 1000;
    tick();
    timerId = setInterval(tick, 1000);
  }

  function tick() {
    const left = (endsAt - Date.now()) / 1000;
    if (left <= 0) {
      setTimerText('Time is up', 'fdx-timer-danger');
      stopTimer();
      finish(true);
      return;
    }
    setTimerText(`Time Remaining: ${fmt(left)}`,
      left < 60 ? 'fdx-timer-danger' : left < 300 ? 'fdx-timer-warn' : '');
  }

  // ---------------- Exam run ----------------

  let activeQuestions = [];
  let activeSeconds = 0;
  let activeOrder = [];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startExam(questions, seconds, shuffled) {
    finished = false;
    removeBackBar();
    activeQuestions = shuffled ? shuffle(questions) : questions;
    activeSeconds = seconds || activeQuestions.length * SEC_PER_Q;
    const doc = doc_();
    const base = (doc && doc.fullExam && doc.fullExam.questions) || [];
    activeOrder = activeQuestions.map((q) => base.indexOf(q));
    if (activeOrder.some((i) => i < 0)) activeOrder = activeQuestions.map((_, i) => i);
    window.openFullscreen('exam-modal');


    window.renderExamQuestions(activeQuestions, {
      blockLabel: 'Full Document',
      timed: true,
      onAnswer: () => {
        addFinishBar();
        const st = window.getExamState();
        if (Object.keys(st.answers).length >= activeQuestions.length) {
          setTimeout(() => finish(false), 400);
        }
      },
    });
    addFinishBar();
    startTimer(activeSeconds);
  }
  window.startFullDocExam = startExam;

  function addFinishBar() {
    const bar = document.querySelector('#exam-modal .usmle-action-bar');
    if (!bar || document.getElementById('fdx-finish-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'fdx-finish-btn';
    btn.className = 'usmle-proceed-btn';
    btn.style.background = '#0f766e';
    btn.textContent = 'Finish & Score';
    btn.onclick = () => {
      const st = window.getExamState();
      const left = activeQuestions.length - Object.keys(st.answers).length;
      if (left > 0 && !confirm(`${left} question${left > 1 ? 's are' : ' is'} unanswered. Finish anyway?`)) return;
      finish(false);
    };
    bar.insertBefore(btn, bar.firstChild);
  }
  function removeFinishBar() {
    const b = document.getElementById('fdx-finish-btn');
    if (b) b.remove();
  }

  // ---------------- Results ----------------

  let finished = false;

  function finish(timedOut) {
    if (finished) return;
    finished = true;
    stopTimer();
    removeFinishBar();

    const st = window.getExamState();
    const total = activeQuestions.length;
    const secondsUsed = Math.min(activeSeconds, Math.round((Date.now() - startedAt) / 1000));
    const perQuestion = activeQuestions.map((q, i) => {
      const correctIdx = window.getBestMCQAnswerIndex(q);
      const sel = st.answers[i];
      return {
        idx: i,
        answered: sel !== undefined,
        correct: sel !== undefined && sel === correctIdx,
        sections: Array.isArray(q.sections) ? q.sections : [],
      };
    });
    const score = perQuestion.filter((p) => p.correct).length;
    const percent = total ? Math.round((score / total) * 100) : 0;

    const doc = doc_();
    if (doc) {
      doc.fullExamAttempts = (doc.fullExamAttempts || []).concat([{
        ts: Date.now(), score, total, percent, secondsUsed,
        perQuestion: perQuestion.map((p) => ({ i: p.idx, a: p.answered, c: p.correct })),
        // Store the question ORDER + answers only (questions stay in doc.fullExam),
        // so history stays small and always saves.
        order: activeOrder.slice(),
        answers: Object.assign({}, st.answers),
      }]).slice(-MAX_ATTEMPTS_KEPT);

      save();
      if (window.renderAccordionSections) window.renderAccordionSections();
    }

    renderResults({ score, total, percent, secondsUsed, perQuestion, timedOut });
  }


  function band(p) {
    if (p >= 85) return { label: 'Excellent', cls: 'fdx-band-great' };
    if (p >= 70) return { label: 'Pass', cls: 'fdx-band-pass' };
    if (p >= 50) return { label: 'Borderline', cls: 'fdx-band-warn' };
    return { label: 'Needs work', cls: 'fdx-band-fail' };
  }

  function renderResults(r) {
    const el = content();
    if (!el) return;
    setTimerText(r.timedOut ? 'Time is up' : `Finished in ${fmt(r.secondsUsed)}`);

    const weak = {};
    r.perQuestion.forEach((p) => {
      if (p.correct) return;
      (p.sections.length ? p.sections : ['Unlabelled']).forEach((s) => {
        weak[s] = (weak[s] || 0) + 1;
      });
    });
    const weakList = Object.keys(weak).sort((a, b) => weak[b] - weak[a]).slice(0, 6);
    const unanswered = r.perQuestion.filter((p) => !p.answered).length;
    const b = band(r.percent);

    el.innerHTML = `
      <div class="usmle-question-card fdx-results">
        <div class="usmle-question-num">Exam Result</div>
        <div class="fdx-score ${b.cls}">
          <div class="fdx-score-num">${r.percent}%</div>
          <div class="fdx-score-sub">${r.score} of ${r.total} correct — ${b.label}</div>
        </div>
        <div class="fdx-stats">
          <div class="fdx-stat"><span>${r.score}</span><small>Correct</small></div>
          <div class="fdx-stat"><span>${r.total - r.score - unanswered}</span><small>Incorrect</small></div>
          <div class="fdx-stat"><span>${unanswered}</span><small>Unanswered</small></div>
          <div class="fdx-stat"><span>${fmt(r.secondsUsed)}</span><small>Time used</small></div>
        </div>
        ${weakList.length ? `
          <div class="fdx-weak">
            <h3>Weakest areas</h3>
            <ul>${weakList.map((s) => `<li>${esc(s)} <span>${weak[s]} missed</span></li>`).join('')}</ul>
          </div>` : ''}
        <div class="fdx-review">
          <h3>Question review</h3>
          <div class="fdx-review-grid">
            ${r.perQuestion.map((p) => `
              <button class="fdx-chip ${p.correct ? 'ok' : p.answered ? 'bad' : 'skip'}" data-i="${p.idx}">${p.idx + 1}</button>
            `).join('')}
          </div>
          <p style="color:#666; font-size:0.85rem; margin-top:8px;">Click a number to revisit that question with your answer and its full explanation.</p>
        </div>
        <div class="fdx-actions">
          <button class="usmle-proceed-btn" id="fdx-retake">Retake This Exam</button>
          <button class="usmle-proceed-btn" id="fdx-attempts" style="background:#475569;">Attempts &amp; Answers</button>
          <button class="usmle-proceed-btn usmle-btn-end" onclick="window.closeFullscreen('exam-modal')">Exit</button>
        </div>
      </div>`;

    el.querySelectorAll('.fdx-chip').forEach((chip) => {
      chip.onclick = () => {
        window.gotoExamQuestion(parseInt(chip.getAttribute('data-i'), 10));
        addBackBar(() => renderResults(r));
      };
    });
    const retake = document.getElementById('fdx-retake');
    if (retake) retake.onclick = () => startExam(activeQuestions, activeSeconds, true);
    const attemptsBtn = document.getElementById('fdx-attempts');
    if (attemptsBtn) attemptsBtn.onclick = () => { removeBackBar(); renderSetup(); };
    if (window.lucide) window.lucide.createIcons();
  }

  // Stop the clock if the user closes the exam overlay.
  const origClose = window.closeFullscreen;
  window.closeFullscreen = function (id) {
    if (id === 'exam-modal') { stopTimer(); removeFinishBar(); removeBackBar(); }

    if (typeof origClose === 'function') return origClose(id);
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  };
})();
