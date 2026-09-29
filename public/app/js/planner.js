(function() {
    // ---- Planner Storage ----
    function getPlannerTasks() {
        try {
            return JSON.parse(localStorage.getItem("omnote_planner_tasks") || "[]");
        } catch (e) {
            return [];
        }
    }

    function savePlannerTasks(tasks) {
        try {
            localStorage.setItem("omnote_planner_tasks", JSON.stringify(tasks));
        } catch (e) {}
    }

    let currentDate = new Date();
    let selectedDate = new Date();

    window.openPlanner = function() {
        if (window.hideAllMainViews) window.hideAllMainViews();
        
        const plv = document.getElementById("planner-view");
        if (plv) plv.style.display = "flex";

        // Update active nav class
        if (window.setQBankNav) window.setQBankNav('planner');

        renderPlannerView();
    };

    function formatDateForStorage(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function renderPlannerView() {
        const area = document.getElementById("planner-content");
        if (!area) return;

        const dateKey = formatDateForStorage(selectedDate);
        const allTasks = getPlannerTasks();
        const dailyTasks = allTasks.filter(t => t.date === dateKey);

        // Generate full month calendar grid
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();
        
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        const startingDay = firstDay.getDay(); // 0 (Sun) to 6 (Sat)
        const totalDays = lastDay.getDate();

        const monthNames = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"
        ];

        let calendarHtml = `
        <div class="flex items-center justify-between mb-4">
            <h3 class="font-headline-lg text-[22px] text-on-surface">${monthNames[month]} ${year}</h3>
            <div class="flex gap-2">
                <button class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container transition-colors text-on-surface-variant" onclick="window.plannerChangeMonth(-1)">
                    <span class="material-symbols-outlined text-[20px]">chevron_left</span>
                </button>
                <button class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container transition-colors text-on-surface-variant" onclick="window.plannerChangeMonth(1)">
                    <span class="material-symbols-outlined text-[20px]">chevron_right</span>
                </button>
            </div>
        </div>
        <div class="grid grid-cols-7 gap-1 mb-2">
            ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="text-center font-label-caps text-on-surface-variant text-[10px]">${d}</div>`).join('')}
        </div>
        <div class="grid grid-cols-7 gap-1">
        `;

        let dayCounter = 1;
        // 6 rows to cover max possible layout
        for (let row = 0; row < 6; row++) {
            for (let col = 0; col < 7; col++) {
                if (row === 0 && col < startingDay) {
                    calendarHtml += `<div class="aspect-square"></div>`;
                } else if (dayCounter > totalDays) {
                    calendarHtml += `<div class="aspect-square"></div>`;
                } else {
                    const thisDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayCounter).padStart(2, '0')}`;
                    const isSelected = thisDateStr === dateKey;
                    const isToday = thisDateStr === formatDateForStorage(new Date());
                    
                    const dayTasks = allTasks.filter(t => t.date === thisDateStr);
                    const completedTasks = dayTasks.filter(t => t.completed).length;
                    const hasTasks = dayTasks.length > 0;
                    
                    let bgClass = "bg-[#f8fafc] hover:bg-[#e2e8f0] cursor-pointer";
                    let textClass = "text-[#111827]";
                    let ringClass = "";

                    if (isSelected) {
                        bgClass = "bg-[#007a7a]";
                        textClass = "text-white";
                    } else if (isToday) {
                        ringClass = "ring-2 ring-[#007a7a] ring-inset";
                    }

                    let indicatorHtml = "";
                    if (hasTasks && !isSelected) {
                        const progress = completedTasks / dayTasks.length;
                        const indColor = progress === 1 ? "bg-[#10b981]" : "bg-[#e11d48]";
                        indicatorHtml = `<div class="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${indColor}"></div>`;
                    }

                    calendarHtml += `
                    <div class="aspect-square rounded-xl flex items-center justify-center font-title-md text-[14px] relative ${bgClass} ${textClass} ${ringClass} transition-colors border border-[#e2e8f0]" 
                         onclick="window.plannerSelectDate('${thisDateStr}')">
                        ${dayCounter}
                        ${indicatorHtml}
                    </div>`;
                    dayCounter++;
                }
            }
            if (dayCounter > totalDays) break;
        }
        calendarHtml += `</div>`;

        let taskListHtml = '';
        if (dailyTasks.length === 0) {
            taskListHtml = `<div class="text-center p-8 text-on-surface-variant text-sm">No tasks scheduled for this day.</div>`;
        } else {
            dailyTasks.forEach((t) => {
                taskListHtml += `
                <div class="flex items-center gap-3 p-3 rounded-xl hover:bg-[#f8fafc] transition-colors group">
                    <input type="checkbox" ${t.completed ? 'checked' : ''} class="rounded text-[#007a7a] focus:ring-[#007a7a] cursor-pointer w-5 h-5" onchange="window.plannerToggleTask('${t.id}')">
                    <span class="text-[15px] flex-1 ${t.completed ? 'line-through text-[#9ca3af]' : 'text-[#111827]'}">${window.escapeHtml ? window.escapeHtml(t.title) : t.title}</span>
                    <button class="opacity-0 group-hover:opacity-100 transition-opacity text-[#e11d48] hover:bg-[#ffe4e6] p-1 rounded" onclick="window.plannerDeleteTask('${t.id}')">
                        <span class="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                </div>
                `;
            });
        }

        const formattedSelectedDate = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

        area.innerHTML = `
        <div class="animate-[fade-in_0.5s_ease-out] flex flex-col gap-6">
            <div class="flex items-end justify-between">
                <div>
                    <p class="font-label-caps tracking-[0.1em] mb-2" style="color:#007a7a;">ACADEMIC SCHEDULE</p>
                    <h1 class="font-headline-xl text-[28px] font-bold" style="color:#111827;">Study Planner</h1>
                </div>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Calendar Section -->
                <div class="rounded-3xl p-6 shadow-sm lg:col-span-1 h-fit" style="background:#fff; border:1px solid #e2e8f0;">
                    ${calendarHtml}
                </div>

                <!-- Daily Tasks Section -->
                <div class="rounded-3xl p-6 shadow-sm lg:col-span-2 flex flex-col" style="background:#fff; border:1px solid #e2e8f0;">
                    <div class="flex items-center justify-between mb-6 pb-4 border-b border-[#e2e8f0]">
                        <div>
                            <h2 class="font-headline-lg text-[22px]" style="color:#111827;">Daily Tasks</h2>
                            <p class="font-label-sm" style="color:#6b7280;">${formattedSelectedDate}</p>
                        </div>
                        <div class="text-right">
                            <span class="font-title-md" style="color:#007a7a;">${dailyTasks.filter(t=>t.completed).length} / ${dailyTasks.length}</span>
                            <p class="font-label-caps text-[10px]" style="color:#6b7280;">COMPLETED</p>
                        </div>
                    </div>
                    
                    <div class="space-y-1 flex-1 overflow-y-auto max-h-[400px] pr-2">
                        ${taskListHtml}
                    </div>

                    <div class="mt-6 pt-4 border-t border-[#e2e8f0] flex gap-2 relative">
                        <input type="text" id="planner-new-task-input" class="flex-1 rounded-xl px-4 py-3 text-[14px] focus:outline-none focus:ring-2 focus:ring-[#007a7a]" style="background:#f8fafc; border:1px solid #e2e8f0;" placeholder="Add a custom study task..." onkeypress="if(event.key==='Enter') window.plannerAddTask()">
                        <button class="rounded-xl px-6 py-3 font-title-md text-[14px] transition-opacity cursor-pointer" style="background:#007a7a; color:white; border:none;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'" onclick="window.plannerAddTask()">Add Task</button>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    window.plannerChangeMonth = function(delta) {
        currentDate.setMonth(currentDate.getMonth() + delta);
        renderPlannerView();
    };

    window.plannerSelectDate = function(dateStr) {
        const parts = dateStr.split('-');
        selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
        renderPlannerView();
    };

    window.plannerToggleTask = function(taskId) {
        const tasks = getPlannerTasks();
        const task = tasks.find(t => t.id === taskId);
        if (task) {
            task.completed = !task.completed;
            savePlannerTasks(tasks);
            renderPlannerView();
            // Also re-render dashboard widget if on home view
            if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();
        }
    };

    window.plannerDeleteTask = function(taskId) {
        let tasks = getPlannerTasks();
        tasks = tasks.filter(t => t.id !== taskId);
        savePlannerTasks(tasks);
        renderPlannerView();
        if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();
    };

    window.plannerAddTask = function() {
        const input = document.getElementById("planner-new-task-input");
        if (!input || !input.value.trim()) return;
        
        const title = input.value.trim();
        const dateKey = formatDateForStorage(selectedDate);
        const tasks = getPlannerTasks();
        
        tasks.push({
            id: 'task_' + Date.now() + '_' + Math.floor(Math.random()*1000),
            title: title,
            completed: false,
            date: dateKey,
            type: 'custom'
        });
        
        savePlannerTasks(tasks);
        renderPlannerView();
        if (window.renderDashboardPlannerWidget) window.renderDashboardPlannerWidget();
    };

})();
