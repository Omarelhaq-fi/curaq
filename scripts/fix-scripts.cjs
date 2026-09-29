const fs = require('fs');
let content = fs.readFileSync('public/app/index.html', 'utf8');

const scripts = `    <!-- Scripts -->
    <script src="js/i18n.js"></script>
    <script src="js/ui-i18n.js"></script>
    <script src="js/ai-client.js"></script>
    <script src="js/session-restore.js"></script>
    <script src="js/cloze.js"></script>

    <script src="js/planner.js"></script>
    <script src="js/app.js"></script>

    <script src="js/srs.js"></script>
    <script src="js/editor.js"></script>
    <script src="js/pdf.js"></script>
    <script src="js/ai.js"></script>
    <script src="js/full-exam.js"></script>
    <script src="js/summary.js"></script>
    <script src="js/timer.js"></script>
    <script src="js/schedule.js"></script>
    <script src="js/draw.js"></script>
    <script src="js/flashcards.js"></script>
    <script src="js/admin.js?v=7"></script>
    <script src="js/quotas.js"></script>
    <script src="js/subscription.js"></script>
    <script src="js/plan-gate.js"></script>
    <script src="js/notifications.js"></script>
    <script src="js/support.js"></script>
    <script src="js/tour.js"></script>
    <script src="js/whatsnew.js"></script>
    <script src="js/import.js"></script>
    <script src="js/focus-mode.js"></script>
    <script src="js/book-mode.js?v=2"></script>
    <script src="js/study-party.js?v=2"></script>
    <script src="js/qbank-party.js?v=1"></script>
    <script src="js/qbank.js"></script>

    <script src="js/whiteboard.js"></script>
    <script src="js/mindmap.js"></script>
    <script src="js/recall.js"></script>
    <script src="js/goals.js"></script>
    <script src="js/radar.js"></script>
    <script src="js/layout-polish.js"></script>
    <script src="js/dashboard-ux.js"></script>
    <script src="js/activity.js"></script>`;

const start = content.indexOf('<!-- Scripts -->');
const end = content.indexOf('<script src="https://unpkg.com/lucide');

if (start > -1 && end > -1) {
    content = content.substring(0, start) + scripts + '\n\n' + content.substring(end);
    fs.writeFileSync('public/app/index.html', content);
    console.log('Fixed scripts');
} else {
    console.log('Could not find boundaries');
}
