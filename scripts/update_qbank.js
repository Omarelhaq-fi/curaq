const fs = require('fs');
const path = require('path');

const qbankPath = path.join(__dirname, '../public/app/js/qbank.js');
let code = fs.readFileSync(qbankPath, 'utf8');

// We'll use regex and string replacement to upgrade the UI

// 1. Upgrade continueCardHtml
code = code.replace(
  /let continueCardHtml = '';[\s\S]*?continueCardHtml = `[\s\S]*?`\s*;\s*\}/,
  (match) => {
    return `let continueCardHtml = '';
      if (lastSession && lastSession.qbankId && !isSessionCompleted) {
          const subjScore = subStat && subStat.answered > 0 ? Math.round((subStat.correct / subStat.answered) * 100) : 0;
          const scoreBadge = subjScore >= 70
              ? \`<span class="clin-badge clin-badge-good">\${subjScore}%</span>\`
              : (subjScore >= 50
                  ? \`<span class="clin-badge clin-badge-warn">\${subjScore}%</span>\`
                  : \`<span class="clin-badge clin-badge-bad">\${subjScore}%</span>\`);
          continueCardHtml = \`
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column; position:relative; overflow:hidden;">
              <div style="position:absolute; top:30%; left:-10%; width:120%; height:70%; opacity:0.1; pointer-events:none; z-index:0;">
                 <svg viewBox="0 0 500 100" preserveAspectRatio="none" style="width:100%; height:100%;">
                     <path d="M0 50 L100 50 L120 20 L140 80 L160 50 L180 50 L200 50 L210 30 L230 70 L250 50 L500 50" fill="none" stroke="#007a7a" stroke-width="3" opacity="0.8"/>
                 </svg>
              </div>
              <div style="position:relative; z-index:1; display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                  <h2 class="clin-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a;"></i>Continue studying <span class="micro-tag">Live</span></h2>
                  <a href="#" onclick="window.openExamPrepTab && window.openExamPrepTab(); return false;" style="color:#64748B; font-size:11.5px; text-decoration:none; font-weight:600;">Change</a>
              </div>
              <div style="position:relative; z-index:1; font-weight:700; color:#0F172A; font-size:16px; margin-bottom:4px;">\${escLastSubject}</div>
              <div class="clin-muted" style="position:relative; z-index:1; font-size:12px; margin-bottom:2px;">\${subStat ? subStat.answered : 0} of \${subStat ? subStat.total : 0} answered &middot; last score \${scoreBadge}</div>
              <div class="clin-muted" style="position:relative; z-index:1; font-size:12px; margin-bottom:12px;">\${lastSubject === "All Subjects" ? "Mixed review block" : "Priority topic review"} &middot; ~15 Qs &middot; ~12 min</div>
              <div style="margin-top:auto; position:relative; z-index:1;">
                  <button class="clin-btn-primary" onclick="window.qbankContinueLast()">
                      Continue session <i class="fa-solid fa-arrow-right" style="font-size:12px;"></i>
                  </button>
              </div>
          </div>
          \`;
      } else {
          continueCardHtml = \`
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <h2 class="clin-card-title"><i class="fa-solid fa-book-open" style="color:#007a7a;"></i>Continue studying <span class="micro-tag">Ready</span></h2>
              <div class="clin-muted" style="font-size:12.5px; margin:2px 0 12px;">Ready to dive in? Start a block to track progress.</div>
              <div style="margin-top:auto;">
                  <button class="clin-btn-primary" onclick="window.openExamPrepTab && window.openExamPrepTab()">
                      Start new session <i class="fa-solid fa-arrow-right" style="font-size:12px;"></i>
                  </button>
              </div>
          </div>
          \`;
      }`;
  }
);

// 2. Upgrade Trend Graph (Area Chart with Gradient) and Donut
code = code.replace(
  /_sparkHtml = \`[\s\S]*?<\/svg>[\s\S]*?\`;/g,
  (match) => {
    return `_sparkHtml = \`
          <svg width="\${W}" height="\${H}" viewBox="0 0 \${W} \${H}" style="display:block; overflow:visible;">
            <defs>
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#007a7a" stop-opacity="0.3"/>
                <stop offset="100%" stop-color="#007a7a" stop-opacity="0"/>
              </linearGradient>
              <filter id="neonGlow">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
                <feMerge>
                  <feMergeNode in="coloredBlur"/>
                  <feMergeNode in="SourceGraphic"/>
                </feMerge>
              </filter>
            </defs>
            <polygon points="\${P},\${H} \${pts} \${lastX},\${H}" fill="url(#trendGrad)"></polygon>
            <polyline points="\${pts}" fill="none" stroke="#007a7a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" filter="url(#neonGlow)"></polyline>
          </svg>
          <div class="clin-muted" style="font-size:11px; margin-top:4px;">Recent trend &middot; last \${_trendPts.length} blocks</div>\`;`;
  }
);

// 3. Status Alerts (Technical status bar)
code = code.replace(
  /const _scoreBadge = globalScore >= 70[\s\S]*?`<span class="clin-badge clin-badge-bad">Remediation needed<\/span>"\);/,
  (match) => {
    return `const _scoreBadge = globalScore >= 70
          ? \`<div class="clin-status-bar good"><i class="fa-solid fa-check-circle"></i> High performance</div>\`
          : (globalScore >= 50
              ? \`<div class="clin-status-bar warn"><i class="fa-solid fa-triangle-exclamation"></i> Developing</div>\`
              : \`<div class="clin-status-bar bad"><i class="fa-solid fa-triangle-exclamation"></i> Remediation needed</div>\`);`;
  }
);

// 4. Performance Card (Advanced Ring, Glassmorphism, Micro-tag)
code = code.replace(
  /let performanceCardHtml = `[\s\S]*?<div class="clin-card">[\s\S]*?<h2 class="clin-card-title"(.*?)>Performance/g,
  `let performanceCardHtml = \`
      <div class="clin-card clin-glass">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
              <h2 class="clin-card-title" style="margin:0;"><i class="fa-solid fa-chart-column" style="color:#007a7a;"></i>Performance &amp; diagnostics <span class="micro-tag">Global</span></h2>`
);

code = code.replace(
  /<circle cx="60" cy="60" r="54" fill="none" stroke="#E2E8F0" stroke-width="12"><\/circle>[\s\S]*?transform="rotate\(-90 60 60\)"><\/circle>/g,
  `<circle cx="60" cy="60" r="54" fill="none" stroke="#E2E8F0" stroke-width="12"></circle>
                          <circle cx="60" cy="60" r="42" fill="none" stroke="#F1F5F9" stroke-width="4"></circle>
                          <circle cx="60" cy="60" r="54" fill="none" stroke="\${_donutColor}" stroke-width="12" stroke-linecap="round"
                              stroke-dasharray="\${_C.toFixed(1)}" stroke-dashoffset="\${_off}" transform="rotate(-90 60 60)" style="filter: drop-shadow(0 2px 4px \${_donutColor}40)"></circle>`
);

// 5. Question pool
code = code.replace(
  /<div class="clin-card" style="display:flex; flex-direction:column;">[\s\S]*?<h2 class="clin-card-title"><i class="fa-solid fa-layer-group"(.*?)>Question pool<\/h2>/,
  `<div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
          <h2 class="clin-card-title"><i class="fa-solid fa-layer-group" style="color:#007a7a;"></i>Question pool <span class="micro-tag">Data</span></h2>`
);

// Dynamic Progress Rings (Glowing Pill)
code = code.replace(
  /class="clin-pool-fill" style="display:block; height:100%; width:\${r.pct}%; background-color:\${r.color}; border-radius:999px; margin:0; padding:0;"/g,
  `class="clin-pool-fill" style="display:block; height:100%; width:\${r.pct}%; background-color:\${r.color}; border-radius:999px; margin:0; padding:0; box-shadow:0 0 6px \${r.color}66;"`
);

// 6. Quick Actions (3D/Glassmorphic Widgets)
code = code.replace(
  /const _qa = \(fn, icon, title, sub\) => `[\s\S]*?<\/div>`;/g,
  `const _qa = (fn, icon, title, sub, colorClass) => \`
          <div onclick="\${fn}" class="qa-tile-3d \${colorClass}" onmouseover="this.classList.add('hover')" onmouseout="this.classList.remove('hover')">
              <div class="qa-icon-container">
                  <i class="\${icon}"></i>
              </div>
              <div class="qa-content">
                  <div class="qa-title">\${title}</div>
                  <div class="qa-sub">\${sub}</div>
              </div>
          </div>\`;`
);

code = code.replace(
  /let quickActionsHtml = `[\s\S]*?<div class="clin-card">[\s\S]*?<h2 class="clin-card-title"><i class="fa-solid fa-bolt"(.*?)>Quick actions<\/h2>[\s\S]*?<div style="display:grid; grid-template-columns:repeat\(3, 1fr\); gap:10px;">[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?`;/g,
  `let quickActionsHtml = \`
      <div class="clin-card clin-glass" style="background:transparent; border:none; box-shadow:none; padding:0;">
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:16px;">
              \${_qa('window.openExamPrepTab && window.openExamPrepTab()', 'fa-solid fa-stethoscope', 'New session', 'Customize practice', 'qa-cyan')}
              \${_qa('window.openFlashcardsExplorer && window.openFlashcardsExplorer()', 'fa-solid fa-layer-group', 'Flashcards', 'Reinforce learning', 'qa-purple')}
              \${_qa('window.openPlanner && window.openPlanner()', 'fa-regular fa-calendar-check', 'Study plan', 'Stay on track', 'qa-blue')}
          </div>
      </div>
      \`;`
);

// 7. Priority Review (Glowing pill tracks and Glassmorphism)
code = code.replace(
  /let weakestAreasHtml = '';[\s\S]*?<div class="clin-card" style="display:flex; flex-direction:column;">[\s\S]*?<h2 class="clin-card-title"(.*?)>Priority review<\/h2>/,
  `let weakestAreasHtml = '';
      if (weakAreas && weakAreas.length > 0) {
          let listHtml = '';
          weakAreas.slice(0, 5).forEach((w) => {
              const safeName = window.escapeHtml ? window.escapeHtml(w.name) : w.name;
              const safeNameClick = safeName.replace(/'/g, "\\\\'");
              const wBadge = w.score >= 50
                  ? \`<span class="clin-badge clin-badge-warn">\${w.score}%</span>\`
                  : \`<span class="clin-badge clin-badge-bad">\${w.score}%</span>\`;
              listHtml += \`
              <div class="clin-row clin-row-hover" onclick="window.startQBankSession('\${activeQBankId}', '\${safeBankName}', '\${safeNameClick}')">
                  <div style="flex:1; min-width:0;">
                      <div style="font-size:12.5px; font-weight:600; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">\${safeName}</div>
                      <div class="clin-bar-track" style="margin-top:5px;"><div style="height:100%; width:\${Math.max(0, Math.min(100, w.score))}%; background: linear-gradient(90deg, #f87171, #ef4444); border-radius:3px; box-shadow: 0 0 6px rgba(239,68,68,0.5);"></div></div>
                  </div>
                  \${wBadge}
                  <i class="fa-solid fa-chevron-right" style="font-size:11px; color:#94A3B8;"></i>
              </div>
              \`;
          });

          weakestAreasHtml = \`
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                  <h2 class="clin-card-title" style="margin:0;"><i class="fa-solid fa-bullseye" style="color:#007a7a;"></i>Priority review <span class="micro-tag">Focus</span></h2>`
);
code = code.replace(
  /weakestAreasHtml = `[\s\S]*?<div class="clin-card" style="display:flex; flex-direction:column;">[\s\S]*?<h2 class="clin-card-title"><i class="fa-solid fa-bullseye"(.*?)>Priority review<\/h2>/,
  `weakestAreasHtml = \`
          <div class="clin-card clin-glass" style="display:flex; flex-direction:column;">
              <h2 class="clin-card-title"><i class="fa-solid fa-bullseye" style="color:#007a7a;"></i>Priority review <span class="micro-tag">Focus</span></h2>`
);

// 8. Inject CSS upgrades
const newCSS = `
        .clin-wrap {
            font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #F8FAFC;
            background-image: radial-gradient(rgba(0,122,122, 0.08) 1px, transparent 1px);
            background-size: 24px 24px;
            animation: clin-fade-in 0.4s ease-out;
            width: 100%;
            box-sizing: border-box;
        }
        .clin-glass {
            background: rgba(255, 255, 255, 0.9) !important;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.8) !important;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03), inset 0 0 0 1px rgba(255, 255, 255, 0.5) !important;
            border-radius: 12px !important;
        }
        .micro-tag {
            font-size: 9px;
            font-weight: 700;
            text-transform: uppercase;
            background: #F1F5F9;
            color: #64748B;
            padding: 2px 6px;
            border-radius: 4px;
            letter-spacing: 0.05em;
        }
        .clin-status-bar {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .clin-status-bar.bad { background: #FBEAEA; border: 1px solid #FECACA; color: #C62828; }
        .clin-status-bar.warn { background: #FEF3C7; border: 1px solid #FDE68A; color: #92400E; }
        .clin-status-bar.good { background: #DCFCE7; border: 1px solid #BBF7D0; color: #15803D; }
        
        .qa-tile-3d {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 16px;
            border-radius: 12px;
            background: rgba(255,255,255,0.85);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.8);
            box-shadow: 0 4px 15px rgba(0,0,0,0.03), inset 0 2px 4px rgba(255,255,255,0.8);
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .qa-tile-3d.hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0,0,0,0.06), inset 0 2px 4px rgba(255,255,255,0.8);
        }
        .qa-icon-container {
            width: 48px;
            height: 48px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -2px 6px rgba(0,0,0,0.05), 0 4px 10px rgba(0,0,0,0.05);
        }
        .qa-icon-container i {
            font-size: 20px;
            filter: drop-shadow(0 2px 2px rgba(0,0,0,0.15));
        }
        .qa-cyan .qa-icon-container { background: linear-gradient(135deg, #e0f2f1 0%, #b2dfdb 100%); }
        .qa-cyan .qa-icon-container i { color: #007a7a; }
        .qa-cyan:hover { border-color: #b2dfdb; }
        
        .qa-purple .qa-icon-container { background: linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%); }
        .qa-purple .qa-icon-container i { color: #6d28d9; }
        .qa-purple:hover { border-color: #ddd6fe; }
        
        .qa-blue .qa-icon-container { background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); }
        .qa-blue .qa-icon-container i { color: #0369a1; }
        .qa-blue:hover { border-color: #bae6fd; }
        
        .qa-content { flex: 1; min-width: 0; }
        .qa-title { font-weight: 700; color: #0F172A; font-size: 14px; margin-bottom: 2px; }
        .qa-sub { font-size: 11px; color: #64748B; }
        .clin-row-hover:hover { background: rgba(248, 250, 252, 0.6) !important; }
`;

code = code.replace(/\.clin-wrap\s*\{[^}]+\}/, newCSS.split('}')[0] + '}');
code = code.replace('</style>', newCSS.substring(newCSS.indexOf('.clin-glass')) + '\\n</style>');

fs.writeFileSync(qbankPath, code);
console.log('Successfully applied visual upgrades!');
