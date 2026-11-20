const $ = (id) => document.getElementById(id);
const state = {
  mode: "user",
  key: "",
  me: null,
  users: [],
  tasks: [],
  page: "overview",
  selectedTaskId: null,
  instructions: [],
  timer: null,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeTask(task) {
  return {
    ...task,
    phase:
      task.phase || (task.status === "succeeded" ? "completed" : task.status),
    activity: task.activity || null,
    currentStep: Number.isInteger(task.currentStep) ? task.currentStep : 0,
    completedSteps: Number.isInteger(task.completedSteps)
      ? task.completedSteps
      : 0,
    followupCount: Number.isInteger(task.followupCount)
      ? task.followupCount
      : 0,
    previousReport: task.previousReport || null,
  };
}

function notice(message, error = false) {
  const node = $("notice");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${state.key}` };
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    ...options,
    headers,
    cache: "no-store",
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("The server returned an invalid response");
  }
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function setMode(mode) {
  state.mode = mode;
  for (const value of ["user", "admin"]) {
    const button = $(`mode-${value}`);
    button.classList.toggle("active", value === mode);
    button.setAttribute("aria-selected", String(value === mode));
  }
  $("login-hint").textContent =
    mode === "admin"
      ? "The admin key is kept only in memory and clears when this page closes."
      : "Your key is kept in this browser tab for this session.";
  $("login-error").hidden = true;
}

function showLogin() {
  clearInterval(state.timer);
  state.timer = null;
  state.key = "";
  state.me = null;
  state.tasks = [];
  state.users = [];
  state.instructions = [];
  sessionStorage.removeItem("cloud-agent-key");
  $("api-key").value = "";
  $("workspace").hidden = true;
  $("login").hidden = false;
}

async function connect(key, mode) {
  state.key = key.trim();
  state.mode = mode;
  try {
    if (mode === "admin") {
      state.users = await api("/v1/admin/users");
      state.me = { name: "Administrator", repos: [] };
      sessionStorage.removeItem("cloud-agent-key");
    } else {
      state.me = await api("/v1/me");
      sessionStorage.setItem("cloud-agent-key", state.key);
    }
    $("login-error").hidden = true;
    $("login").hidden = true;
    $("workspace").hidden = false;
    $("profile-name").textContent = state.me.name;
    $("profile-role").textContent =
      mode === "admin" ? "Administrator" : "Team member";
    $("avatar").textContent = state.me.name.charAt(0).toUpperCase();
    $("nav-team").hidden = mode !== "admin";
    $("new-task-button").hidden = mode === "admin";
    $("quick-create").hidden = mode === "admin";
    switchPage("overview");
    await refresh();
    state.timer = setInterval(() => {
      void refresh(true);
    }, 5000);
  } catch (error) {
    showLogin();
    setMode(mode);
    $("api-key").value = key;
    $("login-error").textContent = error.message;
    $("login-error").hidden = false;
  }
}

function switchPage(page) {
  state.page = page;
  const labels = { overview: "Overview", tasks: "Tasks", team: "Team" };
  for (const name of Object.keys(labels)) {
    $(`${name}-panel`).hidden = name !== page;
    $(`nav-${name}`).classList.toggle("active", name === page);
  }
  $("page-title").textContent = labels[page];
  $("page-crumb").textContent = labels[page];
  $("page-subtitle").textContent =
    page === "overview"
      ? "A clear view of everything your agents are working on."
      : page === "tasks"
        ? "Track each request from queue to pull request."
        : "Manage who can submit tasks and which repositories they can access.";
}

async function refresh(silent = false) {
  try {
    const [tasks, health, users] = await Promise.all([
      api(state.mode === "admin" ? "/v1/admin/tasks" : "/v1/tasks"),
      fetch("/health", { cache: "no-store" }).then((response) =>
        response.json(),
      ),
      state.mode === "admin" ? api("/v1/admin/users") : Promise.resolve(null),
    ]);
    state.tasks = tasks.map(normalizeTask);
    if (users) state.users = users;
    $("worker-count").textContent = `${health.warmWorkers ?? 0} warm workers`;
    render();
    if (state.selectedTaskId && $("detail-dialog").open) {
      const selected = state.tasks.find(
        (task) => task.id === state.selectedTaskId,
      );
      if (selected) renderDetail(selected);
      if (state.mode === "user") void refreshInstructions(state.selectedTaskId);
    }
  } catch (error) {
    if (!silent) notice(error.message, true);
  }
}

function statusBadge(status) {
  return element("span", `status-badge status-${status}`, status);
}

function taskRow(task) {
  const row = element("button", "task-row");
  row.type = "button";
  row.append(
    element(
      "span",
      "task-symbol",
      task.status === "succeeded" ? "✓" : task.status === "failed" ? "!" : "✳",
    ),
  );
  const copy = element("span", "task-copy");
  copy.append(element("strong", "", task.task));
  copy.append(
    element(
      "small",
      "",
      `${task.repo}${task.userName ? ` · ${task.userName}` : ""}`,
    ),
  );
  if (task.status === "running" || task.completedSteps > 0) {
    const step = task.currentStep || task.completedSteps;
    copy.append(
      element(
        "small",
        "task-progress",
        `${task.status === "running" ? `Step ${step} of up to ${task.maxSteps}` : `${task.completedSteps} steps completed`} · ${task.activity || task.phase || task.status}`,
      ),
    );
  }
  row.append(copy);
  const side = element("span", "task-side");
  side.append(statusBadge(task.status));
  side.append(
    element(
      "time",
      "",
      new Date(task.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    ),
  );
  row.append(side);
  row.addEventListener("click", () => {
    state.selectedTaskId = task.id;
    renderDetail(task);
    $("detail-dialog").showModal();
    if (state.mode === "user") void refreshInstructions(task.id);
  });
  return row;
}

function renderList(container, tasks, message) {
  container.replaceChildren();
  if (!tasks.length) {
    const empty = element("div", "empty-state");
    empty.append(element("strong", "", "Nothing here yet"));
    empty.append(element("span", "", message));
    container.append(empty);
  } else tasks.forEach((task) => container.append(taskRow(task)));
}

function render() {
  const tasks = state.tasks;
  $("stat-total").textContent = String(tasks.length);
  $("stat-running").textContent = String(
    tasks.filter(
      (task) => task.status === "queued" || task.status === "running",
    ).length,
  );
  $("stat-succeeded").textContent = String(
    tasks.filter((task) => task.status === "succeeded").length,
  );
  $("stat-failed").textContent = String(
    tasks.filter((task) => task.status === "failed").length,
  );
  $("task-count").textContent =
    `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;
  renderList(
    $("recent-list"),
    tasks.slice(0, 5),
    "Submit a task to see your agent's progress here.",
  );
  renderList($("full-task-list"), tasks, "Your task history will appear here.");
  if (state.mode === "admin") renderUsers();
}

function renderDetail(task) {
  $("detail-title").textContent = task.task;
  const badge = $("detail-status");
  badge.className = `status-badge status-${task.status}`;
  badge.textContent = task.status;
  const meta = $("detail-meta");
  meta.replaceChildren();
  for (const value of [
    task.repo,
    task.userName,
    task.model,
    `Attempt ${task.attempts}/${task.maxAttempts}`,
    `Max ${task.maxSteps} steps`,
    new Date(task.createdAt).toLocaleString(),
  ]) {
    if (value) meta.append(element("span", "", value));
  }
  const phaseLabels = {
    queued: "Waiting in queue",
    retrying: "Waiting for another worker",
    preparing: "Preparing repository",
    working: "Agent is working",
    publishing: "Publishing result",
    completed: "Task complete",
    failed: "Task stopped",
  };
  $("detail-phase").textContent =
    phaseLabels[task.phase] || phaseLabels[task.status] || "Working";
  $("detail-step-label").textContent =
    task.status === "running" && task.phase === "working"
      ? `Step ${task.currentStep || Math.min(task.completedSteps + 1, task.maxSteps)} of up to ${task.maxSteps}`
      : `${task.completedSteps} of ${task.maxSteps} steps completed`;
  $("detail-activity").textContent =
    task.activity ||
    (task.status === "queued"
      ? "Waiting for an available worker"
      : "No activity yet");
  const track = $("detail-progress-track");
  track.setAttribute("aria-valuemax", String(task.maxSteps));
  track.setAttribute(
    "aria-valuenow",
    String(Math.min(task.completedSteps, task.maxSteps)),
  );
  $("detail-progress-fill").style.width =
    `${Math.min(100, Math.max(0, (task.completedSteps / task.maxSteps) * 100))}%`;
  const stageNames = ["Queued", "Repository", "Agent", "Publish"];
  const stageIndex =
    task.status === "succeeded"
      ? 4
      : task.phase === "publishing"
        ? 3
        : task.phase === "working"
          ? 2
          : task.phase === "preparing"
            ? 1
            : 0;
  const stages = $("detail-stages");
  stages.replaceChildren();
  stageNames.forEach((name, index) =>
    stages.append(
      element(
        "span",
        index < stageIndex ? "done" : index === stageIndex ? "active" : "",
        name,
      ),
    ),
  );
  $("detail-report").textContent =
    task.report ||
    (task.status === "queued"
      ? "Waiting for a worker to pick up this task."
      : task.status === "running"
        ? "Your agent is working. This view updates automatically."
        : "No report available.");
  $("previous-report-wrap").hidden = !task.previousReport;
  $("previous-report").textContent = task.previousReport || "";
  $("detail-error-wrap").hidden = !task.error;
  $("detail-error").textContent = task.error || "";
  $("instruction-section").hidden = state.mode !== "user";
  const isContinuation = task.status === "succeeded";
  const canSend =
    isContinuation ||
    task.status === "queued" ||
    (task.status === "running" &&
      task.phase !== "publishing" &&
      (task.phase !== "working" || task.currentStep < task.maxSteps));
  $("instruction-hint").textContent = isContinuation
    ? "Continue this task with a new instruction. The agent will use the previous report and update its open pull request if it has one."
    : "Send guidance while the task is active. The agent reads it before its next model step.";
  $("instruction-submit").textContent = isContinuation
    ? "Continue task →"
    : "Send instruction →";
  $("instruction-form").hidden = !canSend;
  $("instruction-closed").hidden = canSend;
  const link = $("detail-pr");
  link.hidden = true;
  link.removeAttribute("href");
  if (task.prUrl) {
    try {
      const url = new URL(task.prUrl);
      if (url.protocol === "https:" && url.hostname === "github.com") {
        link.href = url.href;
        link.hidden = false;
      }
    } catch {
      /* Ignore invalid links. */
    }
  }
}

async function refreshInstructions(taskId) {
  try {
    const instructions = await api(
      `/v1/tasks/${encodeURIComponent(taskId)}/instructions`,
    );
    if (state.selectedTaskId !== taskId || !$("detail-dialog").open) return;
    state.instructions = instructions;
    const task = state.tasks.find((item) => item.id === taskId);
    const list = $("instruction-list");
    list.replaceChildren();
    if (!instructions.length) {
      list.append(
        element("p", "instruction-hint", "No additional instructions yet."),
      );
      return;
    }
    for (const instruction of instructions) {
      const bubble = element("div", "instruction-bubble");
      bubble.append(element("p", "", instruction.text));
      bubble.append(
        element(
          "small",
          "",
          `${instruction.status === "delivered" ? "Delivered to agent" : task?.status === "failed" || task?.status === "succeeded" ? "Not delivered" : "Waiting for next step"} · ${new Date(instruction.createdAt).toLocaleTimeString()}`,
        ),
      );
      list.append(bubble);
    }
  } catch (error) {
    notice(error.message, true);
  }
}

function renderUsers() {
  const container = $("users-list");
  container.replaceChildren();
  if (!state.users.length) {
    container.append(
      element(
        "div",
        "empty-state",
        "No team members yet. Add one to give them access.",
      ),
    );
    return;
  }
  for (const user of state.users) {
    const card = element("article", "user-card");
    const head = element("div", "user-head");
    head.append(element("span", "avatar", user.name.charAt(0).toUpperCase()));
    const identity = element("div");
    identity.append(element("strong", "", user.name));
    identity.append(
      element(
        "small",
        "",
        `Joined ${new Date(user.createdAt).toLocaleDateString()}`,
      ),
    );
    head.append(identity);
    card.append(head, element("span", "eyebrow", "ALLOWED REPOSITORIES"));
    for (const repo of user.repos)
      card.append(element("span", "repo-chip", repo));
    const form = element("form", "add-repo-row");
    const input = element("input");
    input.placeholder = "owner/repository";
    input.required = true;
    input.setAttribute("aria-label", `Add repository for ${user.name}`);
    const add = element("button", "", "+");
    add.type = "submit";
    add.title = "Add repository";
    form.append(input, add);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      add.disabled = true;
      try {
        await api(`/v1/admin/users/${encodeURIComponent(user.id)}/repos`, {
          method: "POST",
          body: JSON.stringify({ repo: input.value.trim() }),
        });
        input.value = "";
        await refresh();
        notice("Repository access added.");
      } catch (error) {
        notice(error.message, true);
      } finally {
        add.disabled = false;
      }
    });
    card.append(form);
    container.append(card);
  }
}

function openTaskDialog() {
  const select = $("task-repo");
  select.replaceChildren();
  const repos = state.me?.repos || [];
  if (!repos.length) {
    const option = element("option", "", "No repositories assigned");
    option.value = "";
    select.append(option);
  } else
    for (const repo of repos) {
      const option = element("option", "", repo);
      option.value = repo;
      select.append(option);
    }
  $("task-form-error").hidden = true;
  $("task-dialog").showModal();
}

$("mode-user").addEventListener("click", () => setMode("user"));
$("mode-admin").addEventListener("click", () => setMode("admin"));
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  await connect($("api-key").value, state.mode);
  button.disabled = false;
});
$("sign-out").addEventListener("click", showLogin);
for (const page of ["overview", "tasks", "team"])
  $(`nav-${page}`).addEventListener("click", () => switchPage(page));
$("see-all").addEventListener("click", () => switchPage("tasks"));
$("refresh").addEventListener("click", () => void refresh());
for (const id of ["new-task-button", "quick-create"])
  $(id).addEventListener("click", openTaskDialog);
$("task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const task = await api("/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        repo: $("task-repo").value,
        task: $("task-description").value.trim(),
        model: $("task-model").value.trim(),
        maxSteps: Number($("task-steps").value),
      }),
    });
    $("task-dialog").close();
    $("task-form").reset();
    $("task-model").value = "openrouter/free";
    $("task-steps").value = "25";
    await refresh();
    switchPage("tasks");
    notice(`Task submitted for ${task.repo}.`);
  } catch (error) {
    $("task-form-error").textContent = error.message;
    $("task-form-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("instruction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const taskId = state.selectedTaskId;
  if (!taskId) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    const current = state.tasks.find((task) => task.id === taskId);
    const continuing = current?.status === "succeeded";
    await api(
      `/v1/tasks/${encodeURIComponent(taskId)}/${continuing ? "continue" : "instructions"}`,
      {
        method: "POST",
        body: JSON.stringify({ text: $("instruction-text").value.trim() }),
      },
    );
    $("instruction-text").value = "";
    $("instruction-error").hidden = true;
    if (continuing) await refresh();
    await refreshInstructions(taskId);
    notice(
      continuing
        ? "Task continued and queued for a worker."
        : "Instruction sent to the task.",
    );
  } catch (error) {
    $("instruction-error").textContent = error.message;
    $("instruction-error").hidden = false;
    await refresh();
  } finally {
    button.disabled = false;
  }
});
$("add-user-button").addEventListener("click", () => {
  $("user-form").reset();
  $("new-key-wrap").hidden = true;
  $("user-form-error").hidden = true;
  $("create-user-submit").hidden = false;
  $("user-dialog").showModal();
});
$("user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const repos = $("user-repos")
      .value.split(/[\n,]+/)
      .map((repo) => repo.trim())
      .filter(Boolean);
    const user = await api("/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ name: $("user-name").value.trim(), repos }),
    });
    $("new-key").textContent = user.apiKey;
    $("new-key-wrap").hidden = false;
    $("create-user-submit").hidden = true;
    $("user-form-error").hidden = true;
    await refresh();
    notice(`${user.name} was added to the team.`);
  } catch (error) {
    $("user-form-error").textContent = error.message;
    $("user-form-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});
$("copy-key").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("new-key").textContent);
    $("copy-key").textContent = "Copied";
  } catch {
    $("copy-key").textContent = "Select and copy the key above";
  }
});
for (const close of document.querySelectorAll("[data-close]"))
  close.addEventListener("click", () => $(close.dataset.close).close());
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
const savedKey = sessionStorage.getItem("cloud-agent-key");
if (savedKey) void connect(savedKey, "user");
