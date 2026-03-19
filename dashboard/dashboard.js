// Dashboard password gate and chart rendering
// Password hash (SHA-256 of the chosen password)
const PASSWORD_HASH = "4e85d7b22c7cdd2755044e7758f1b0cf8a930b9984adb523bf3e7141b782af0d";

// UCLA brand colors for charts
const COLORS = {
    primary: "#2774AE",
    primaryDark: "#003B5C",
    primaryMid: "#005587",
    accent: "#FFD100",
    accentDark: "#E6BC00",
    lightBlue: "#DAEBFE",
};

const CHART_PALETTE = [
    "#2774AE", "#003B5C", "#FFD100", "#005587", "#E6BC00", "#DAEBFE",
    "#4A90D9", "#6BB3E0", "#8BC5EB", "#2E8B57", "#D4A843",
];

// --- Password Gate ---

async function hashPassword(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("password-input").value;
    const hash = await hashPassword(input);

    if (hash === PASSWORD_HASH) {
        document.getElementById("login-gate").style.display = "none";
        document.getElementById("dashboard").style.display = "block";
        loadDashboard();
    } else {
        document.getElementById("login-error").style.display = "block";
        document.getElementById("password-input").value = "";
        document.getElementById("password-input").focus();
    }
});

// --- Dashboard Loading ---

async function loadDashboard() {
    try {
        const resp = await fetch("dashboard_data.json");
        if (!resp.ok) throw new Error("Failed to load data");
        const data = await resp.json();
        renderDashboard(data);
    } catch (err) {
        console.error("Dashboard load error:", err);
        document.querySelector(".dashboard-body").innerHTML =
            '<div style="text-align:center;padding:48px;color:#c00;">Failed to load dashboard data. Please try refreshing.</div>';
    }
}

function renderDashboard(data) {
    // Summary cards
    document.getElementById("total-submissions").textContent = data.total_submissions;
    document.getElementById("total-coauthor").textContent = data.total_coauthor_responses;
    document.getElementById("fields-count").textContent = Object.keys(data.field_distribution || {}).length;

    // Days remaining
    if (data.submission_deadline) {
        const deadline = new Date(data.submission_deadline + "T23:59:59");
        const now = new Date();
        const days = Math.max(0, Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)));
        document.getElementById("days-remaining").textContent = days;
    }

    // Last updated
    if (data.generated_at) {
        const d = new Date(data.generated_at);
        document.getElementById("last-updated").textContent =
            "Updated: " + d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    // Section 1: At a Glance
    renderTimeline(data);

    // Section 2: Who's Submitting
    renderFields(data);
    renderCoauthors(data);
    renderOrdinalBar("chart-programming", data.programming_proficiency, ["1", "2", "3", "4", "5"], COLORS.primary);
    renderOrdinalBar("chart-writing-exp", data.paper_writing_experience, ["1", "2", "3", "4", "5"], COLORS.primaryMid);
    renderExperience(data);

    // Section 3: How They Worked With AI
    renderTools(data);
    renderToolIntensity(data);
    renderReliance(data);
    renderRelianceByProficiency(data);
    renderRoles(data);
    renderHoursDist("chart-personal-hours", (data.hours || {}).personal || {});
    renderHoursDist("chart-team-hours", (data.hours || {}).team || {});
    renderCounterfactual(data);
    renderCounterfactualByExperience(data);
    renderCoordination(data);
    renderSubmitterRole(data);

    // Section 4: Self-Assessment
    renderSelfEval(data);
    setupSelfEvalToggle(data);
    likertCharts.satisfaction = renderLikert7("chart-satisfaction", data.satisfaction_distribution, COLORS.primary, data.satisfaction_mean);
    likertCharts.futureAi = renderLikert7("chart-future-ai", data.future_ai_likelihood_distribution, COLORS.primaryMid, data.future_ai_likelihood_mean);
    likertCharts.reviewInfluence = renderLikert7("chart-review-influence", data.ai_review_influence_distribution, COLORS.accent, data.ai_review_influence_mean);
    setupLikertSplitToggles(data);
    renderLikertByField(data);

    // Section 5: Papers
    renderPaperList(data);
}

// --- Chart Rendering ---

function renderTimeline(data) {
    const entries = data.submissions_by_date || [];
    let cum = 0;
    const labels = entries.map(e => e.date);
    const cumData = entries.map(e => { cum += e.count; return cum; });
    const dailyData = entries.map(e => e.count);

    new Chart(document.getElementById("chart-timeline"), {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    type: "line", label: "Cumulative", data: cumData,
                    borderColor: COLORS.primaryDark, backgroundColor: "transparent",
                    borderWidth: 2, pointBackgroundColor: COLORS.primaryDark, tension: 0.3,
                    yAxisID: "y1", order: 0,
                },
                {
                    type: "bar", label: "Daily", data: dailyData,
                    backgroundColor: COLORS.primary, borderRadius: 4, yAxisID: "y", order: 1,
                },
            ],
        },
        options: {
            responsive: true,
            plugins: { legend: { position: "top" } },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: "Daily" }, ticks: { stepSize: 1 } },
                y1: { beginAtZero: true, position: "right", title: { display: true, text: "Cumulative" }, grid: { drawOnChartArea: false }, ticks: { stepSize: 1 } },
            },
        },
    });
}

function renderFields(data) {
    const dist = data.field_distribution || {};
    new Chart(document.getElementById("chart-fields"), {
        type: "doughnut",
        data: {
            labels: Object.keys(dist),
            datasets: [{ data: Object.values(dist), backgroundColor: CHART_PALETTE }],
        },
        options: { responsive: true, plugins: { legend: { position: "bottom" } } },
    });
}

function renderCoauthors(data) {
    const dist = data.num_coauthors_distribution || {};
    const maxKey = Math.max(...Object.keys(dist).map(Number), 5);
    const labels = [];
    const values = [];
    for (let i = 1; i <= maxKey; i++) {
        labels.push(String(i));
        values.push(dist[String(i)] || 0);
    }
    new Chart(document.getElementById("chart-coauthors"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.primaryMid, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderOrdinalBar(canvasId, dist, orderedKeys, color) {
    dist = dist || {};
    const values = orderedKeys.map(k => dist[k] || 0);
    new Chart(document.getElementById(canvasId), {
        type: "bar",
        data: { labels: orderedKeys, datasets: [{ data: values, backgroundColor: color, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderExperience(data) {
    const exp = data.ai_experience_duration || {};
    const order = [
        ["none", "None"], ["1-3mo", "1–3 mo"], ["3-6mo", "3–6 mo"],
        ["6-12mo", "6–12 mo"], ["1-2yr", "1–2 yr"], ["2yr+", "2+ yr"],
    ];
    const labels = [], values = [];
    for (const [key, label] of order) {
        if (exp[key] !== undefined) { labels.push(label); values.push(exp[key]); }
    }
    new Chart(document.getElementById("chart-experience"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.primary, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderTools(data) {
    const tools = data.ai_tools || {};
    new Chart(document.getElementById("chart-tools"), {
        type: "bar",
        data: { labels: Object.keys(tools), datasets: [{ data: Object.values(tools), backgroundColor: COLORS.primary, borderRadius: 4 }] },
        options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderReliance(data) {
    const dist = data.tool_reliance_distribution || {};
    renderOrdinalBar("chart-reliance", dist, ["1", "2", "3", "4", "5"], COLORS.accent);
}

function renderRoles(data) {
    const roleByTask = data.ai_role_by_task || {};
    const taskLabels = data.task_labels || {};
    const roleLabels = data.role_labels || {};
    const tasks = Object.keys(taskLabels);
    const roles = Object.keys(roleLabels);

    const datasets = roles.map((role, i) => ({
        label: roleLabels[role],
        data: tasks.map(task => (roleByTask[task] || {})[role] || 0),
        backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
    }));

    new Chart(document.getElementById("chart-roles"), {
        type: "bar",
        data: { labels: tasks.map(t => taskLabels[t]), datasets },
        options: {
            responsive: true,
            plugins: { legend: { position: "top" } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } },
        },
    });
}

function renderHoursDist(canvasId, dist) {
    const order = [
        ["<10", "<10"], ["10-20", "10–20"], ["10-40", "10–40"],
        ["20-40", "20–40"], ["40-60", "40–60"], ["40-80", "40–80"],
        ["60-80", "60–80"], ["80-160", "80–160"], ["80+", "80+"],
        ["160-320", "160–320"], ["320+", "320+"],
    ];
    const labels = [], values = [];
    for (const [key, label] of order) {
        if (dist[key] !== undefined) { labels.push(label); values.push(dist[key]); }
    }
    new Chart(document.getElementById(canvasId), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.primaryMid, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderCounterfactual(data) {
    const cf = (data.hours || {}).counterfactual || {};
    const order = [
        ["less", "Less time"], ["same", "Same"], ["up_to_2x", "Up to 2×"],
        ["2-4x", "2–4×"], ["4-8x", "4–8×"], ["8x+", "8×+"], ["not_possible", "Not possible"],
    ];
    const labels = [], values = [];
    for (const [key, label] of order) {
        if (cf[key] !== undefined) { labels.push(label); values.push(cf[key]); }
    }
    new Chart(document.getElementById("chart-counterfactual"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.accent, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderCoordination(data) {
    const dist = data.ai_coordination_distribution || {};
    const labelMap = {
        independent: "Independent", one_led: "One Person Led", joint: "Joint/Coordinated",
        mixed: "Mixed", other: "Other",
    };
    const labels = [], values = [];
    for (const [key, val] of Object.entries(dist)) {
        labels.push(labelMap[key] || key);
        values.push(val);
    }
    new Chart(document.getElementById("chart-coordination"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.primaryMid, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderSubmitterRole(data) {
    const dist = data.ai_role_distribution || {};
    const labelMap = {
        primary_user: "Primary AI User", independent: "Independent", reviewer: "Reviewer",
        no_direct: "No Direct Use", other: "Other",
    };
    const labels = [], values = [];
    for (const [key, val] of Object.entries(dist)) {
        labels.push(labelMap[key] || key);
        values.push(val);
    }
    new Chart(document.getElementById("chart-submitter-role"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.primary, borderRadius: 4 }] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
}

function renderSelfEval(data) {
    const means = data.self_evaluation_means || {};
    const dimLabels = {
        conceptual_innovation: "Conceptual Innovation",
        methodological_originality: "Methodological Originality",
        relevance: "Relevance",
        rigor: "Rigor",
        overall: "Overall",
    };
    const labels = Object.keys(means).map(k => dimLabels[k] || k);
    const values = Object.values(means);

    selfEvalChart = new Chart(document.getElementById("chart-selfeval"), {
        type: "radar",
        data: {
            labels,
            datasets: [{
                label: "Mean Score",
                data: values,
                backgroundColor: "rgba(39, 116, 174, 0.2)",
                borderColor: COLORS.primary,
                pointBackgroundColor: COLORS.primary,
                borderWidth: 2,
            }],
        },
        options: {
            responsive: true,
            scales: { r: { min: 1, max: 7, ticks: { stepSize: 1 } } },
            plugins: { legend: { display: false } },
        },
    });
}

function renderLikert7(canvasId, dist, color, mean) {
    dist = dist || {};
    const labels = ["1", "2", "3", "4", "5", "6", "7"];
    const values = labels.map(l => dist[l] || 0);

    return new Chart(document.getElementById(canvasId), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 4 }] },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                subtitle: mean != null ? { display: true, text: `Mean: ${mean}`, font: { size: 13 }, padding: { bottom: 4 } } : undefined,
            },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        },
    });
}

function renderPaperList(data) {
    const list = document.getElementById("paper-list");
    const papers = data.papers || [];
    list.innerHTML = papers
        .map((p, i) => {
            const authorsHtml = (p.authors || [])
                .map(a => {
                    const aff = a.affiliation ? ` <span class="author-affiliation">(${escapeHtml(a.affiliation)})</span>` : "";
                    return `<span class="author-name">${escapeHtml(a.name)}</span>${aff}`;
                })
                .join(", ");
            return `<li><span class="paper-num">${i + 1}</span>${escapeHtml(p.title)}${authorsHtml ? `<div class="paper-authors">${authorsHtml}</div>` : ""}</li>`;
        })
        .join("");
}

// --- New Charts: Tool Intensity ---

function renderToolIntensity(data) {
    const avgUsage = data.ai_tools_avg_usage || {};
    // Sort by avg usage descending
    const sorted = Object.entries(avgUsage).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([name]) => name);
    const values = sorted.map(([, avg]) => avg);

    // Color intensity based on usage level
    const bgColors = values.map(v => {
        const t = (v - 1) / 4; // normalize 1-5 to 0-1
        return `rgba(39, 116, 174, ${0.3 + t * 0.7})`;
    });

    new Chart(document.getElementById("chart-tool-intensity"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: bgColors, borderRadius: 4 }] },
        options: {
            indexAxis: "y", responsive: true,
            plugins: { legend: { display: false } },
            scales: { x: { min: 1, max: 5, title: { display: true, text: "Avg. Usage Level" } } },
        },
    });
}

// --- New Charts: Reliance by Proficiency ---

function renderRelianceByProficiency(data) {
    const rel = data.reliance_by_proficiency || {};
    const labels = ["1", "2", "3", "4", "5"];
    const values = labels.map(k => rel[k] || 0);

    new Chart(document.getElementById("chart-reliance-by-prof"), {
        type: "bar",
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS.accent, borderRadius: 4 }] },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: "Programming Proficiency" } },
                y: { min: 1, max: 5, title: { display: true, text: "Avg. Reliance Level" } },
            },
        },
    });
}

// --- New Charts: Counterfactual by Experience ---

function renderCounterfactualByExperience(data) {
    const cfByExp = data.counterfactual_by_experience || {};
    const expOrder = ["none", "1-3mo", "3-6mo", "6-12mo", "1-2yr", "2yr+"];
    const expLabels = { none: "None", "1-3mo": "1–3 mo", "3-6mo": "3–6 mo", "6-12mo": "6–12 mo", "1-2yr": "1–2 yr", "2yr+": "2+ yr" };
    const cfOrder = ["less", "same", "up_to_2x", "2-4x", "4-8x", "8x+", "not_possible"];
    const cfLabels = { less: "Less", same: "Same", up_to_2x: "Up to 2×", "2-4x": "2–4×", "4-8x": "4–8×", "8x+": "8×+", not_possible: "Not possible" };

    const usedExp = expOrder.filter(e => cfByExp[e]);
    const labels = usedExp.map(e => expLabels[e] || e);

    const datasets = cfOrder.map((cf, i) => ({
        label: cfLabels[cf] || cf,
        data: usedExp.map(e => (cfByExp[e] || {})[cf] || 0),
        backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length],
    }));

    new Chart(document.getElementById("chart-cf-by-exp"), {
        type: "bar",
        data: { labels, datasets },
        options: {
            responsive: true,
            plugins: { legend: { position: "top" } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } },
        },
    });
}

// --- Self-Eval Radar Toggle (by Field / by AI Role) ---

let selfEvalChart = null;
const likertCharts = { satisfaction: null, futureAi: null, reviewInfluence: null };

function setupSelfEvalToggle(data) {
    const select = document.getElementById("selfeval-split");
    if (!select) return;
    select.addEventListener("change", () => {
        if (selfEvalChart) { selfEvalChart.destroy(); selfEvalChart = null; }
        const mode = select.value;
        if (mode === "field") renderSelfEvalSplit(data, data.self_evaluation_by_field);
        else if (mode === "writing_exp") renderSelfEvalSplit(data, data.self_evaluation_by_writing_exp);
        else if (mode === "ai_exp") renderSelfEvalSplit(data, data.self_evaluation_by_ai_exp);
        else renderSelfEval(data);
    });
}

function renderSelfEvalSplit(data, splitData) {
    const globalMeans = data.self_evaluation_means || {};
    const dims = Object.keys(globalMeans);
    const dimLabels = {
        conceptual_innovation: "Conceptual Innovation",
        methodological_originality: "Methodological Originality",
        relevance: "Relevance",
        rigor: "Rigor",
        overall: "Overall",
    };

    const roleLabels = {
        primary_user: "Primary AI User", independent: "Independent",
        reviewer: "Reviewer", no_direct_use: "No Direct Use",
    };

    const labels = dims.map(k => dimLabels[k] || k);
    const datasets = [];

    // Global mean as baseline (dashed)
    datasets.push({
        label: "All (Mean)",
        data: dims.map(d => globalMeans[d] || 0),
        backgroundColor: "rgba(39, 116, 174, 0.1)",
        borderColor: COLORS.primary,
        pointBackgroundColor: COLORS.primary,
        borderWidth: 2,
        borderDash: [5, 5],
    });

    // One dataset per split group
    const groups = Object.keys(splitData || {});
    groups.forEach((group, i) => {
        const groupData = splitData[group];
        const color = CHART_PALETTE[(i + 1) % CHART_PALETTE.length];
        const friendlyLabel = roleLabels[group] || group;
        datasets.push({
            label: friendlyLabel,
            data: dims.map(d => groupData[d] || 0),
            backgroundColor: "transparent",
            borderColor: color,
            pointBackgroundColor: color,
            borderWidth: 2,
        });
    });

    selfEvalChart = new Chart(document.getElementById("chart-selfeval"), {
        type: "radar",
        data: { labels, datasets },
        options: {
            responsive: true,
            scales: { r: { min: 1, max: 7, ticks: { stepSize: 1 } } },
            plugins: { legend: { position: "top" } },
        },
    });
}

// --- Likert Split Toggles ---

function setupLikertSplitToggles(data) {
    const configs = [
        {
            selectId: "satisfaction-split",
            canvasId: "chart-satisfaction",
            chartKey: "satisfaction",
            dist: data.satisfaction_distribution,
            color: COLORS.primary,
            mean: data.satisfaction_mean,
            byField: data.satisfaction_by_field,
            byWritingExp: data.satisfaction_by_writing_exp,
            byAiExp: data.satisfaction_by_ai_exp,
        },
        {
            selectId: "future-ai-split",
            canvasId: "chart-future-ai",
            chartKey: "futureAi",
            dist: data.future_ai_likelihood_distribution,
            color: COLORS.primaryMid,
            mean: data.future_ai_likelihood_mean,
            byField: data.future_ai_likelihood_by_field,
            byWritingExp: data.future_ai_likelihood_by_writing_exp,
            byAiExp: data.future_ai_likelihood_by_ai_exp,
        },
        {
            selectId: "review-influence-split",
            canvasId: "chart-review-influence",
            chartKey: "reviewInfluence",
            dist: data.ai_review_influence_distribution,
            color: COLORS.accent,
            mean: data.ai_review_influence_mean,
            byField: data.ai_review_influence_by_field,
            byWritingExp: data.ai_review_influence_by_writing_exp,
            byAiExp: data.ai_review_influence_by_ai_exp,
        },
    ];

    for (const cfg of configs) {
        const select = document.getElementById(cfg.selectId);
        if (!select) continue;
        select.addEventListener("change", () => {
            if (likertCharts[cfg.chartKey]) {
                likertCharts[cfg.chartKey].destroy();
                likertCharts[cfg.chartKey] = null;
            }
            const mode = select.value;
            if (mode === "all") {
                likertCharts[cfg.chartKey] = renderLikert7(cfg.canvasId, cfg.dist, cfg.color, cfg.mean);
            } else {
                const splitData = mode === "field" ? cfg.byField
                    : mode === "writing_exp" ? cfg.byWritingExp
                    : cfg.byAiExp;
                likertCharts[cfg.chartKey] = renderLikertSplit(cfg.canvasId, splitData);
            }
        });
    }
}

function renderLikertSplit(canvasId, splitMeans) {
    const groups = Object.keys(splitMeans || {});
    const values = groups.map(g => splitMeans[g]);
    const colors = groups.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]);

    return new Chart(document.getElementById(canvasId), {
        type: "bar",
        data: {
            labels: groups,
            datasets: [{ data: values, backgroundColor: colors, borderRadius: 4 }],
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { min: 1, max: 7, title: { display: true, text: "Mean (1–7)" } } },
        },
    });
}

// --- Mean Scores by Field (grouped bar) ---

function renderLikertByField(data) {
    const satByField = data.satisfaction_by_field || {};
    const futByField = data.future_ai_likelihood_by_field || {};
    const revByField = data.ai_review_influence_by_field || {};

    // Collect all fields
    const fields = [...new Set([
        ...Object.keys(satByField), ...Object.keys(futByField), ...Object.keys(revByField),
    ])];

    new Chart(document.getElementById("chart-likert-by-field"), {
        type: "bar",
        data: {
            labels: fields,
            datasets: [
                { label: "Satisfaction", data: fields.map(f => satByField[f] || 0), backgroundColor: COLORS.primary, borderRadius: 4 },
                { label: "Future AI Likelihood", data: fields.map(f => futByField[f] || 0), backgroundColor: COLORS.primaryMid, borderRadius: 4 },
                { label: "AI Review Influence", data: fields.map(f => revByField[f] || 0), backgroundColor: COLORS.accent, borderRadius: 4 },
            ],
        },
        options: {
            responsive: true,
            plugins: { legend: { position: "top" } },
            scales: { y: { min: 1, max: 7, title: { display: true, text: "Mean (1–7)" } } },
        },
    });
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}
