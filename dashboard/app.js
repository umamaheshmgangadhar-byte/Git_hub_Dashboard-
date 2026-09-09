const state = {
  data: null,
  filteredRuns: [],
  chart: null,
  analyticsChart: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "—";
  let total = Math.round(Number(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function statusBadge(category) {
  const normalized = ["success", "failed", "running", "other"].includes(category)
    ? category
    : "other";
  const label = normalized === "running" ? "Running" : normalized[0].toUpperCase() + normalized.slice(1);
  return `<span class="badge ${normalized}">${label}</span>`;
}

function setError(message) {
  const banner = $("errorBanner");
  if (!message) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.textContent = message;
  banner.classList.remove("hidden");
}

async function loadData() {
  const response = await fetch(`data/dashboard.json?ts=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Unable to load dashboard data (HTTP ${response.status}).`);
  return response.json();
}

function populateFilters() {
  const data = state.data;
  const repos = [...new Set(data.repositories.map((r) => r.name))].sort();
  const workflows = [...new Set(data.workflows.map((w) => w.name))].sort();
  const branches = [...new Set(data.workflow_runs.map((r) => r.branch).filter(Boolean))].sort();

  fillSelect($("repositoryFilter"), repos);
  fillSelect($("workflowFilter"), workflows);
  fillSelect($("branchFilter"), branches);
}

function fillSelect(select, values) {
  const current = select.value;
  select.innerHTML = `<option value="">All</option>` +
    values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  if (values.includes(current)) select.value = current;
}

function getFilteredRuns() {
  const repository = $("repositoryFilter").value;
  const workflow = $("workflowFilter").value;
  const branch = $("branchFilter").value;
  const status = $("statusFilter").value;
  const days = Number($("timeFilter").value || 7);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return state.data.workflow_runs.filter((run) => {
    const created = new Date(run.created_at).getTime();
    if (repository && run.repository !== repository) return false;
    if (workflow && run.workflow_name !== workflow) return false;
    if (branch && run.branch !== branch) return false;
    if (status && run.category !== status) return false;
    if (!Number.isNaN(created) && created < cutoff) return false;
    return true;
  });
}

function renderKpis(runs) {
  const repositories = state.data.repositories.length;
  const workflows = state.data.workflows.length;
  const success = runs.filter((r) => r.category === "success").length;
  const failed = runs.filter((r) => r.category === "failed").length;
  const running = runs.filter((r) => r.category === "running").length;
  const denominator = success + failed;
  const successRate = denominator ? (success / denominator) * 100 : 0;

  const cards = [
    ["Repositories", repositories, "Non-archived repositories"],
    ["Workflows", workflows, "Discovered Actions workflows"],
    ["Total Runs", runs.length, "Within current filters"],
    ["Success Rate", `${successRate.toFixed(1)}%`, "Completed success / failure"],
    ["Failed", failed, "Failure-classified runs"],
    ["Running", running, "Queued or in progress"],
  ];

  $("kpiGrid").innerHTML = cards.map(([label, value, note]) => `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${escapeHtml(value)}</div>
      <div class="kpi-note">${note}</div>
    </div>
  `).join("");
}

function renderPerformance(runs) {
  const durations = runs
    .filter((r) => r.duration_seconds !== null && ["success", "failed", "other"].includes(r.category))
    .map((r) => Number(r.duration_seconds));

  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const fastest = durations.length ? Math.min(...durations) : 0;
  const slowest = durations.length ? Math.max(...durations) : 0;
  const failed = runs.filter((r) => r.category === "failed").length;
  const success = runs.filter((r) => r.category === "success").length;
  const failureRate = success + failed ? (failed / (success + failed)) * 100 : 0;

  const rows = [
    ["Average Duration", formatDuration(avg)],
    ["Fastest Run", formatDuration(fastest)],
    ["Slowest Run", formatDuration(slowest)],
    ["Failure Rate", `${failureRate.toFixed(1)}%`],
  ];

  $("performanceCards").innerHTML = rows.map(([label, value]) => `
    <div class="metric-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");
}

function renderChart(runs) {
  const labels = state.data.chart.labels;
  const dayMap = {};
  labels.forEach((day) => dayMap[day] = { success: 0, failed: 0, running: 0 });

  runs.forEach((run) => {
    const date = new Date(run.created_at);
    if (Number.isNaN(date.getTime())) return;
    const day = date.toISOString().slice(0, 10);
    if (dayMap[day] && dayMap[day][run.category] !== undefined) {
      dayMap[day][run.category] += 1;
    }
  });

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Successful runs",
          data: labels.map((d) => dayMap[d].success),
          borderWidth: 2,
          tension: .35,
        },
        {
          label: "Failed runs",
          data: labels.map((d) => dayMap[d].failed),
          borderWidth: 2,
          tension: .35,
        },
        {
          label: "Running runs",
          data: labels.map((d) => dayMap[d].running),
          borderWidth: 2,
          borderDash: [5, 4],
          tension: .35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
      },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  };

  if (state.chart) state.chart.destroy();
  state.chart = new Chart($("workflowChart"), config);
}

function repoHealthRows(runs) {
  const byRepo = {};
  state.data.repositories.forEach((repo) => {
    byRepo[repo.full_repository_name] = {
      repo,
      runs: runs.filter((r) => r.full_repository_name === repo.full_repository_name),
    };
  });

  return Object.values(byRepo).map(({ repo, runs: repoRuns }) => {
    const success = repoRuns.filter((r) => r.category === "success").length;
    const failed = repoRuns.filter((r) => r.category === "failed").length;
    const durations = repoRuns.filter((r) => r.duration_seconds !== null).map((r) => Number(r.duration_seconds));
    const denominator = success + failed;
    const latest = [...repoRuns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    return {
      repo,
      runs: repoRuns.length,
      success,
      failed,
      successRate: denominator ? (success / denominator) * 100 : 0,
      avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      latest,
    };
  }).sort((a, b) => b.failed - a.failed || b.runs - a.runs);
}

function renderHealthTable(runs) {
  const rows = repoHealthRows(runs).slice(0, 12);
  $("healthTable").innerHTML = `
    <thead><tr>
      <th>Repository</th><th>Workflows</th><th>Runs</th><th>Success %</th>
      <th>Failed</th><th>Average Duration</th><th>Latest Status</th>
    </tr></thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          <td><a class="repo-link" href="${escapeHtml(row.repo.url)}" target="_blank" rel="noopener">${escapeHtml(row.repo.name)}</a><div class="subtext">${escapeHtml(row.repo.visibility)}</div></td>
          <td>${row.repo.workflows}</td>
          <td>${row.runs}</td>
          <td>${row.successRate.toFixed(1)}%</td>
          <td>${row.failed}</td>
          <td>${formatDuration(row.avg)}</td>
          <td>${statusBadge(row.latest?.category || "other")}</td>
        </tr>
      `).join("")}
    </tbody>`;
}

function renderRecentRuns(runs) {
  const rows = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);
  $("recentRunsTable").innerHTML = `
    <thead><tr><th>Repository</th><th>Workflow</th><th>Branch</th><th>Status</th><th>Duration</th><th>Timestamp</th></tr></thead>
    <tbody>${rows.map((run) => `
      <tr>
        <td>${escapeHtml(run.repository)}</td>
        <td>${escapeHtml(run.workflow_name)}</td>
        <td>${escapeHtml(run.branch)}</td>
        <td>${statusBadge(run.category)}</td>
        <td>${formatDuration(run.duration_seconds)}</td>
        <td>${formatDate(run.created_at)}</td>
      </tr>`).join("")}</tbody>`;
}

function renderFailures(runs) {
  const failures = [...runs].filter((r) => r.category === "failed")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 6);

  $("failureList").innerHTML = failures.length
    ? failures.map((run) => `
      <div class="failure-item">
        <div class="failure-title">
          <div class="failure-name">${escapeHtml(run.repository)} / ${escapeHtml(run.workflow_name)}</div>
          <a class="view-run" href="${escapeHtml(run.run_url)}" target="_blank" rel="noopener">View Run</a>
        </div>
        <div class="failure-meta">${escapeHtml(run.branch)} • ${formatDate(run.created_at)}</div>
      </div>`).join("")
    : `<div class="empty-state" style="padding:30px 10px"><strong>No failures in the current filter.</strong></div>`;

  $("failuresTable").innerHTML = `
    <thead><tr><th>Repository</th><th>Workflow</th><th>Branch</th><th>Failure Time</th><th>Action</th></tr></thead>
    <tbody>${failures.length ? failures.map((run) => `
      <tr>
        <td>${escapeHtml(run.repository)}</td>
        <td>${escapeHtml(run.workflow_name)}</td>
        <td>${escapeHtml(run.branch)}</td>
        <td>${formatDate(run.created_at)}</td>
        <td><a class="view-run" href="${escapeHtml(run.run_url)}" target="_blank" rel="noopener">View Run</a></td>
      </tr>`).join("") : `<tr><td colspan="5">No failures found.</td></tr>`}</tbody>`;
}

function renderRepositories() {
  $("repositoriesTable").innerHTML = `
    <thead><tr><th>Repository</th><th>Visibility</th><th>Workflows</th><th>Runs</th><th>Success</th><th>Failed</th><th>Running</th><th>Average</th><th>Latest</th></tr></thead>
    <tbody>${state.data.repositories.map((repo) => `
      <tr>
        <td><a class="repo-link" href="${escapeHtml(repo.url)}" target="_blank" rel="noopener">${escapeHtml(repo.full_repository_name)}</a></td>
        <td>${escapeHtml(repo.visibility)}</td>
        <td>${repo.workflows}</td>
        <td>${repo.runs}</td>
        <td>${repo.success_percentage.toFixed(1)}%</td>
        <td>${repo.failed_runs}</td>
        <td>${repo.running_runs}</td>
        <td>${formatDuration(repo.average_duration_seconds)}</td>
        <td>${statusBadge(repo.latest_status)}</td>
      </tr>`).join("")}</tbody>`;
}

function renderWorkflows() {
  $("workflowsTable").innerHTML = `
    <thead><tr><th>Workflow</th><th>Repository</th><th>State</th><th>Path</th><th>Actions</th></tr></thead>
    <tbody>${state.data.workflows.map((workflow) => `
      <tr>
        <td><strong>${escapeHtml(workflow.name)}</strong></td>
        <td>${escapeHtml(workflow.full_repository_name)}</td>
        <td>${escapeHtml(workflow.state)}</td>
        <td>${escapeHtml(workflow.path)}</td>
        <td>${workflow.url ? `<a class="view-run" href="${escapeHtml(workflow.url)}" target="_blank" rel="noopener">Open</a>` : "—"}</td>
      </tr>`).join("")}</tbody>`;
}

function renderRuns(runs) {
  const rows = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
  $("runsTable").innerHTML = `
    <thead><tr><th>Run ID</th><th>Repository</th><th>Workflow</th><th>Branch</th><th>Event</th><th>Status</th><th>Duration</th><th>Actor</th><th>Created</th><th>Open</th></tr></thead>
    <tbody>${rows.map((run) => `
      <tr>
        <td>${escapeHtml(run.run_id)}</td>
        <td>${escapeHtml(run.repository)}</td>
        <td>${escapeHtml(run.workflow_name)}</td>
        <td>${escapeHtml(run.branch)}</td>
        <td>${escapeHtml(run.event)}</td>
        <td>${statusBadge(run.category)}</td>
        <td>${formatDuration(run.duration_seconds)}</td>
        <td>${escapeHtml(run.actor)}</td>
        <td>${formatDate(run.created_at)}</td>
        <td><a class="view-run" href="${escapeHtml(run.run_url)}" target="_blank" rel="noopener">View</a></td>
      </tr>`).join("")}</tbody>`;
}

function renderDeployments() {
  const deployments = state.data.deployments || [];
  $("deploymentsTable").innerHTML = `
    <thead><tr><th>Repository</th><th>Environment</th><th>Ref</th><th>Task</th><th>Creator</th><th>Created</th><th>Open</th></tr></thead>
    <tbody>${deployments.length ? deployments.map((deployment) => `
      <tr>
        <td>${escapeHtml(deployment.full_repository_name)}</td>
        <td>${escapeHtml(deployment.environment || "—")}</td>
        <td>${escapeHtml(deployment.ref || "—")}</td>
        <td>${escapeHtml(deployment.task || "—")}</td>
        <td>${escapeHtml(deployment.creator)}</td>
        <td>${formatDate(deployment.created_at)}</td>
        <td><a class="view-run" href="${escapeHtml(deployment.deployment_url)}" target="_blank" rel="noopener">Open</a></td>
      </tr>`).join("") : `<tr><td colspan="7">No deployments were recorded in the last 7 days.</td></tr>`}</tbody>`;
}

function renderAnalytics(runs) {
  const success = runs.filter((r) => r.category === "success").length;
  const failed = runs.filter((r) => r.category === "failed").length;
  const running = runs.filter((r) => r.category === "running").length;
  const completed = success + failed;
  const successRate = completed ? success / completed * 100 : 0;
  const durations = runs.filter((r) => r.duration_seconds !== null).map((r) => Number(r.duration_seconds));
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  $("analyticsKpis").innerHTML = [
    ["Completed Runs", completed],
    ["Success Rate", `${successRate.toFixed(1)}%`],
    ["Failure Rate", `${(completed ? failed / completed * 100 : 0).toFixed(1)}%`],
    ["Average Duration", formatDuration(avg)],
    ["Running", running],
    ["Deployments", (state.data.deployments || []).length],
  ].map(([label, value]) => `
    <div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${escapeHtml(value)}</div></div>
  `).join("");

  const labels = state.data.chart.labels;
  const chartData = (category) => labels.map((day) =>
    runs.filter((r) => r.category === category && String(r.created_at).slice(0, 10) === day).length
  );

  if (state.analyticsChart) state.analyticsChart.destroy();
  state.analyticsChart = new Chart($("analyticsChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Success", data: chartData("success"), borderWidth: 1 },
        { label: "Failed", data: chartData("failed"), borderWidth: 1 },
        { label: "Running", data: chartData("running"), borderWidth: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
      plugins: { legend: { position: "bottom" } },
    },
  });
}

function renderAll() {
  const runs = getFilteredRuns();
  state.filteredRuns = runs;

  $("organizationName").textContent = state.data.organization;
  $("settingsOrg").textContent = state.data.organization;
  $("lastUpdated").textContent = `Updated ${formatDate(state.data.generated_at)}`;

  renderKpis(runs);
  renderPerformance(runs);
  renderChart(runs);
  renderHealthTable(runs);
  renderRecentRuns(runs);
  renderFailures(runs);
  renderRepositories();
  renderWorkflows();
  renderRuns(runs);
  renderDeployments();
  renderAnalytics(runs);
}

function switchSection(section) {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.section === section);
  });
  document.querySelectorAll(".content-section").forEach((el) => {
    el.classList.toggle("active", el.id === `section-${section}`);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function initialize() {
  try {
    setError("");
    state.data = await loadData();
    populateFilters();
    renderAll();
  } catch (error) {
    console.error(error);
    setError(error.message || "Unable to load dashboard data.");
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchSection(button.dataset.section));
});

document.querySelectorAll("[data-section-link]").forEach((button) => {
  button.addEventListener("click", () => switchSection(button.dataset.sectionLink));
});

["repositoryFilter", "workflowFilter", "branchFilter", "statusFilter", "timeFilter"].forEach((id) => {
  $(id).addEventListener("change", renderAll);
});

$("refreshButton").addEventListener("click", initialize);

initialize();
