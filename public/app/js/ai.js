// AI Communication Logic
// API keys live server-side (Firestore admin/api_keys). All calls go through
// window.aiCall (see ai-client.js), which posts to /api/ai with the user's
// Firebase ID token. The functions below preserve the legacy signatures so
// call sites in summary.js, editor.js, pdf.js keep working unchanged.

// Local escape for interpolating untrusted strings (server error messages,
// AI-generated titles, user-derived topic names) into template-literal HTML.
// Prefer this over raw ${x} whenever the value isn't a number/boolean/known
// static string. Falls back to a minimal escape if window.escapeHTML isn't
// loaded yet.
function _esc(s) {
    if (window.escapeHTML) return window.escapeHTML(s);
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Legacy stubs — key management now happens in the admin panel.
window.GEMINI_API_KEYS = [];
window.addApiKey = function () { return false; };
window.removeApiKey = function () { return false; };
window.testApiKey = async function () {
    return { success: false, message: "Keys are managed in the Admin Panel." };
};

async function callGroqAPI(messages, requireJson = false, maxRetries = 10) {
    // Despite the historical name, this is the main (Gemini) generator.
    const reply = await window.aiCall({
        provider: "gemini",
        messages,
        requireJson,
        temperature: 0.3,
        maxRetries,
    });
    return reply;
}

async function callFastGroqAPI(messages, requireJson = false) {
    const reply = await window.aiCall({
        provider: "groq",
        messages,
        requireJson,
        temperature: 0.3,
        maxRetries: 3,
    });
    // Legacy contract: fast path returned null (not { _error }) on failure.
    if (reply && typeof reply === "object" && reply._error) {
        console.error("Fast AI error:", reply._error);
        return null;
    }
    return reply;
}

// Helper to extract JSON if the model wraps it in markdown blocks
function parseAIJson(reply) {
    if (!reply || typeof reply !== 'string') return null;
    try {
        return JSON.parse(reply);
    } catch (e) {
        let cleaned = reply.replace(/```json/gi, '').replace(/```/g, '').trim();
        try {
            return JSON.parse(cleaned);
        } catch (e2) {
            // Fallback: extract the first {...} block from prose
            const first = cleaned.indexOf('{');
            const last = cleaned.lastIndexOf('}');
            if (first !== -1 && last > first) {
                try {
                    return JSON.parse(cleaned.substring(first, last + 1));
                } catch (e3) {}
            }
            console.error("Failed to parse JSON even after cleanup", reply);
            return null;
        }
    }
}


window.generateStudyPlan = async function(text, filename, docLang) {
    if(!getActiveDoc()) return;
    getActiveDoc().pdfContextText = text;
    if (docLang) getActiveDoc().docLang = docLang;
    const currentPdfText = getActiveDoc().pdfContextText;
    const activeDocLang = docLang || getActiveDoc().docLang || null;

    // Switch right view to Study Plan (learn-view)
    window.switchRightView('learn-view', document.querySelectorAll('.right-tabs .right-tab-item')[1]);
    window.showLoadingScreen("Analyzing Document Structure...");
    document.getElementById('accordion-container').innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:50px;">Generating premium study plan...</div>';

    // Reset summary content so it doesn't say "Generating..." forever
    document.getElementById('summary-content').innerHTML = '<div style="color: var(--text-muted); margin-top: 50px; text-align: center;">Click "Read Summary" on a topic in your Study Plan to generate a detailed summary.</div>';

    // Generate JSON Study Plan Sections
    const reply = await window.aiTask("chunk_plan", { filename, text }, activeDocLang ? { lang: activeDocLang } : undefined);

    // We do not hide loading screen here because we will immediately start generating summaries.
    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.sections) {
            
            // --- SEMANTIC TEXT SLICING LOGIC ---
            const sections = data.sections;
            let indices = [];
            
            for (let i = 0; i < sections.length; i++) {
                const quote = sections[i].start_quote;
                let idx = -1;
                if (quote) {
                    idx = currentPdfText.indexOf(quote);
                    if (idx === -1) {
                        const words = quote.split(' ').slice(0, 5).join(' ');
                        idx = currentPdfText.indexOf(words);
                    }
                }
                indices.push(idx);
            }
            
            // Fix invalid indices
            for (let i = 0; i < indices.length; i++) {
                if (indices[i] === -1) {
                    indices[i] = Math.floor((i / sections.length) * currentPdfText.length);
                }
            }
            
            // Ensure sequential order
            indices.sort((a,b) => a-b);
            
            // Slice the chunks!
            for (let i = 0; i < sections.length; i++) {
                const start = indices[i];
                const end = (i + 1 < sections.length) ? indices[i+1] : currentPdfText.length;
                sections[i].chunkText = currentPdfText.substring(start, end) || "No text could be extracted for this chunk.";
            }
            
            getActiveDoc().sections = sections;
            saveDb();
            if (window.renderAccordionSections) window.renderAccordionSections();

            // --- BATCH SUMMARIZATION & REVIEW ---
            for (let i = 0; i < sections.length; i++) {
                const sec = sections[i];
                window.showLoadingScreen(`Summarizing section ${i+1} of ${sections.length}: ${sec.title}...`);

                // Sleep to avoid rate limits
                await new Promise(r => setTimeout(r, 2000));

                let finalSummary = await window.aiTask("topic_summary_draft", {
                    title: sec.title,
                    chunkText: sec.chunkText,
                }, activeDocLang ? { lang: activeDocLang } : undefined);
                if (!finalSummary || finalSummary._error) {
                    console.error("Summary generation failed for section", sec.title);
                    continue;
                }

                sec.summaryCache = finalSummary;
                sec.summaryRead = true;
                saveDb();
                if (window.renderAccordionSections) window.renderAccordionSections();
            }

            
            window.hideLoadingScreen();
        } else {
            window.hideLoadingScreen();
            document.getElementById('accordion-container').innerHTML = '<div style="padding: 20px; color: red;">Failed to parse study plan from AI.</div>';
        }
    } else {
        const errMsg = reply ? reply._error : "Unknown AI Error";
        window.hideLoadingScreen();
        document.getElementById('accordion-container').innerHTML = `<div style="padding: 20px; color: red; text-align: center;"><b>API Error</b><br/>${_esc(errMsg)}<br/><br/>The PDF might be too large, or you hit the rate limit. Please wait 60 seconds and try again.</div>`;
    }
}

window.currentSummaryTopic = null;

window.regenerateCurrentSummary = function() {
    if (window.currentSummaryTopic) {
        window.readSummary(window.currentSummaryTopic, true);
    }
}

window.readSummary = async function(topic, forceRegenerate = false) {
    if (!getActiveDoc() || !getActiveDoc().pdfContextText) return alert("Please upload a PDF first.");
    
    window.currentSummaryTopic = topic;
    if (window.saveLastView) window.saveLastView({ summaryTopic: topic });
    
    // Switch left view to Summary
    window.switchLeftView('summary-view', document.querySelectorAll('#left-pane-tabs .left-tab-item')[1]);
    
    // Easy MCQs are now generated within the summary view itself
    
    // Check Cache
    const sec = getActiveDoc().sections.find(s => s.title === topic);
    
    const regenBtn = document.getElementById('btn-regenerate-summary');
    if (regenBtn) regenBtn.style.display = 'inline-block';
    const explainBtn = document.getElementById('btn-explain-summary');
    if (explainBtn) explainBtn.style.display = 'inline-block';
    
    if (!forceRegenerate && sec && (sec.summaryCacheHTML || sec.summaryCache)) {
        document.getElementById('summary-content').innerHTML = window.safeHTML(sec.summaryCacheHTML || marked.parse(sec.summaryCache));
        // If MCQ is cached, render it immediately. Otherwise, show the button.
        if (window.generateEasyMCQ && sec.mappedMcqCache) {
            window.renderMappedMCQs(sec.mappedMcqCache);
        }
        if (window.loadAnnotationForCurrent) setTimeout(window.loadAnnotationForCurrent, 50);

        return;
    }

    if (regenBtn) regenBtn.style.display = 'none';
    if (explainBtn) explainBtn.style.display = 'none';

    window.showLoadingScreen("Generating Summary...");
    document.getElementById('summary-content').innerHTML = `<div style="color:var(--text-muted); text-align:center;">Generating summary for <strong>${_esc(topic)}</strong>...</div>`;

    const activeDocLang2 = (getActiveDoc() && getActiveDoc().docLang) || null;
    let finalReply = await window.aiTask("topic_summary_draft", {
        title: topic,
        chunkText: sec.chunkText,
    }, activeDocLang2 ? { lang: activeDocLang2 } : undefined);
    if (!finalReply || finalReply._error) {
        window.hideLoadingScreen();
        const errMsg = finalReply ? finalReply._error : "Unknown AI Error";
        document.getElementById('summary-content').innerHTML = `<div style="color:red; text-align:center; padding: 20px;"><b>API Error</b><br/>${_esc(errMsg)}<br/><br/>Please wait a minute for rate limits to reset and try again.</div>`;
        if (regenBtn) regenBtn.style.display = 'inline-block';
        if (explainBtn) explainBtn.style.display = 'inline-block';
        return;
    }

    window.hideLoadingScreen();

    if (sec) {
        sec.summaryCache = finalReply;
        sec.summaryRead = true;
        saveDb();
        if(window.renderAccordionSections) window.renderAccordionSections();
    }
    document.getElementById('summary-content').innerHTML = window.safeHTML(marked.parse(finalReply));
    if (window.loadAnnotationForCurrent) setTimeout(window.loadAnnotationForCurrent, 50);

    if (regenBtn) regenBtn.style.display = 'inline-block';
    if (explainBtn) explainBtn.style.display = 'inline-block';
    
    // Topic quiz button removed per user request

}

window.generateCards = async function(topic) {
    if (!getActiveDoc() || !getActiveDoc().pdfContextText) return alert("Please upload a PDF first.");
    const sec = getActiveDoc().sections.find(s => s.title === topic);
    if (!sec) return alert("Topic not found.");
    
    window.showLoadingScreen("Extracting Flashcards...");
    const reply = await window.aiTask("flashcards_from_chunk", {
        title: topic,
        chunkText: sec.chunkText,
    });

    
    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.flashcards) {
            data.flashcards.forEach(card => {
                const isCloze = card.type === 'cloze' || (window.hasCloze && window.hasCloze(card.front));
                const rem = window.addFlashcardRem(activeDocId, card.front, isCloze ? '' : (card.back || ''), topic);
                if (rem) {
                    rem.sourceText = card.source || '';
                    rem.manual = false;
                    if (isCloze) rem.cardType = 'cloze';
                    if (String(card.explanation || '').trim()) rem.explanation = card.explanation;
                    if (Array.isArray(card.extras) && card.extras.length) rem.extras = card.extras;
                }
            });


            if (window.renderFlashcardsList) window.renderFlashcardsList();
            sec.flashcardsGenerated = true;
            saveDb();
            if(window.renderRems) window.renderRems();
            if(window.renderAccordionSections) window.renderAccordionSections();
            updateSRSQueue();
            
            window.hideLoadingScreen();
            if (typeof activeSession === 'undefined' || !activeSession) {
                alert("Flashcards generated! Click 'Practice' to study them now.");
            }
        } else {
            window.hideLoadingScreen();
        }
    } else {
        window.hideLoadingScreen();
    }
}

window.generateEasyMCQ = async function(topic) {
    let container = document.getElementById('summary-quiz-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'summary-quiz-container';
        container.style.marginTop = '40px';
        container.style.paddingTop = '20px';
        container.style.borderTop = '1px solid var(--border-medium)';
        document.getElementById('summary-content').parentNode.appendChild(container);
    }
    
    const sec = getActiveDoc().sections.find(s => s.title === topic);
    
    if (sec && sec.mappedMcqCache) {
        window.renderMappedMCQs(sec.mappedMcqCache);
        if (container) container.style.display = 'none';
        return;
    }
    
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:20px;">Generating targeted quizzes for each section...</div>';
    
    const summaryText = sec.summaryCache || sec.chunkText;

    const reply = await window.aiTask("summary_easy_mcq", { summaryText });

    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.quizzes) {
            if (sec) {
                sec.mappedMcqCache = data.quizzes;
                saveDb();
            }
            window.renderMappedMCQs(data.quizzes);
            container.innerHTML = '<div style="text-align:center; color:#22c55e; padding:20px;"><i data-lucide="check-circle-2"></i> Quizzes successfully distributed into the sections above!</div>';
        } else {
            container.innerHTML = '<div style="color:red; text-align:center;">Failed to generate MCQs.</div>';
        }
    } else {
        const errMsg = reply ? reply._error : "Unknown AI Error";
        container.innerHTML = `<div style="color:red; text-align:center; padding: 20px;"><b>API Error generating MCQs:</b><br/>${_esc(errMsg)}</div>`;
    }
}

window.renderMappedMCQs = function(quizzes) {
    const content = document.getElementById('summary-content');
    const children = Array.from(content.children);
    
    quizzes.forEach(quizGroup => {
        const headerText = quizGroup.header.trim().toLowerCase();
        let targetHeaderIdx = -1;
        
        for (let i = 0; i < children.length; i++) {
            const node = children[i];
            if (/^H[1-6]$/.test(node.tagName)) {
                if (node.innerText.trim().toLowerCase().includes(headerText) || headerText.includes(node.innerText.trim().toLowerCase())) {
                    targetHeaderIdx = i;
                    break;
                }
            }
        }
        
        if (targetHeaderIdx !== -1) {
            let endIdx = children.length;
            const targetLevel = parseInt(children[targetHeaderIdx].tagName.substring(1));
            
            for (let i = targetHeaderIdx + 1; i < children.length; i++) {
                if (/^H[1-6]$/.test(children[i].tagName)) {
                    const currentLevel = parseInt(children[i].tagName.substring(1));
                    if (currentLevel <= targetLevel) {
                        endIdx = i;
                        break;
                    }
                }
            }
            
            const quizWrap = document.createElement('div');
            quizWrap.className = 'section-quiz-wrap';
            quizWrap.style.margin = '20px 0 35px 0';
            quizWrap.style.padding = '20px';
            quizWrap.style.border = '1px dashed var(--border-medium)';
            quizWrap.style.borderRadius = '8px';
            quizWrap.style.background = 'rgba(255,255,255,0.02)';
            
            window.renderMCQs(quizGroup.mcqs, quizWrap, `Quiz: ${quizGroup.header}`);
            
            if (endIdx < children.length) {
                content.insertBefore(quizWrap, children[endIdx]);
            } else {
                content.appendChild(quizWrap);
            }
        }
    });
}

window.renderMCQs = function(mcqs, container, customTitle) {
    const title = customTitle || 'Topic Mini-Quiz';
    container.innerHTML = `<div style="font-size: 1.1rem; font-weight: bold; margin-bottom: 15px;">${_esc(title)}</div><div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 20px;">Test your knowledge on the section you just read:</div>`;
    mcqs.forEach((mcq, idx) => {
        const card = document.createElement('div');
        card.className = 'quiz-card';
        
        const correctIdx = window.getBestMCQAnswerIndex(mcq);
        
        let optionsHtml = '<div class="mcq-options-wrapper">';
        mcq.options.forEach((opt, oIdx) => {
            const isCorrect = (oIdx === correctIdx);
            const correctClass = isCorrect ? 'correct-opt' : '';
            optionsHtml += `
                <div class="${correctClass}" onclick="window.handleMCQClick(this, ${isCorrect})">
                    ${opt.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                </div>
            `;
        });
        optionsHtml += '</div>';
        
        card.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 10px;">${idx + 1}. ${mcq.q.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
            ${optionsHtml}
        `;
        container.appendChild(card);
    });
}

window.generateQuiz = async function(topic) {
    if (!getActiveDoc() || !getActiveDoc().pdfContextText) return alert("Please upload a PDF first.");
    
    window.openFullscreen('exam-modal');
    const container = document.getElementById('exam-modal-content');

    // Check Cache
    const sec = getActiveDoc().sections.find(s => s.title === topic);
    if (sec && sec.examCache) {
        renderExamQuestions(sec.examCache);
        return;
    }
    
    window.showLoadingScreen("Crafting Exam Questions...");
    container.innerHTML = `
        <div style="text-align:center; max-width:400px; margin: 80px auto;">
            <div style="font-weight:600; color:var(--text-primary); margin-bottom:15px; font-size:1.1rem;">Making ur exam only</div>
            <div style="width:100%; height:8px; background:var(--bg-secondary, #e2e8f0); border-radius:4px; overflow:hidden; position:relative;">
                <div style="position:absolute; top:0; left:0; height:100%; width:30%; background:linear-gradient(90deg, #06b6d4, #8b5cf6); border-radius:4px; animation: examLoadBar 2s infinite ease-in-out;"></div>
            </div>
            <div style="font-size:0.85rem; color:var(--text-muted); margin-top:15px;">Just making practice questions on your chunk...</div>
        </div>
        <style>
            @keyframes examLoadBar {
                0% { left: -30%; width: 30%; }
                50% { width: 50%; }
                100% { left: 100%; width: 30%; }
            }
        </style>
    `;
    
    const reply = await window.aiTask("hard_exam_from_chunk", {
        title: topic,
        chunkText: sec.chunkText,
    });

    window.hideLoadingScreen();
    
    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.questions) {
            if (sec) {
                sec.examCache = data.questions;
                sec.examTaken = true;
                saveDb();
                if(window.renderAccordionSections) window.renderAccordionSections();
            }
            renderExamQuestions(data.questions);
        } else {
            container.innerHTML = '<div style="color:red; text-align:center;">Failed to generate exam.</div>';
        }
    } else {
        const errMsg = reply ? reply._error : "Unknown AI Error";
        container.innerHTML = `<div style="color:red; text-align:center; padding: 20px;"><b>API Error</b><br/>${_esc(errMsg)}</div>`;
    }
}

// ============================================================
// USMLE EXAM RENDERER — Single-question navigation system
// ============================================================
let examQuestions = [];
let currentExamIdx = 0;
let examFlaggedSet = new Set();
let examAnsweredMap = {}; // idx -> selectedOptionIdx

let examOpts = {};

function renderExamQuestions(questions, opts) {
    examQuestions = questions;
    currentExamIdx = 0;
    examFlaggedSet = new Set();
    examAnsweredMap = (opts && opts.answers) ? Object.assign({}, opts.answers) : {};
    examOpts = opts || {};


    // Update header totals
    const totalEl = document.getElementById('exam-total-num');
    if (totalEl) totalEl.textContent = questions.length;
    const blockEl = document.getElementById('exam-block-info');
    if (blockEl) blockEl.textContent = examOpts.blockLabel || `1 of 1`;

    // Build sidebar
    buildExamSidebar();
    showExamQuestion();
}
window.renderExamQuestions = renderExamQuestions;

// Read-only snapshot of the running exam (used by the full-doc exam scorer).
window.getExamState = function () {
    return {
        questions: examQuestions,
        answers: Object.assign({}, examAnsweredMap),
        flagged: Array.from(examFlaggedSet),
        currentIdx: currentExamIdx,
    };
};
window.gotoExamQuestion = function (idx) {
    if (idx < 0 || idx >= examQuestions.length) return;
    currentExamIdx = idx;
    updateExamSidebarActive();
    showExamQuestion();
};


function buildExamSidebar() {
    const sidebar = document.getElementById('exam-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML = '';
    examQuestions.forEach((q, idx) => {
        const item = document.createElement('div');
        item.className = 'usmle-sidebar-item' + (idx === currentExamIdx ? ' active' : '');
        item.id = `exam-sidebar-item-${idx}`;
        item.textContent = idx + 1;
        if (examFlaggedSet.has(idx)) item.classList.add('flagged');
        if (examAnsweredMap[idx] !== undefined) item.classList.add('answered');
        item.onclick = () => { currentExamIdx = idx; updateExamSidebarActive(); showExamQuestion(); };
        sidebar.appendChild(item);
    });
}

function updateExamSidebarActive() {
    examQuestions.forEach((_, idx) => {
        const el = document.getElementById(`exam-sidebar-item-${idx}`);
        if (!el) return;
        el.classList.toggle('active', idx === currentExamIdx);
        el.classList.toggle('flagged', examFlaggedSet.has(idx));
        el.classList.toggle('answered', examAnsweredMap[idx] !== undefined);
    });
    const activeEl = document.getElementById(`exam-sidebar-item-${currentExamIdx}`);
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

// Builds the PLAB-style explanation panel shown after answering.
// Returns null for legacy cached questions that carry no explanation fields.
function buildExamExplainPanel(mcq, selectedIdx, correctIdx) {
    if (!mcq || (!mcq.explanation && !mcq.distractors && !mcq.tip)) return null;
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const panel = document.createElement('div');
    panel.className = 'usmle-explain-panel ' + (selectedIdx === correctIdx ? 'is-correct' : 'is-incorrect');

    let html = '';
    const correctText = (mcq.options && mcq.options[correctIdx]) || mcq.answer || '';
    html += `<div class="usmle-explain-verdict">${selectedIdx === correctIdx ? '✅ Correct' : '❌ Incorrect'} — Answer: ${esc(correctText)}</div>`;

    if (mcq.explanation) {
        html += `<div class="usmle-explain-section"><strong>Explanation</strong><p>${esc(mcq.explanation)}</p></div>`;
    }

    const d = mcq.distractors;
    if (d && typeof d === 'object') {
        const items = Object.keys(d)
            .filter((k) => String(d[k] || '').trim())
            .map((k) => {
                const li = String(k).trim().toUpperCase();
                const oIdx = letters.indexOf(li);
                const optText = oIdx >= 0 && mcq.options && mcq.options[oIdx] ? mcq.options[oIdx] : li;
                return `<li><strong>${esc(optText)}</strong> — ${esc(d[k])}</li>`;
            });
        if (items.length) {
            html += `<div class="usmle-explain-section"><strong>Why the others are wrong</strong><ul>${items.join('')}</ul></div>`;
        }
    }

    if (mcq.tip) {
        html += `<div class="usmle-explain-tip"><strong>OM-Note Tip:</strong> ${esc(mcq.tip)}</div>`;
    }
    if (mcq.source) {
        html += `<div class="usmle-explain-source">“${esc(mcq.source)}”</div>`;
    }

    panel.innerHTML = html;
    return panel;
}


function showExamQuestion() {
    const container = document.getElementById('exam-modal-content');
    if (!container || !examQuestions.length) return;
    
    const mcq = examQuestions[currentExamIdx];
    const correctIdx = window.getBestMCQAnswerIndex(mcq);
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    
    // Update top bar
    const currentNumEl = document.getElementById('exam-current-num');
    if (currentNumEl) currentNumEl.textContent = currentExamIdx + 1;
    const navCounter = document.getElementById('exam-nav-counter');
    if (navCounter) navCounter.textContent = `${currentExamIdx + 1} / ${examQuestions.length}`;
    
    // Flag button state
    const flagBtn = document.getElementById('exam-flag-btn');
    if (flagBtn) flagBtn.classList.toggle('flagged', examFlaggedSet.has(currentExamIdx));
    
    // Build question HTML
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'usmle-question-card';
    
    const qNum = document.createElement('div');
    qNum.className = 'usmle-question-num';
    qNum.textContent = `Question ${currentExamIdx + 1} of ${examQuestions.length}`;
    card.appendChild(qNum);
    
    const qBody = document.createElement('div');
    qBody.className = 'usmle-question-body';
    qBody.style.whiteSpace = 'pre-wrap';
    qBody.textContent = mcq.q;
    card.appendChild(qBody);

    
    // Options container
    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'usmle-mcq-options';
    const isReview = !!examOpts.review;
    const answeredHere = examAnsweredMap[currentExamIdx] !== undefined;
    optionsWrap.setAttribute('data-answered', (answeredHere || isReview) ? 'true' : 'false');

    mcq.options.forEach((opt, oIdx) => {
        const btn = document.createElement('button');
        btn.className = 'usmle-option';
        
        const letter = document.createElement('span');
        letter.className = 'usmle-opt-letter';
        letter.textContent = (letters[oIdx] || oIdx) + '.';
        btn.appendChild(letter);
        
        const txt = document.createTextNode(opt.replace(/^[A-Fa-f][.):] ?/, '').trim());
        btn.appendChild(txt);
        
        // If already answered (or reviewing a finished attempt), lock the options.
        if (answeredHere || isReview) {
            btn.style.cursor = 'default';
            btn.style.pointerEvents = 'none';
            if (oIdx === correctIdx) btn.classList.add('correct');
            else if (oIdx === examAnsweredMap[currentExamIdx]) btn.classList.add('incorrect');
        } else {
            btn.onclick = () => window.handleUsmleOptionClick(btn, oIdx, correctIdx, optionsWrap, currentExamIdx);
        }
        
        optionsWrap.appendChild(btn);
    });
    
    card.appendChild(optionsWrap);
    container.appendChild(card);

    if (isReview && !answeredHere) {
        const skipped = document.createElement('div');
        skipped.className = 'usmle-explain-panel is-incorrect';
        skipped.innerHTML = '<div class="usmle-explain-verdict">⚠️ Not answered in this attempt</div>';
        container.appendChild(skipped);
    }

    // Restore explanation for answered questions
    if (answeredHere || isReview) {
        const selIdx = answeredHere ? examAnsweredMap[currentExamIdx] : -1;
        const panel = buildExamExplainPanel(mcq, selIdx, correctIdx);
        if (panel) container.appendChild(panel);
    }


    
    updateExamSidebarActive();
}

window.handleUsmleOptionClick = function(btn, selectedIdx, correctIdx, wrapper, questionIdx) {
    if (examOpts && examOpts.review) return; // reviewing a finished attempt: read-only
    if (wrapper.getAttribute('data-answered') === 'true') return;
    wrapper.setAttribute('data-answered', 'true');
    examAnsweredMap[questionIdx] = selectedIdx;
    
    // Disable all options
    Array.from(wrapper.children).forEach(child => {
        child.style.cursor = 'default';
        child.style.pointerEvents = 'none';
    });
    
    const options = Array.from(wrapper.children);
    const mcq = examQuestions[currentExamIdx];
    const container = wrapper.parentElement ? wrapper.parentElement.parentElement : null;

    if (selectedIdx === correctIdx) {
        btn.classList.add('correct');
    } else {
        btn.classList.add('incorrect');
        if (options[correctIdx]) options[correctIdx].classList.add('correct');
    }

    // Inline PLAB-style explanation (shown for both correct and wrong answers)
    const panel = buildExamExplainPanel(mcq, selectedIdx, correctIdx);
    if (panel && container) container.appendChild(panel);


    updateExamSidebarActive();

    if (typeof examOpts.onAnswer === 'function') {
        try { examOpts.onAnswer(questionIdx, selectedIdx, selectedIdx === correctIdx); } catch (e) { console.warn(e); }
    }
};


window.examNavPrev = function() {
    if (currentExamIdx > 0) {
        currentExamIdx--;
        updateExamSidebarActive();
        showExamQuestion();
    }
};

window.examNavNext = function() {
    if (currentExamIdx < examQuestions.length - 1) {
        currentExamIdx++;
        updateExamSidebarActive();
        showExamQuestion();
    }
};

window.toggleExamFlag = function() {
    const btn = document.getElementById('exam-flag-btn');
    if (examFlaggedSet.has(currentExamIdx)) {
        examFlaggedSet.delete(currentExamIdx);
        if (btn) btn.classList.remove('flagged');
    } else {
        examFlaggedSet.add(currentExamIdx);
        if (btn) btn.classList.add('flagged');
    }
    updateExamSidebarActive();
};


window.handleMCQClick = function(element, isCorrect) {
    const wrapper = element.parentElement;
    if (wrapper.getAttribute('data-answered') === 'true') return;
    wrapper.setAttribute('data-answered', 'true');
    
    // Disable hover effects on all children
    Array.from(wrapper.children).forEach(child => {
        child.style.cursor = 'default';
        child.style.pointerEvents = 'none';
    });
    
    const correctOpt = wrapper.querySelector('.correct-opt');
    
    if (isCorrect) {
        element.classList.add('mcq-picked-correct');
    } else {
        element.classList.add('mcq-picked-wrong');
        if (correctOpt) {
            correctOpt.classList.add('mcq-reveal-correct');
        }
    }
}

window.getBestMCQAnswerIndex = function(mcq) {
    if (!mcq || !mcq.options || !mcq.answer) return 0;
    const ans = String(mcq.answer).trim().toLowerCase();
    
    let idx = mcq.options.findIndex(o => String(o).trim().toLowerCase() === ans);
    if (idx !== -1) return idx;

    const stripPrefix = (str) => str.replace(/^([a-e]|[1-5])[\.\)\-:]\s*/i, '').trim();
    const ansStripped = stripPrefix(ans);
    
    if (ansStripped.length > 2) {
        idx = mcq.options.findIndex(o => stripPrefix(String(o).toLowerCase()) === ansStripped);
        if (idx !== -1) return idx;
        
        idx = mcq.options.findIndex(o => {
            const oStripped = stripPrefix(String(o).toLowerCase());
            return oStripped.length > 4 && (oStripped.includes(ansStripped) || ansStripped.includes(oStripped));
        });
        if (idx !== -1) return idx;
    }

    const extractLetter = (str) => {
        const m = str.match(/^([a-e])[\.\)\-:]\s*/i);
        if (m) return m[1].toLowerCase();
        const m2 = str.match(/option\s+([a-e])/i);
        if (m2) return m2[1].toLowerCase();
        if (str.length === 1 && /^[a-e]$/i.test(str)) return str.toLowerCase();
        return null;
    };
    
    const ansLetter = extractLetter(ans);
    if (ansLetter) {
        idx = mcq.options.findIndex(o => extractLetter(String(o).trim().toLowerCase()) === ansLetter);
        if (idx !== -1) return idx;
    }

    return 0; // fallback
}

// Chat Logic
window.sendChatMessage = async function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    
    const container = document.getElementById('chat-messages');
    const empty = container.querySelector('.chat-empty-state');
    if (empty) empty.remove();
    const userMsg = document.createElement('div');
    userMsg.className = 'message user';
    userMsg.textContent = text;
    container.appendChild(userMsg);
    input.value = '';
    input.style.height = 'auto';
    container.scrollTop = container.scrollHeight;
    
    const aDiv = document.createElement('div');
    aDiv.className = 'message ai';
    aDiv.innerText = '...';
    container.appendChild(aDiv);
    
    const reply = await window.aiTask("chat_tutor", {
        context: getActiveDoc()?.pdfContextText || "",
        question: text,
    });
    if (reply && !reply._error) {
        aDiv.innerText = reply;
    } else if (window.aiErrorHTML) {
        aDiv.innerHTML = window.aiErrorHTML(reply);
    } else {
        aDiv.innerText = (reply && reply._error) ? reply._error : "Error connecting to AI Tutor.";
    }


    container.scrollTop = container.scrollHeight;
}

// Global Exam Logic
window.globalCustomMode = 'exam'; // 'exam' or 'flashcard'

window.openGlobalCustomModal = function(mode) {
    const doc = window.getActiveDoc();
    if (!doc || !doc.sections || doc.sections.length === 0) return alert("Please upload a PDF first to generate a study plan.");
    
    window.globalCustomMode = mode;
    
    const titleEl = document.getElementById('global-custom-title');
    const startBtn = document.getElementById('global-custom-start-btn');
    if (mode === 'exam') {
        titleEl.innerText = "Configure Custom Exam";
        startBtn.innerText = "Start Custom Exam";
    } else {
        titleEl.innerText = "Configure Custom Flashcards";
        startBtn.innerText = "Generate Custom Flashcards";
    }
    
    const container = document.getElementById('global-custom-topics-container');
    container.innerHTML = '';
    
    doc.sections.forEach((sec, idx) => {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '10px';
        label.style.cursor = 'pointer';
        label.style.padding = '8px';
        label.style.background = 'rgba(255,255,255,0.02)';
        label.style.borderRadius = '6px';
        label.style.border = '1px solid var(--border-medium)';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'global-topic-checkbox';
        checkbox.value = idx;
        checkbox.checked = true; // Default all selected
        checkbox.style.accentColor = 'var(--accent-cyan)';
        checkbox.style.width = '18px';
        checkbox.style.height = '18px';
        
        const text = document.createElement('span');
        text.innerText = `${idx + 1}. ${sec.title}`;
        
        label.appendChild(checkbox);
        label.appendChild(text);
        container.appendChild(label);
    });
    
    window.openModal('global-custom-modal');
}

window.toggleAllGlobalTopics = function(state) {
    const checkboxes = document.querySelectorAll('.global-topic-checkbox');
    checkboxes.forEach(cb => cb.checked = state);
}

window.startGlobalCustomAction = function() {
    if (window.globalCustomMode === 'exam') {
        window.generateCustomExam();
    } else {
        window.generateCustomFlashcards();
    }
}

window.generateCustomExam = async function() {
    const doc = window.getActiveDoc();
    if (!doc || !doc.sections) return;
    
    const checkboxes = document.querySelectorAll('.global-topic-checkbox');
    const selectedIndices = [];
    checkboxes.forEach(cb => {
        if (cb.checked) selectedIndices.push(parseInt(cb.value));
    });
    
    if (selectedIndices.length === 0) return alert("Please select at least one topic.");
    
    window.closeModal('global-custom-modal');
    window.openFullscreen('exam-modal');
    const container = document.getElementById('exam-modal-content');
    
    window.showLoadingScreen("Crafting Custom Exam...");
    container.innerHTML = '<div style="text-align:center; color:#666; margin-top:50px;">Generating Hard Custom Exam...</div>';
    
    // Concat text chunks
    let combinedText = "";
    selectedIndices.forEach(idx => {
        combinedText += `\n\n--- SECTION: ${doc.sections[idx].title} ---\n\n`;
        combinedText += doc.sections[idx].chunkText;
    });
    
    const reply = await window.aiTask("hard_exam_from_chunks", { combinedText });

    window.hideLoadingScreen();
    
    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.questions) {
            doc.customExam = {
                topics: selectedIndices.map(i => doc.sections[i].title),
                questions: data.questions
            };
            saveDb();
            if (window.renderAccordionSections) window.renderAccordionSections();
            
            renderExamQuestions(data.questions);
        } else {
            container.innerHTML = '<div style="color:red; text-align:center;">Failed to generate custom exam.</div>';
        }
    } else {
        const errMsg = reply ? reply._error : "Unknown AI Error";
        container.innerHTML = `<div style="color:red; text-align:center; padding: 20px;"><b>API Error</b><br/>${_esc(errMsg)}</div>`;
    }
}

window.retakeCustomExam = function() {
    const doc = window.getActiveDoc();
    if (!doc || !doc.customExam || !doc.customExam.questions) return;
    
    window.openFullscreen('exam-modal');
    renderExamQuestions(doc.customExam.questions);
}

window.explainMCQ = async function(btn, questionText, selectedText, correctText) {
    btn.innerHTML = 'Thinking...';
    btn.disabled = true;
    
    const docContext = getActiveDoc()?.pdfContextText || "";
    
    const reply = await window.aiTask("explain_mcq", {
        context: docContext,
        questionText: questionText,
        selectedText: selectedText,
        correctText: correctText,
    });


    
    const explanationDiv = document.createElement('div');
    explanationDiv.className = 'usmle-explain-box';
    
    if (reply && !reply._error) {
        explanationDiv.innerHTML = window.safeHTML(marked.parse(reply));
    } else {
        explanationDiv.innerHTML = `<span style="color:red">Failed to generate explanation. ${_esc(reply ? reply._error : '')}</span>`;
    }
    
    btn.replaceWith(explanationDiv);
}

window.generateCustomFlashcards = async function() {
    const doc = window.getActiveDoc();
    if (!doc || !doc.sections) return;
    
    const checkboxes = document.querySelectorAll('.global-topic-checkbox');
    const selectedIndices = [];
    checkboxes.forEach(cb => {
        if (cb.checked) selectedIndices.push(parseInt(cb.value));
    });
    
    if (selectedIndices.length === 0) return alert("Please select at least one topic.");
    
    window.closeModal('global-custom-modal');
    window.showLoadingScreen("Extracting Flashcards for Custom Selection...");
    
    // Concat text chunks
    let combinedText = "";
    selectedIndices.forEach(idx => {
        combinedText += `\n\n--- SECTION: ${doc.sections[idx].title} ---\n\n`;
        combinedText += doc.sections[idx].chunkText;
    });
    
    const reply = await window.aiTask("flashcards_from_chunks", { combinedText });

    
    if (reply && !reply._error) {
        const data = parseAIJson(reply);
        if (data && data.flashcards) {
            data.flashcards.forEach(card => {
                const front = card.front || '';
                const back = (card.back || '').trim();
                const isCloze = card.type === 'cloze' || (window.hasCloze && window.hasCloze(front));
                const rem = window.addFlashcardRem(doc.id, front, isCloze ? '' : back, "Custom Selection");
                if (rem) {
                    rem.sourceText = card.source || '';
                    rem.manual = false;
                    if (isCloze) rem.cardType = 'cloze';
                    if (String(card.explanation || '').trim()) rem.explanation = card.explanation;
                    if (Array.isArray(card.extras) && card.extras.length) rem.extras = card.extras;
                }
            });
            
            // Mark selected sections as flashcards generated
            selectedIndices.forEach(idx => {
                doc.sections[idx].flashcardsGenerated = true;
            });
            
            saveDb();
            if(window.renderRems) window.renderRems();
            if(window.renderAccordionSections) window.renderAccordionSections();
            if(window.updateSRSQueue) window.updateSRSQueue();
            
            window.hideLoadingScreen();
            alert(`Generated ${data.flashcards.length} flashcards from custom selection! Click 'Review' in the top bar to practice them.`);
        } else {
            window.hideLoadingScreen();
            alert("Failed to extract flashcards.");
        }
    } else {
        window.hideLoadingScreen();
        alert("API Error: " + (reply ? reply._error : "Unknown Error"));
    }
}
