"use strict";

const state = {
  csrf: "",
  user: null,
  samples: [],
  stream: null,
  currentProfile: "balanced",
  units: [],
  aiSession: null,
  aiSessions: [],
  aiStream: null,
  aiMode: "read_only",
  aiPhase: "sleeping",
  aiInstalled: null,
  aiLoading: false,
  aiCreating: false,
  aiSelecting: false,
  aiManualSync: false,
  aiStopping: false,
  sessionOperationPending: false,
  sessionPendingAction: null,
  aiPermissionPending: false,
  aiDrafts: new Map(),
  aiResponding: false,
  aiRequestPending: false,
  aiSessionBusy: false,
  aiMessages: [],
  aiChatNotice: null,
  aiChatError: null,
  aiPendingRequest: null,
  aiFailedRequest: null,
  aiHistorySync: null,
  aiHistorySyncQueued: false,
  aiRecoveryTimer: null,
  aiContext: { kind: "system", target: null, label: "Visão geral do sistema" },
  pendingPermissions: [],
  pendingQuestions: [],
  questionRefreshPending: false,
  unrestrictedAutoConfirm: false,
  logStream: null,
  logLines: [],
  logPaused: false,
  logTargets: { systemd: [], docker: [] },
  logRenderTimer: null,
};

const $ = (id) => document.getElementById(id);

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.method && options.method !== "GET" && state.csrf) headers.set("x-csrf-token", state.csrf);
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = body && body.error ? body.error.message : `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showLogin() {
  window.carobaguardTerminal?.reset();
  $("app").hidden = true;
  $("login-view").hidden = false;
  $("password").focus();
}

function showApp(session) {
  state.user = session.user;
  state.csrf = session.csrf_token;
  state.unrestrictedAutoConfirm = false;
  try { state.unrestrictedAutoConfirm = localStorage.getItem(`carobaguard.unrestrictedAutoConfirm.${session.user.id}`) === "true"; }
  catch (_) { /* A confirmação continua manual quando o armazenamento não está disponível. */ }
  $("login-view").hidden = true;
  $("app").hidden = false;
  $("user-name").textContent = session.user.username;
  $("user-role").textContent = session.user.role;
  $("user-initial").textContent = session.user.username.slice(0, 1).toUpperCase();
  startMetrics();
}

async function boot() {
  try {
    showApp(await request("/api/v1/auth/me"));
  } catch (_) {
    showLogin();
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const session = await request("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("username").value, password: $("password").value }),
    });
    $("password").value = "";
    showApp(session);
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  window.carobaguardTerminal?.reset();
  try { await request("/api/v1/auth/logout", { method: "POST", body: "{}" }); } catch (_) { /* expire locally */ }
  if (state.stream) state.stream.close();
  if (state.aiStream) state.aiStream.close();
  stopLogStream(false);
  state.stream = null;
  state.aiStream = null;
  state.aiSession = null;
  state.aiDrafts.clear();
  $("chat-prompt").value = "";
  $("ai-session-search").value = "";
  resetAiRequestState();
  state.aiMessages = [];
  state.aiChatNotice = null;
  state.aiChatError = null;
  clearPendingPermissions();
  state.pendingQuestions = [];
  renderPendingQuestion();
  state.unrestrictedAutoConfirm = false;
  state.csrf = "";
  state.user = null;
  showLogin();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => { item.classList.remove("active"); item.removeAttribute("aria-current"); });
    document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
    button.classList.add("active");
    button.setAttribute("aria-current", "page");
    const page = button.dataset.page;
    $(`page-${page}`).classList.add("active");
    $("page-title").textContent = button.textContent.trim();
    loadPage(page);
  });
});

function loadPage(page) {
  if (page === "terminal") window.carobaguardTerminal?.activate();
  else window.carobaguardTerminal?.disconnect();
  if (page === "logs") loadLogs();
  else stopLogStream(false);
  if (page === "docker") loadDocker();
  if (page === "services") loadServices();
  if (page === "audit") loadAudit();
  if (page === "doctor") loadDoctor();
  if (page === "ai") loadAi();
  if (page === "projects") loadProjects();
}

window.addEventListener("carobaguard:toast", (event) => {
  toast(event.detail?.message || "Erro no terminal.", Boolean(event.detail?.error));
});

$("performance-mode").addEventListener("change", async (event) => {
  const enabled = event.currentTarget.checked;
  try {
    const result = await request("/api/v1/metrics/config", {
      method: "POST",
      body: JSON.stringify({ profile: state.currentProfile, performance_mode: enabled }),
    });
    toast(`Intervalo de telemetria alterado para ${result.interval_seconds}s.`);
  } catch (error) {
    event.currentTarget.checked = !enabled;
    toast(error.message, true);
  }
});

async function startMetrics() {
  try {
    const history = await request("/api/v1/metrics/history?limit=240");
    state.samples = history;
    if (history.length) render(history[history.length - 1]);
    drawHistory();
  } catch (error) {
    toast(error.message, true);
  }
  if (state.stream) state.stream.close();
  state.stream = new EventSource("/api/v1/metrics/events");
  state.stream.addEventListener("metrics", (event) => {
    try {
      const sample = JSON.parse(event.data);
      state.samples.push(sample);
      if (state.samples.length > 240) state.samples.shift();
      render(sample);
      drawHistory();
    } catch (_) { /* malformed server event is ignored */ }
  });
  state.stream.onerror = () => {
    $("system-label").textContent = "RECONECTANDO TELEMETRIA";
  };
}

function render(sample) {
  $("system-label").textContent = `${sample.hostname} · ${sample.os}`;
  $("cpu-percent").textContent = `${sample.cpu_percent.toFixed(1)}%`;
  setBar("cpu-bar", sample.cpu_percent);
  $("cpu-load").textContent = `Load ${sample.load_average.map((n) => n.toFixed(2)).join("  ")}`;
  $("cpu-freq").textContent = sample.cpu_frequency_mhz ? `${sample.cpu_frequency_mhz} MHz` : "Freq. indisponível";
  $("memory-percent").textContent = `${sample.memory.percent.toFixed(1)}%`;
  setBar("memory-bar", sample.memory.percent);
  $("memory-used").textContent = `${bytes(sample.memory.used_bytes)} / ${bytes(sample.memory.total_bytes)}`;
  $("swap-used").textContent = `Swap ${bytes(sample.swap.used_bytes)}`;
  $("disk-percent").textContent = `${sample.disk.percent.toFixed(1)}%`;
  setBar("disk-bar", sample.disk.percent);
  $("disk-used").textContent = `${bytes(sample.disk.used_bytes)} / ${bytes(sample.disk.total_bytes)}`;
  $("disk-io").textContent = `R ${rate(sample.disk.read_bytes_per_sec)} · W ${rate(sample.disk.write_bytes_per_sec)}`;
  $("network-total").textContent = rate(sample.network.received_bytes_per_sec + sample.network.transmitted_bytes_per_sec);
  $("network-rx").textContent = rate(sample.network.received_bytes_per_sec);
  $("network-tx").textContent = rate(sample.network.transmitted_bytes_per_sec);
  $("sample-time").textContent = new Date(sample.sampled_at * 1000).toLocaleTimeString();
  $("hostname").textContent = sample.hostname;
  $("os").textContent = sample.os;
  $("kernel").textContent = sample.kernel;
  $("architecture").textContent = sample.architecture;
  $("uptime").textContent = duration(sample.uptime_seconds);
  $("processes").textContent = String(sample.process_count);
  $("self-cpu").textContent = `${sample.carobaguard.cpu_percent.toFixed(2)}%`;
  $("self-memory").textContent = bytes(sample.carobaguard.memory_bytes);
  $("self-disk").textContent = bytes(sample.carobaguard.disk_bytes);
  $("self-network").textContent = rate(sample.carobaguard.network_bytes_per_sec);
  $("self-writes").textContent = `${sample.carobaguard.db_writes_per_minute.toFixed(1)}/min`;
  $("interval-tag").textContent = `${sample.telemetry_interval_seconds}S`;
  $("performance-mode").checked = sample.performance_mode;
  renderCores(sample.per_core_percent);
  renderTemperatures(sample.temperatures);
}

function renderCores(cores) {
  $("core-count").textContent = `${cores.length} CORES`;
  const rows = cores.map((value, index) => {
    const row = document.createElement("div");
    row.className = "core-row";
    const label = document.createElement("span");
    label.textContent = `CPU${index}`;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${clamp(value)}%`;
    bar.append(fill);
    const amount = document.createElement("b");
    amount.textContent = `${value.toFixed(1)}%`;
    row.append(label, bar, amount);
    return row;
  });
  $("core-list").replaceChildren(...rows);
}

function renderTemperatures(temperatures) {
  if (!temperatures.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nenhum sensor exposto pelo kernel.";
    $("temperature-list").replaceChildren(empty);
    return;
  }
  const rows = temperatures.map((temperature) => {
    const row = document.createElement("div");
    row.className = "sensor";
    const label = document.createElement("span");
    label.textContent = temperature.label;
    const value = document.createElement("b");
    value.textContent = `${temperature.celsius.toFixed(1)} °C`;
    row.append(label, value);
    return row;
  });
  $("temperature-list").replaceChildren(...rows);
}

function drawHistory() {
  const canvas = $("history-chart");
  const width = Math.max(canvas.clientWidth, 300);
  const height = 190;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#1e2a33";
  context.lineWidth = 1;
  for (let line = 0; line <= 4; line += 1) {
    const y = 8 + ((height - 20) * line) / 4;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  if (state.samples.length < 2) return;
  drawSeries(context, state.samples.map((sample) => sample.memory.percent), width, height, "#50a7ff");
  drawSeries(context, state.samples.map((sample) => sample.cpu_percent), width, height, "#45dfa2");
}

function drawSeries(context, values, width, height, color) {
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.beginPath();
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = 8 + (1 - clamp(value) / 100) * (height - 20);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

function setBar(id, value) { $(id).style.width = `${clamp(value)}%`; }
function clamp(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }

function bytes(value) {
  const amount = Number(value) || 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  if (amount === 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
  return `${(amount / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent]}`;
}

function rate(value) { return `${bytes(value)}/s`; }

function duration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000);
}

async function loadDocker() {
  $("docker-status").textContent = "Verificando socket…";
  setTableMessage("docker-rows", 6, "Carregando containers…");
  try {
    const status = await request("/api/v1/docker/status");
    if (!status.available) {
      $("docker-status").textContent = `Indisponível · ${status.error || status.socket}`;
      setTableMessage("docker-rows", 6, "Docker Engine não está acessível para este daemon.");
      return;
    }
    $("docker-status").textContent = `Docker ${status.version} · ${status.socket}`;
    const containers = await request("/api/v1/docker/containers");
    renderContainers(containers);
  } catch (error) {
    $("docker-status").textContent = error.message;
    setTableMessage("docker-rows", 6, "Falha ao consultar Docker.");
  }
}

function renderContainers(containers) {
  if (!containers.length) {
    setTableMessage("docker-rows", 6, "Nenhum container encontrado.");
    return;
  }
  const rows = containers.map((container) => {
    const row = document.createElement("tr");
    row.append(
      tableCell(container.name, "primary-cell"),
      tableCell(container.image, "secondary-cell"),
      statusCell(container.state, container.status),
      tableCell(container.compose_project || "—"),
      tableCell(new Date(container.created * 1000).toLocaleDateString()),
      actionCell(container),
    );
    return row;
  });
  $("docker-rows").replaceChildren(...rows);
}

function actionCell(container) {
  const cell = document.createElement("td");
  cell.className = "align-right";
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(actionButton("Logs", () => openDockerLogs(container.id, container.name)));
  if (container.state === "running") {
    actions.append(actionButton("Restart", () => mutateContainer(container.id, "restart")));
    actions.append(actionButton("Stop", () => mutateContainer(container.id, "stop"), "danger"));
  } else {
    actions.append(actionButton("Start", () => mutateContainer(container.id, "start")));
  }
  actions.append(actionButton("Ask AI", () => openAiFor("container", container.id, container.name), "ai"));
  cell.append(actions);
  return cell;
}

async function mutateContainer(id, action) {
  try {
    await request(`/api/v1/docker/containers/${encodeURIComponent(id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    toast(`Container: ${action} solicitado.`);
    await loadDocker();
  } catch (error) { toast(error.message, true); }
}

async function openDockerLogs(id, name) {
  openLogDialog(`Container · ${name}`, "Docker Engine");
  try {
    $("log-output").textContent = await request(`/api/v1/docker/containers/${encodeURIComponent(id)}/logs?tail=500`);
  } catch (error) { $("log-output").textContent = `Erro: ${error.message}`; }
}

async function loadServices() {
  $("services-status").textContent = "Verificando systemd…";
  setTableMessage("service-rows", 5, "Carregando serviços…");
  try {
    const status = await request("/api/v1/services/status");
    if (!status.available) {
      $("services-status").textContent = `Indisponível · ${status.error || "systemctl ausente"}`;
      setTableMessage("service-rows", 5, "systemd não está disponível neste host.");
      return;
    }
    $("services-status").textContent = `System state: ${status.state}${status.error ? ` · ${status.error}` : ""}`;
    state.units = await request("/api/v1/services");
    renderServices();
  } catch (error) {
    $("services-status").textContent = error.message;
    setTableMessage("service-rows", 5, "Falha ao consultar systemd.");
  }
}

function renderServices() {
  const filter = $("service-filter").value.trim().toLocaleLowerCase();
  const units = state.units.filter((unit) => !filter || `${unit.name} ${unit.description}`.toLocaleLowerCase().includes(filter));
  if (!units.length) {
    setTableMessage("service-rows", 5, "Nenhum serviço corresponde ao filtro.");
    return;
  }
  const rows = units.map((unit) => {
    const row = document.createElement("tr");
    const actions = document.createElement("td");
    actions.className = "align-right";
    const buttons = document.createElement("div");
    buttons.className = "row-actions";
    buttons.append(actionButton("Logs", () => openServiceLogs(unit.name)));
    if (unit.active_state === "active") {
      buttons.append(actionButton("Restart", () => mutateService(unit.name, "restart")));
      buttons.append(actionButton("Stop", () => mutateService(unit.name, "stop"), "danger"));
    } else {
      buttons.append(actionButton("Start", () => mutateService(unit.name, "start")));
    }
    buttons.append(actionButton("Ask AI", () => openAiFor("service", unit.name, unit.name), "ai"));
    actions.append(buttons);
    row.append(
      tableCell(unit.name, "primary-cell"),
      tableCell(unit.description, "secondary-cell"),
      statusCell(unit.active_state, unit.active_state),
      tableCell(unit.sub_state),
      actions,
    );
    return row;
  });
  $("service-rows").replaceChildren(...rows);
}

async function mutateService(unit, action) {
  try {
    await request(`/api/v1/services/${encodeURIComponent(unit)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    toast(`Serviço: ${action} solicitado.`);
    await loadServices();
  } catch (error) { toast(error.message, true); }
}

async function openServiceLogs(unit) {
  openLogDialog(`Serviço · ${unit}`, "systemd journal");
  try {
    $("log-output").textContent = await request(`/api/v1/services/${encodeURIComponent(unit)}/logs?lines=500`);
  } catch (error) { $("log-output").textContent = `Erro: ${error.message}`; }
}

async function loadLogs() {
  stopLogStream(false);
  $("stream-log-status").textContent = "Atualizando fontes de log…";
  const [dockerResult, systemdResult] = await Promise.allSettled([
    request("/api/v1/docker/containers"),
    request("/api/v1/services"),
  ]);
  state.logTargets.docker = dockerResult.status === "fulfilled"
    ? dockerResult.value.map((container) => ({ value: container.id, label: container.name }))
    : [];
  state.logTargets.systemd = systemdResult.status === "fulfilled"
    ? systemdResult.value.map((unit) => ({ value: unit.name, label: unit.name }))
    : [];
  renderLogTargets();
  const count = state.logTargets.docker.length + state.logTargets.systemd.length;
  $("stream-log-status").textContent = count
    ? `${count} fontes disponíveis · streaming parado`
    : "Docker e systemd não forneceram fontes de log.";
}

function renderLogTargets() {
  const source = $("stream-log-source").value;
  const previousTarget = $("stream-log-target").value;
  const targets = state.logTargets[source] || [];
  const options = targets.map((target) => {
    const option = document.createElement("option");
    option.value = target.value;
    option.textContent = target.label;
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nenhuma fonte disponível";
    options.push(option);
  }
  $("stream-log-target").replaceChildren(...options);
  if (targets.some((target) => target.value === previousTarget)) {
    $("stream-log-target").value = previousTarget;
  }
}

function startLogStream() {
  const source = $("stream-log-source").value;
  const target = $("stream-log-target").value;
  if (!target) {
    toast("Selecione uma fonte de log disponível.", true);
    return;
  }
  stopLogStream(false);
  state.logLines = [];
  state.logPaused = false;
  renderStreamLogs();
  const query = new URLSearchParams({ source, target, tail: "300" });
  const stream = new EventSource(`/api/v1/logs/events?${query}`);
  let terminalMessage = false;
  state.logStream = stream;
  $("pause-log-stream").disabled = false;
  $("pause-log-stream").textContent = "Pausar";
  $("stream-log-status").textContent = `Conectando · ${source} · ${target}`;
  stream.onopen = () => {
    if (state.logStream === stream) $("stream-log-status").textContent = `LIVE · ${source} · ${target}`;
  };
  stream.addEventListener("line", (event) => {
    if (state.logStream !== stream) return;
    try {
      const message = JSON.parse(event.data);
      appendStreamLog(message.line || "");
    } catch (_) { /* ignore malformed event */ }
  });
  stream.addEventListener("status", (event) => {
    if (state.logStream !== stream) return;
    terminalMessage = true;
    try { $("stream-log-status").textContent = JSON.parse(event.data).message || "Stream encerrado"; }
    catch (_) { $("stream-log-status").textContent = "Stream encerrado"; }
  });
  stream.addEventListener("stream_error", (event) => {
    if (state.logStream !== stream) return;
    terminalMessage = true;
    try { $("stream-log-status").textContent = JSON.parse(event.data).message || "Falha no stream"; }
    catch (_) { $("stream-log-status").textContent = "Falha no stream"; }
  });
  stream.onerror = () => {
    if (state.logStream !== stream) return;
    stream.close();
    state.logStream = null;
    $("pause-log-stream").disabled = true;
    if (!terminalMessage) {
      $("stream-log-status").textContent = "Stream desconectado";
    }
  };
}

function stopLogStream(showStatus = true) {
  if (state.logStream) state.logStream.close();
  state.logStream = null;
  state.logPaused = false;
  const pause = $("pause-log-stream");
  if (pause) {
    pause.disabled = true;
    pause.textContent = "Pausar";
  }
  if (showStatus && $("stream-log-status")) $("stream-log-status").textContent = "Stream parado";
}

function appendStreamLog(line) {
  state.logLines.push(String(line));
  if (state.logLines.length > 5000) state.logLines.splice(0, state.logLines.length - 5000);
  $("stream-log-count").textContent = `${state.logLines.length.toLocaleString()} linhas`;
  if (state.logPaused || state.logRenderTimer) return;
  state.logRenderTimer = window.setTimeout(() => {
    state.logRenderTimer = null;
    renderStreamLogs();
  }, 100);
}

function visibleStreamLogs() {
  const filter = $("stream-log-filter").value.trim().toLocaleLowerCase();
  const level = $("stream-log-level").value;
  return state.logLines.filter((line) => {
    if (filter && !line.toLocaleLowerCase().includes(filter)) return false;
    return level === "all" || classifyLogLevel(line) === level;
  });
}

function classifyLogLevel(line) {
  const value = line.toLocaleLowerCase();
  if (/\b(error|fatal|failed|failure|panic)\b/.test(value)) return "error";
  if (/\b(warn|warning)\b/.test(value)) return "warning";
  return "info";
}

function renderStreamLogs() {
  const output = $("stream-log-output");
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  const lines = visibleStreamLogs();
  output.textContent = lines.length ? lines.join("\n") : "Nenhuma linha corresponde aos filtros.";
  if (follow) output.scrollTop = output.scrollHeight;
}

function toggleLogPause() {
  if (!state.logStream) return;
  state.logPaused = !state.logPaused;
  $("pause-log-stream").textContent = state.logPaused ? "Continuar" : "Pausar";
  $("stream-log-status").textContent = state.logPaused ? "PAUSED · recebimento continua com buffer limitado" : "LIVE";
  if (!state.logPaused) renderStreamLogs();
}

function clearStreamLogs() {
  state.logLines = [];
  $("stream-log-count").textContent = "0 linhas";
  renderStreamLogs();
}

function exportStreamLogs() {
  const content = visibleStreamLogs().join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `carobaguard-logs-${new Date().toISOString().replaceAll(":", "-")}.log`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function loadProjects() {
  setTableMessage("project-rows", 6, "Inspecionando projetos…");
  try {
    const projects = await request("/api/v1/projects");
    $("projects-status").textContent = projects.length
      ? `${projects.length} projeto${projects.length === 1 ? "" : "s"} cadastrado${projects.length === 1 ? "" : "s"}.`
      : "Cadastre um diretório existente dentro das raízes permitidas.";
    renderProjects(projects);
  } catch (error) {
    $("projects-status").textContent = error.message;
    setTableMessage("project-rows", 6, "Falha ao consultar projetos.");
  }
}

function renderProjects(projects) {
  if (!projects.length) {
    setTableMessage("project-rows", 6, "Nenhum projeto cadastrado.");
    return;
  }
  const rows = projects.map((project) => {
    const row = document.createElement("tr");
    const actions = document.createElement("td");
    actions.className = "align-right";
    const buttons = document.createElement("div");
    buttons.className = "row-actions";
    buttons.append(
      actionButton("Open with OpenCode", () => openAiFor("project", project.id, project.name, project.path), "ai"),
      actionButton("Remover", () => removeProject(project), "danger"),
    );
    actions.append(buttons);
    const gitState = project.clean === true
      ? "Clean"
      : project.clean === false
        ? `${project.modified_files} modified`
        : "No Git";
    row.append(
      tableCell(project.name, "primary-cell"),
      tableCell(project.branch || "—"),
      tableCell(gitState),
      tableCell(project.language || "—"),
      tableCell(project.path, "secondary-cell"),
      actions,
    );
    return row;
  });
  $("project-rows").replaceChildren(...rows);
}

async function registerProject(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await request("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({ name: $("project-name").value, path: $("project-path").value }),
    });
    $("project-name").value = "";
    $("project-path").value = "";
    toast("Projeto cadastrado; nenhum arquivo foi modificado.");
    await loadProjects();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}

async function removeProject(project) {
  if (!window.confirm(`Remover apenas o cadastro de ${project.name}? Os arquivos não serão apagados.`)) return;
  try {
    await request(`/api/v1/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    toast("Cadastro removido; arquivos preservados.");
    await loadProjects();
  } catch (error) { toast(error.message, true); }
}

async function loadAudit() {
  setTableMessage("audit-rows", 7, "Carregando trilha de auditoria…");
  try {
    const events = await request("/api/v1/audit?limit=200");
    if (!events.length) {
      setTableMessage("audit-rows", 7, "Nenhuma operação modificadora registrada.");
      return;
    }
    const rows = events.map((event) => {
      const row = document.createElement("tr");
      row.append(
        tableCell(new Date(event.created_at * 1000).toLocaleString()),
        tableCell(event.actor_name, "primary-cell"),
        tableCell(event.origin),
        tableCell(event.action),
        tableCell(event.target, "secondary-cell"),
        statusCell(event.result, event.result),
        tableCell(`${event.duration_ms} ms`),
      );
      return row;
    });
    $("audit-rows").replaceChildren(...rows);
  } catch (error) { setTableMessage("audit-rows", 7, error.message); }
}

async function loadDoctor() {
  $("doctor-summary").textContent = "Executando verificações read-only…";
  const pending = document.createElement("div");
  pending.className = "doctor-empty";
  pending.textContent = "Coletando evidências do host…";
  $("doctor-findings").replaceChildren(pending);
  try {
    const report = await request("/api/v1/doctor");
    $("doctor-summary").textContent = `${report.issues} issue(s) · estado ${report.overall} · ${new Date(report.checked_at * 1000).toLocaleString()}`;
    const cards = report.findings.map((finding) => {
      const card = document.createElement("article");
      card.className = `finding ${finding.severity}`;
      const header = document.createElement("div");
      header.className = "finding-header";
      const title = document.createElement("h3");
      title.textContent = finding.title;
      const badge = document.createElement("span");
      badge.className = "finding-badge";
      badge.textContent = finding.severity;
      header.append(title, badge);
      const details = document.createElement("p");
      details.textContent = finding.details;
      const confidence = document.createElement("span");
      confidence.className = "confidence";
      confidence.textContent = `CONFIDENCE ${(finding.confidence * 100).toFixed(0)}% · ${finding.category}`;
      card.append(header, details, confidence);
      return card;
    });
    $("doctor-findings").replaceChildren(...cards);
  } catch (error) {
    pending.textContent = error.message;
  }
}

function tableCell(text, className = "") {
  const cell = document.createElement("td");
  cell.className = className;
  cell.textContent = String(text);
  return cell;
}

function statusCell(stateName, details) {
  const cell = document.createElement("td");
  const status = document.createElement("span");
  status.className = `status-pill ${String(stateName).toLocaleLowerCase()}`;
  status.textContent = details;
  cell.append(status);
  return cell;
}

function actionButton(label, handler, kind = "") {
  const button = document.createElement("button");
  button.className = `action-button ${kind}`.trim();
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function setTableMessage(id, columns, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = columns;
  cell.className = "table-empty";
  cell.textContent = message;
  row.append(cell);
  $(id).replaceChildren(row);
}

function openLogDialog(title, source) {
  $("log-title").textContent = title;
  $("log-source").textContent = source;
  $("log-output").textContent = "Carregando…";
  $("log-dialog").showModal();
}

function openAiFor(kind, id, label, projectPath = null) {
  if (state.aiResponding || state.aiCreating || state.aiSelecting || state.aiManualSync) {
    document.querySelector('[data-page="ai"]').click();
    toast("Aguarde a conversa atual terminar antes de trocar o contexto.");
    return;
  }
  saveAiDraft();
  state.aiContext = { kind, target: id, label: `${kind} · ${label || id}` };
  state.aiSession = null;
  $("chat-prompt").value = "";
  clearChatMessages();
  $("ai-context").textContent = state.aiContext.label;
  $("ai-project").value = projectPath || "";
  document.querySelector('[data-page="ai"]').click();
  setAiSetup(true);
  toast(`Contexto preparado: ${kind} ${label || id}.`);
}

async function loadAi() {
  if (state.aiLoading) return;
  state.aiLoading = true;
  setAiError();
  updateAiConversation();
  try {
    if (!canOperateAi()) {
      renderAiStatus(await request("/api/v1/opencode/status"));
      return;
    }
    const [status, sessions, questions] = await Promise.all([
      request("/api/v1/opencode/status"),
      request("/api/v1/opencode/sessions"),
      request("/api/v1/opencode/questions"),
    ]);
    renderAiStatus(status);
    if (state.aiSession) {
      state.aiSession = sessions.find((session) => session.id === state.aiSession.id) || null;
    }
    state.pendingQuestions = questions;
    if (!state.aiSession && questions.length && $("ai-setup").hidden) {
      state.aiSession = sessions.find((session) => session.opencode_session_id === questions[0].sessionID) || null;
    }
    renderAiSessions(sessions);
    updateAiConversation();
    renderPendingQuestion();
    if (!state.aiSession && !sessions.length) setAiSetup(true);
    ensureAiEventStream();
    if (state.aiSession) await reconcileAiHistory();
  } catch (error) { setAiError(`Não foi possível atualizar o OpenCode. ${error.message}`); }
  finally { state.aiLoading = false; updateAiConversation(); }
}

function renderAiStatus(status) {
  state.aiInstalled = status.installed;
  state.aiMode = status.permission_mode;
  state.aiPhase = status.phase;
  if (!state.aiResponding) $("ai-status").textContent = aiPhaseLabel(status.phase);
  $("ai-memory").textContent = status.phase === "sleeping" ? "~0 B" : bytes(status.memory_bytes);
  $("ai-version").textContent = status.version || (status.installed ? "Instalado" : "Não instalado");
  $("ai-timeout").textContent = `${status.idle_timeout_seconds}s`;
  renderUnrestrictedWarning();
  updateAiConversation();
  if (status.error) setAiError(`O processo OpenCode encontrou um erro. ${status.error}`);
}

function renderAiSessions(sessions) {
  state.aiSessions = sessions;
  const search = $("ai-session-search").value.trim().toLocaleLowerCase();
  const visible = sessions.filter((session) => `${session.title} ${session.project_path || ""} ${modeLabel(session.permission_mode)}`.toLocaleLowerCase().includes(search));
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = search ? "Nenhuma sessão corresponde à busca." : "Nenhuma sessão ainda. Crie sua primeira conversa.";
    $("ai-sessions").replaceChildren(empty);
    return;
  }
  const cards = visible.map((session) => {
    const card = document.createElement("div");
    card.className = `session-card${state.aiSession?.id === session.id ? " active" : ""}`;
    card.dataset.mode = session.permission_mode;
    card.dataset.status = session.status;
    const title = document.createElement("strong");
    title.textContent = session.title;
    const project = document.createElement("small");
    project.textContent = session.project_path || "Diretório padrão";
    const meta = document.createElement("small");
    meta.textContent = `${session.status || "sleeping"} · ${modeLabel(session.permission_mode)} · ${new Date(session.last_active_at * 1000).toLocaleString()}`;
    const actions = document.createElement("div");
    actions.className = "session-card-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = session.status === "archived" ? "Ver histórico" : "Abrir sessão";
    open.disabled = session.permission_mode === "unrestricted" && state.user?.role !== "admin";
    open.addEventListener("click", () => wakeAiSession(session));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Excluir";
    remove.disabled = session.permission_mode === "unrestricted" && state.user?.role !== "admin";
    remove.addEventListener("click", () => { void sessionOperation("delete", null, session); });
    actions.append(open, remove);
    card.append(title, project, meta, actions);
    return card;
  });
  $("ai-sessions").replaceChildren(...cards);
}

function setAiSetup(open) {
  if (open && (state.aiResponding || state.aiCreating || state.aiSelecting || state.aiManualSync || !canOperateAi())) return;
  $("ai-setup").hidden = !open;
  $("start-ai").setAttribute("aria-expanded", String(open));
  if (open) {
    setAiSessionsDrawer(false, false);
    setSelectedAiMode("read_only");
    $("ai-conversation-name").focus();
  }
}

function setAiSessionsDrawer(open, focus = true) {
  if (open && (state.aiResponding || state.aiCreating || state.aiSelecting || state.aiManualSync || !canOperateAi())) return;
  $("ai-session-drawer").hidden = !open;
  $("wake-ai").setAttribute("aria-expanded", String(open));
  if (open) {
    setAiSetup(false);
    renderAiSessions(state.aiSessions);
    if (focus) $("ai-session-search").focus();
  } else if (focus) $("wake-ai").focus();
}

function canOperateAi() { return ["admin", "operator"].includes(state.user?.role); }

function renderUnrestrictedWarning() {
  $("unrestricted-warning").hidden = !$("ai-show-unrestricted-warning").checked
    || state.aiMode !== "unrestricted" || ["sleeping", "error"].includes(state.aiPhase);
}

function setAiError(message = "") {
  $("ai-error").hidden = !message;
  $("ai-error-text").textContent = message;
}

function saveAiDraft() {
  if (state.aiSession) state.aiDrafts.set(state.aiSession.id, $("chat-prompt").value);
}

function updateAiConversation() {
  const session = state.aiSession;
  $("ai-unrestricted-auto-label").hidden = state.user?.role !== "admin";
  $("ai-unrestricted-auto-confirm").checked = state.unrestrictedAutoConfirm;
  $("ai-session-title").textContent = session ? session.title : "Nenhuma sessão selecionada";
  $("ai-session-meta").textContent = session
    ? session.project_path || "Diretório padrão"
    : "Abra uma sessão ou inicie uma nova conversa.";
  const mode = session?.permission_mode;
  $("ai-mode-badge").textContent = session ? modeLabel(mode) : "Sem sessão";
  $("ai-mode-badge").dataset.mode = mode || "none";
  $("ai-mode-description").textContent = mode === "read_only"
    ? "Somente inspeção. Ferramentas de alteração e comandos são bloqueados."
    : mode === "approval" ? "Alterações solicitam sua autorização nesta conversa antes de executar."
    : mode === "unrestricted" ? "Execução direta, sem aprovação por ação, limitada aos privilégios da conta Linux. A confirmação ao iniciar ou retomar depende da opção acima."
    : "Escolha uma conversa para ver seu modo de segurança.";
  const restriction = !canOperateAi() ? "OpenCode exige perfil Operator ou Admin."
    : state.aiInstalled === false ? "OpenCode não está instalado no servidor. Instale e configure o provedor para iniciar."
    : mode === "unrestricted" && state.user?.role !== "admin" ? "Esta conversa exige um administrador."
    : "";
  $("ai-access-note").textContent = !canOperateAi() ? "Acesso de consulta · Operator ou Admin necessário para conversar"
    : state.aiInstalled === false ? "OpenCode não instalado. Instale e configure o provedor no servidor."
    : state.aiLoading ? "Atualizando sessões e estado do processo…" : "";
  const promptBytes = new TextEncoder().encode($("chat-prompt").value.trim()).length;
  $("chat-hint").textContent = restriction || (state.aiResponding ? "Aguarde a resposta. Para interromper, use Configurações e processo."
    : !session ? "Crie uma conversa ou selecione uma sessão no histórico."
    : promptBytes > 32000 ? "Mensagem muito longa: limite de 32.000 bytes."
    : "Ctrl/⌘ + Enter envia · Enter cria uma nova linha");
  const disabled = !session || session.status === "archived" || state.aiResponding || state.aiLoading || state.aiSelecting || state.aiManualSync || state.aiStopping || state.sessionOperationPending || Boolean(restriction);
  $("chat-prompt").disabled = disabled;
  $("chat-form").querySelector("button[type=submit]").disabled = disabled || !promptBytes || promptBytes > 32000;
  const busy = state.aiResponding || state.aiLoading || state.aiCreating || state.aiSelecting || state.aiManualSync || state.aiStopping || state.sessionOperationPending;
  $("wake-ai").disabled = busy || !canOperateAi() || state.aiInstalled === false;
  $("wake-ai").textContent = state.sessionPendingAction === "resume" ? "Acordando…" : "Acordar";
  $("start-ai").disabled = busy || !canOperateAi() || state.aiInstalled === false;
  $("ai-sessions").querySelectorAll(".session-card").forEach((card) => {
    const restricted = card.dataset.mode === "unrestricted" && state.user?.role !== "admin";
    card.querySelectorAll("button").forEach((button) => {
      button.disabled = busy || !canOperateAi() || restricted;
    });
  });
  $("retry-ai").disabled = busy;
  $("new-ai-session").disabled = busy || !canOperateAi() || state.aiInstalled !== true;
  $("new-ai-session").textContent = state.aiCreating ? "Iniciando conversa…" : "Iniciar conversa";
  $("ai-setup").setAttribute("aria-busy", String(state.aiCreating));
  $("ai-setup").querySelectorAll("input").forEach((input) => {
    input.disabled = state.aiCreating || (input.name === "ai-mode" && input.value === "unrestricted" && state.user?.role !== "admin");
  });
  $("cancel-ai-setup").disabled = state.aiCreating;
  $("stop-ai").disabled = state.aiStopping || state.aiCreating || state.sessionOperationPending || !canOperateAi() || ["sleeping", "starting"].includes(state.aiPhase);
  $("stop-ai").textContent = state.aiStopping ? "Desligando…" : "Desligar";
  $("refresh-ai-history").disabled = !session || !canOperateAi() || state.aiInstalled === false
    || state.aiLoading || state.aiCreating || state.aiSelecting || state.aiManualSync || state.aiStopping;
  $("refresh-ai-history").textContent = state.aiManualSync ? "Atualizando…" : "Atualizar histórico";
  $("ai-chat-recovery").hidden = !state.aiChatError || state.aiFailedRequest?.sessionId !== session?.id;
  $("restore-ai-prompt").disabled = disabled || Boolean($("chat-prompt").value.trim());
  $("ai-restore-hint").textContent = $("chat-prompt").value.trim()
    ? "Seu rascunho foi preservado. Esvazie o campo para recuperar a mensagem anterior."
    : "Recuperar o texto não envia uma mensagem.";
  renderPendingPermission();
}

async function refreshAiHistory() {
  if ($("refresh-ai-history").disabled) return;
  state.aiManualSync = true;
  $("ai-history-status").textContent = "Consultando o histórico no servidor…";
  updateAiConversation();
  try {
    await reconcileAiHistory({ settlePending: true });
    renderAiStatus(await request("/api/v1/opencode/status"));
    $("ai-history-status").textContent = "Histórico atualizado. Nenhuma mensagem foi reenviada.";
  } catch (error) {
    $("ai-history-status").textContent = `Não foi possível atualizar o histórico. ${error.message}`;
  } finally {
    state.aiManualSync = false;
    updateAiConversation();
  }
}

function restoreAiPrompt() {
  const failed = state.aiFailedRequest;
  if ($("restore-ai-prompt").disabled || !failed || failed.sessionId !== state.aiSession?.id) return;
  $("chat-prompt").value = failed.text;
  saveAiDraft();
  updateAiConversation();
  $("chat-prompt").focus();
}

function clearChatMessages(message = null) {
  state.aiMessages = [];
  state.aiChatNotice = message;
  state.aiChatError = null;
  state.aiFailedRequest = null;
  $("ai-history-status").textContent = "O histórico é sincronizado com o servidor.";
  $("ai-chat-recovery").hidden = true;
  renderDisplayedChat();
}

function renderChatHistory(messages) {
  state.aiMessages = CarobaChatRecovery.reconcileHistory(messages);
  state.aiChatNotice = null;
  const failed = state.aiFailedRequest;
  if (!failed || CarobaChatRecovery.hasRecoveredResponse(state.aiMessages, failed.baselineIds, failed.text)) {
    state.aiChatError = null;
    state.aiFailedRequest = null;
  }
  renderDisplayedChat();
}

function renderDisplayedChat() {
  const output = $("chat-messages");
  const previousScroll = output.scrollTop;
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 64;
  $("chat-messages").replaceChildren();
  if (state.aiChatNotice) addChatMessage("system", state.aiChatNotice);
  state.aiMessages.forEach((message) => {
    addChatMessage(message.role === "user" ? "user" : "agent", message.text, !message.pending);
    if (message.error) addChatMessage("error", message.error);
  });
  const optimistic = state.aiPendingRequest || state.aiFailedRequest;
  if (optimistic
      && optimistic.sessionId === state.aiSession?.id
      && !CarobaChatRecovery.hasRemoteUserMessage(state.aiMessages, optimistic)) {
    addChatMessage("user", optimistic.text);
  }
  if (state.aiChatError) addChatMessage("error", `Não foi possível concluir a resposta: ${state.aiChatError}`);
  if (!state.aiChatNotice && !state.aiMessages.length && !optimistic && !state.aiChatError) {
    addChatMessage("system", state.aiSession ? "Conversa pronta. Descreva o que deseja investigar; por exemplo: analise o uso de memória do servidor." : "Investigue o servidor com OpenCode. Crie uma conversa em Read-Only para começar com inspeção, ou abra uma sessão no histórico.");
  }
  output.scrollTop = follow ? output.scrollHeight : previousScroll;
}

async function selectAiSession(session) {
  if (state.aiResponding || state.aiLoading || state.aiCreating || state.aiSelecting || state.aiManualSync || state.aiStopping) return;
  state.aiSelecting = true;
  saveAiDraft();
  state.aiSession = session;
  state.aiContext = { kind: "system", target: null, label: "Visão geral do sistema" };
  $("ai-context").textContent = state.aiContext.label;
  $("chat-prompt").value = state.aiDrafts.get(session.id) || "";
  setAiError();
  $("ai-project").value = session.project_path || "";
  setSelectedAiMode(session.permission_mode);
  renderAiSessions(state.aiSessions);
  updateAiConversation();
  setAiSessionsDrawer(false);
  clearChatMessages();
  renderPendingQuestion();
  setAiResponding(true, "Carregando histórico da sessão…");
  try {
    await reconcileAiHistory();
    await loadSessionWorkspace();
    renderAiStatus(await request("/api/v1/opencode/status"));
  } catch (error) {
    setAiError(`Não foi possível carregar o histórico. ${error.message}`);
  } finally {
    state.aiSelecting = false;
    const remoteResponsePending = state.aiMessages.some((message) => message.role === "assistant" && message.pending);
    if (!state.aiPendingRequest && !remoteResponsePending) setAiResponding(false);
    if (!$("chat-prompt").disabled) $("chat-prompt").focus();
  }
}

function selectedAiMode() {
  return document.querySelector('input[name="ai-mode"]:checked').value;
}

function setSelectedAiMode(mode) {
  const radio = document.querySelector(`input[name="ai-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
}

async function confirmationFor(mode) {
  if (mode !== "unrestricted") return null;
  if (state.user?.role !== "admin") throw new Error("O modo Unrestricted exige administrador.");
  if (state.unrestrictedAutoConfirm) return "I understand OpenCode will have full control";
  const phrase = window.prompt('Digite exatamente "I understand OpenCode will have full control" para ativar controle irrestrito:');
  if (phrase !== "I understand OpenCode will have full control") throw new Error("Confirmação irrestrita não corresponde.");
  return phrase;
}

function startAi() {
  setAiSetup(true);
}

async function wakeAi() {
  if ($("wake-ai").disabled) return;
  if (state.aiSessions.length) {
    setAiSessionsDrawer(true);
  } else {
    setAiSetup(true);
  }
}

async function wakeAiSession(session) {
  if (state.sessionOperationPending || state.aiSelecting || state.aiResponding) return;
  if (state.aiSession?.id !== session.id) await selectAiSession(session);
  else setAiSessionsDrawer(false, false);
  if (state.aiSession?.id === session.id && state.aiSession.status !== "archived"
      && (state.aiSession.status !== "ready" || state.aiPhase !== "ready")) await sessionOperation("resume");
}

async function stopAi() {
  if ($("stop-ai").disabled) return;
  if (!window.confirm("Encerrar o processo OpenCode compartilhado e interromper o trabalho em andamento? O histórico será preservado. Alterações já executadas não serão desfeitas.")) return;
  state.aiStopping = true;
  updateAiConversation();
  try {
    await request("/api/v1/opencode/stop", { method: "POST", body: "{}" });
    resetAiRequestState();
    clearPendingPermissions();
    state.pendingQuestions = [];
    renderPendingQuestion();
    setAiResponding(false);
    const sessions = await request("/api/v1/opencode/sessions");
    renderAiSessions(sessions);
    if (state.aiSession) state.aiSession = sessions.find((session) => session.id === state.aiSession.id) || null;
    renderAiStatus(await request("/api/v1/opencode/status"));
    toast("OpenCode encerrado. Histórico preservado.");
  } catch (error) { setAiError(`Não foi possível encerrar o processo. ${error.message}`); }
  finally { state.aiStopping = false; updateAiConversation(); }
}

async function createAiSession() {
  if ($("new-ai-session").disabled) return;
  saveAiDraft();
  setAiError();
  state.aiCreating = true;
  const mode = selectedAiMode();
  const button = $("new-ai-session");
  button.disabled = true;
  setAiResponding(true, "Criando sessão persistente…");
  try {
    const confirmation = await confirmationFor(mode);
    const project = $("ai-project").value.trim();
    const session = await request("/api/v1/opencode/sessions", {
      method: "POST",
      body: JSON.stringify({
        title: $("ai-conversation-name").value.trim() || state.aiContext.label,
        project_path: project || null,
        permission_mode: mode,
        confirmation,
      }),
    });
    state.aiSession = session;
    $("chat-prompt").value = "";
    $("ai-conversation-name").value = "";
    state.aiMode = mode;
    setAiSetup(false);
    clearChatMessages(`Sessão criada em ${session.project_path}. Use Iniciar / retomar para acordar o agente. Modo: ${modeLabel(session.permission_mode)}.`);
    const sessions = await request("/api/v1/opencode/sessions");
    renderAiSessions(sessions);
    updateAiConversation();
    renderAiStatus(await request("/api/v1/opencode/status"));
    await loadSessionWorkspace();
    return session;
  } catch (error) { setAiError(`Não foi possível iniciar a conversa. ${error.message}`); }
  finally {
    state.aiCreating = false;
    button.disabled = false;
    setAiResponding(false);
    if ($("ai-setup").hidden && !$("chat-prompt").disabled) $("chat-prompt").focus();
  }
}

async function sendChat(event) {
  event.preventDefault();
  const input = $("chat-prompt");
  const message = input.value.trim();
  if (!message || !state.aiSession || $("chat-form").querySelector("button[type=submit]").disabled) return;
  const session = state.aiSession;
  state.aiPendingRequest = {
    sessionId: session.id,
    text: message,
    baselineIds: CarobaChatRecovery.messageIds(state.aiMessages),
    postError: null,
    postResponse: null,
    postSettled: false,
    remoteAccepted: false,
    recoveryAttempts: 0,
    startedAt: Date.now(),
  };
  const submittedRequest = state.aiPendingRequest;
  state.aiChatNotice = null;
  state.aiChatError = null;
  state.aiFailedRequest = null;
  input.value = "";
  state.aiDrafts.delete(session.id);
  state.aiRequestPending = true;
  state.aiSessionBusy = true;
  renderDisplayedChat();
  setAiResponding(true, "OpenCode está analisando…");
  let response;
  try {
    response = await request(`/api/v1/opencode/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        message,
        context: { kind: state.aiContext.kind, target: state.aiContext.target },
      }),
    });
  } catch (error) {
    const pending = state.aiPendingRequest;
    if (pending !== submittedRequest) return;
    pending.postSettled = true;
    pending.postError = error;
    setAiResponding(true, "A conexão falhou; recuperando a resposta pelo histórico…");
    try {
      await reconcileAiHistory({ settlePending: true });
    } catch (_) {
      scheduleAiRecovery();
    }
    if (state.aiPendingRequest === pending && error.status && error.status < 500 && !pending.remoteAccepted) {
      finishAiRequest(error.message);
    }
    if (state.aiPendingRequest === submittedRequest) scheduleAiRecovery();
    return;
  }
  if (state.aiPendingRequest === submittedRequest) {
    state.aiPendingRequest.postSettled = true;
    state.aiPendingRequest.postResponse = response;
    $("ai-thinking-text").textContent = "Confirmando a resposta no histórico…";
    try {
      await reconcileAiHistory({ settlePending: true });
    } catch (_) {
      scheduleAiRecovery();
    }
    if (state.aiPendingRequest === submittedRequest) scheduleAiRecovery();
  }
}

async function reconcileAiHistory({ settlePending = false } = {}) {
  const session = state.aiSession;
  if (!session) return false;
  if (state.aiHistorySync) {
    state.aiHistorySyncQueued ||= settlePending;
    return state.aiHistorySync;
  }
  const sessionId = session.id;
  const sync = (async () => {
    const history = await request(`/api/v1/opencode/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (state.aiSession?.id !== sessionId) return false;
    renderChatHistory(history);
    const pending = state.aiPendingRequest;
    if (pending?.sessionId === sessionId) {
      pending.remoteAccepted ||= CarobaChatRecovery.hasRemoteUserMessage(state.aiMessages, pending);
    }
    const recovered = pending?.sessionId === sessionId
      && CarobaChatRecovery.hasRecoveredResponse(state.aiMessages, pending.baselineIds, pending.text);
    if (recovered) {
      finishAiRequest();
      return true;
    }
    const remoteResponsePending = state.aiMessages.some((message) => message.role === "assistant" && message.pending);
    if (pending?.sessionId === sessionId) {
      setAiResponding(true, settlePending
        ? "OpenCode concluiu; recuperando a resposta…"
        : "Aguardando a resposta do OpenCode…");
      if (settlePending) scheduleAiRecovery();
    } else {
      state.aiSessionBusy = remoteResponsePending;
      setAiResponding(remoteResponsePending, remoteResponsePending
        ? "OpenCode está respondendo…"
        : undefined);
    }
    return false;
  })();
  state.aiHistorySync = sync;
  try {
    return await sync;
  } finally {
    if (state.aiHistorySync === sync) state.aiHistorySync = null;
    if (state.aiHistorySyncQueued) {
      state.aiHistorySyncQueued = false;
      void reconcileAiHistory({ settlePending: true }).catch(() => scheduleAiRecovery());
    }
  }
}

function scheduleAiRecovery() {
  const pending = state.aiPendingRequest;
  if (!pending || state.aiRecoveryTimer) return;
  const delay = CarobaChatRecovery.recoveryDelay(pending.recoveryAttempts);
  if (delay === null) {
    if ((!pending.postSettled || pending.remoteAccepted)
        && CarobaChatRecovery.canContinueRecovery(pending.startedAt)) {
      pending.recoveryAttempts -= 1;
      scheduleAiRecovery();
      return;
    }
    const response = pending.postResponse;
    const text = Array.isArray(response?.parts)
      ? response.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
      : "";
    if (text) {
      state.aiMessages = CarobaChatRecovery.reconcileHistory([
        ...state.aiMessages,
        {
          id: response.info?.id || `post-${Date.now()}`,
          role: "assistant",
          text,
          pending: false,
          finish: response.info?.finish || null,
          error: null,
        },
      ]);
      finishAiRequest();
    } else {
      finishAiRequest(pending.postError?.message
        || "Não foi possível confirmar a resposta no histórico. A sessão será reconciliada novamente quando a conexão voltar.");
    }
    return;
  }
  pending.recoveryAttempts += 1;
  state.aiRecoveryTimer = window.setTimeout(async () => {
    state.aiRecoveryTimer = null;
    if (state.aiPendingRequest !== pending) return;
    try {
      const recovered = await reconcileAiHistory();
      if (!recovered && state.aiPendingRequest === pending) scheduleAiRecovery();
    } catch (_) {
      if (state.aiPendingRequest === pending) scheduleAiRecovery();
    }
  }, delay);
}

function finishAiRequest(error = null) {
  const pending = state.aiPendingRequest;
  if (state.aiRecoveryTimer) window.clearTimeout(state.aiRecoveryTimer);
  state.aiRecoveryTimer = null;
  state.aiPendingRequest = null;
  state.aiRequestPending = false;
  state.aiSessionBusy = false;
  state.aiHistorySyncQueued = false;
  state.aiChatError = error;
  state.aiFailedRequest = error ? pending : null;
  renderDisplayedChat();
  setAiResponding(false);
  if ($("page-ai").classList.contains("active") && !$("chat-prompt").disabled) $("chat-prompt").focus();
}

function resetAiRequestState() {
  if (state.aiRecoveryTimer) window.clearTimeout(state.aiRecoveryTimer);
  state.aiRecoveryTimer = null;
  state.aiPendingRequest = null;
  state.aiFailedRequest = null;
  state.aiRequestPending = false;
  state.aiSessionBusy = false;
  state.aiHistorySyncQueued = false;
}

function setAiResponding(active, message = "OpenCode está respondendo…") {
  if (!active && activePendingQuestion()) {
    active = true;
    message = "OpenCode aguarda sua resposta…";
  }
  state.aiResponding = active;
  $("ai-thinking").hidden = !active;
  $("ai-thinking-text").textContent = message;
  $("ai-status").textContent = active ? "Em atividade" : aiPhaseLabel(state.aiPhase);
  updateAiConversation();
}

function addChatMessage(kind, text, complete = true) {
  const item = document.createElement("div");
  item.className = `${kind}-message`;
  const author = document.createElement("span");
  author.textContent = kind === "user" ? (state.user ? state.user.username : "Você") : kind === "agent" ? "OpenCode" : kind === "error" ? "Falha na resposta" : "CarobaGuard";
  const content = document.createElement("p");
  content.textContent = text;
  item.append(author, content);
  if (kind === "agent" && complete && text.trim()) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-ai-response secondary";
    copy.textContent = "Copiar resposta";
    copy.addEventListener("click", async () => {
      copy.disabled = true;
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copiado";
        toast("Resposta copiada.");
      } catch (_) {
        copy.textContent = "Tentar copiar novamente";
        toast("O navegador não permitiu copiar. Você pode selecionar o texto da resposta.", true);
      } finally { copy.disabled = false; }
    });
    item.append(copy);
  }
  $("chat-messages").append(item);
}

function ensureAiEventStream() {
  if (state.aiStream) return;
  state.aiStream = new EventSource("/api/v1/opencode/events");
  state.aiStream.addEventListener("carobaguard.session.changed", () => {
    if (state.sessionRefreshTimer) window.clearTimeout(state.sessionRefreshTimer);
    state.sessionRefreshTimer = window.setTimeout(() => { state.sessionRefreshTimer = null; void loadSessionWorkspace(); }, 250);
  });
  state.aiStream.onopen = () => {
    if (!state.aiResponding) $("ai-status").textContent = aiPhaseLabel(state.aiPhase);
    if (CarobaChatRecovery.shouldReconcile("stream.open") && state.aiSession) {
      void reconcileAiHistory().catch(() => scheduleAiRecovery());
    }
    void refreshPendingQuestions();
    void loadSessionWorkspace();
  };
  state.aiStream.onerror = () => {
    if (state.aiPendingRequest) {
      setAiResponding(true, "Conexão interrompida; tentando recuperar a resposta…");
      scheduleAiRecovery();
    } else if (state.aiResponding) {
      $("ai-thinking-text").textContent = "Conexão interrompida; aguardando reconexão…";
    } else {
      $("ai-status").textContent = "Reconectando";
    }
  };
  state.aiStream.addEventListener("carobaguard.events.missed", () => {
    if (CarobaChatRecovery.shouldReconcile("events.missed") && state.aiSession) {
      void reconcileAiHistory({ settlePending: true }).catch(() => scheduleAiRecovery());
    }
    void refreshPendingQuestions();
    void loadSessionWorkspace();
  });
  const permissionHandler = (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || {};
      const id = details.id || details.requestID;
      if (id && !state.pendingPermissions.some((pending) => (pending.id || pending.requestID) === id)) {
        state.pendingPermissions.push(details);
      }
      renderPendingPermission();
    } catch (_) { /* ignore malformed events */ }
  };
  state.aiStream.addEventListener("permission.asked", permissionHandler);
  state.aiStream.addEventListener("permission.v2.asked", permissionHandler);
  const permissionResolvedHandler = (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      const id = details.requestID || details.id;
      state.pendingPermissions = state.pendingPermissions.filter((pending) => (pending.id || pending.requestID) !== id);
      renderPendingPermission();
    } catch (_) { /* ignore malformed events */ }
  };
  state.aiStream.addEventListener("permission.replied", permissionResolvedHandler);
  state.aiStream.addEventListener("permission.v2.replied", permissionResolvedHandler);
  const questionHandler = (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      if (details.id && !state.pendingQuestions.some((question) => question.id === details.id)) {
        state.pendingQuestions.push(details);
      }
      if (!state.aiSession) {
        state.aiSession = state.aiSessions.find((session) => session.opencode_session_id === details.sessionID) || null;
        renderAiSessions(state.aiSessions);
        updateAiConversation();
      }
      renderPendingQuestion();
    } catch (_) { /* ignore malformed events */ }
  };
  const questionResolvedHandler = (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      const id = details.id || details.requestID;
      state.pendingQuestions = state.pendingQuestions.filter((question) => question.id !== id);
      renderPendingQuestion();
    } catch (_) { /* ignore malformed events */ }
  };
  state.aiStream.addEventListener("question.asked", questionHandler);
  state.aiStream.addEventListener("question.v2.asked", questionHandler);
  state.aiStream.addEventListener("question.replied", questionResolvedHandler);
  state.aiStream.addEventListener("question.v2.replied", questionResolvedHandler);
  state.aiStream.addEventListener("question.rejected", questionResolvedHandler);
  state.aiStream.addEventListener("question.v2.rejected", questionResolvedHandler);
  state.aiStream.addEventListener("session.status", (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      const remoteId = details.sessionID || details.sessionId;
      if (!state.aiSession || remoteId !== state.aiSession.opencode_session_id) return;
      const status = details.status?.type || details.status || "";
      if (["busy", "retry"].includes(status)) {
        state.aiSessionBusy = true;
        setAiResponding(true, status === "retry" ? "OpenCode tentará novamente…" : "OpenCode está analisando…");
      } else if (CarobaChatRecovery.shouldReconcile("session.status", status)) {
        state.aiSessionBusy = false;
        setAiResponding(true, "OpenCode concluiu; sincronizando a resposta…");
        void reconcileAiHistory({ settlePending: true }).catch(() => scheduleAiRecovery());
      }
    } catch (_) { /* ignore malformed events */ }
  });
  state.aiStream.addEventListener("session.idle", (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      const remoteId = details.sessionID || details.sessionId;
      if (!state.aiSession || remoteId !== state.aiSession.opencode_session_id) return;
      if (CarobaChatRecovery.shouldReconcile("session.idle")) {
        state.aiSessionBusy = false;
        setAiResponding(true, "OpenCode concluiu; sincronizando a resposta…");
        void reconcileAiHistory({ settlePending: true }).catch(() => scheduleAiRecovery());
      }
    } catch (_) { /* ignore malformed events */ }
  });
  state.aiStream.addEventListener("message.updated", (event) => {
    try {
      const value = JSON.parse(event.data);
      const details = value.properties || value.data || {};
      const info = details.info || {};
      const remoteId = details.sessionID || info.sessionID;
      if (remoteId !== state.aiSession?.opencode_session_id) return;
      if (info.role === "assistant" && info.finish) {
        void reconcileAiHistory({ settlePending: true }).catch(() => scheduleAiRecovery());
      }
    } catch (_) { /* ignore malformed events */ }
  });
  state.aiStream.addEventListener("message.part.updated", (event) => {
    try {
      const value = JSON.parse(event.data);
      const part = value.properties?.part;
      if (!part || part.sessionID !== state.aiSession?.opencode_session_id) return;
      if (part.type === "tool" && ["pending", "running"].includes(part.state?.status)) {
        setAiResponding(true, `OpenCode está usando ${part.tool || "uma ferramenta"}…`);
        if (part.tool === "question") refreshPendingQuestions();
      } else if (part.type === "reasoning") {
        setAiResponding(true, "OpenCode está raciocinando…");
      }
    } catch (_) { /* ignore malformed events */ }
  });
}

function activePendingQuestion() {
  if (!state.aiSession) return null;
  return state.pendingQuestions.find((question) => question.sessionID === state.aiSession.opencode_session_id) || null;
}

async function refreshPendingQuestions() {
  if (state.questionRefreshPending) return;
  state.questionRefreshPending = true;
  try {
    state.pendingQuestions = await request("/api/v1/opencode/questions");
    renderPendingQuestion();
  } catch (_) { /* status polling will retry when the AI page opens again */ }
  finally { state.questionRefreshPending = false; }
}

function renderPendingQuestion() {
  const pending = activePendingQuestion();
  $("question-card").hidden = !pending;
  if (!pending) {
    $("question-fields").replaceChildren();
    $("submit-question").disabled = true;
    const remoteResponsePending = state.aiMessages.some((message) => message.role === "assistant" && message.pending);
    if (state.aiResponding && !state.aiRequestPending && !state.aiSessionBusy && !remoteResponsePending) {
      setAiResponding(false);
    }
    return;
  }
  $("question-count").textContent = `${pending.questions.length} pergunta${pending.questions.length === 1 ? "" : "s"}`;
  const fields = pending.questions.map((question, index) => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "question-field";
    fieldset.dataset.questionIndex = String(index);
    const legend = document.createElement("legend");
    legend.textContent = question.header || `Pergunta ${index + 1}`;
    const prompt = document.createElement("p");
    prompt.textContent = question.question;
    fieldset.append(legend, prompt);
    question.options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "question-option";
      const input = document.createElement("input");
      input.type = question.multiple ? "checkbox" : "radio";
      input.name = `question-${index}`;
      input.value = option.label;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = option.label;
      const description = document.createElement("small");
      description.textContent = option.description;
      copy.append(title, description);
      label.append(input, copy);
      fieldset.append(label);
    });
    if (question.custom) {
      const custom = document.createElement("input");
      custom.className = "question-custom";
      custom.dataset.customAnswer = "true";
      custom.maxLength = 4096;
      custom.placeholder = "Outra resposta (opcional)";
      fieldset.append(custom);
    }
    return fieldset;
  });
  $("question-fields").replaceChildren(...fields);
  updateQuestionSubmitState();
  setAiResponding(true, "OpenCode aguarda sua resposta…");
}

function updateQuestionSubmitState() {
  const fields = Array.from($("question-fields").querySelectorAll(".question-field"));
  const complete = fields.length > 0 && fields.every((field) => {
    const selected = field.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
    const custom = field.querySelector("[data-custom-answer]")?.value.trim();
    return Boolean(selected || custom);
  });
  $("submit-question").disabled = !complete;
  $("question-hint").textContent = complete
    ? "Resposta pronta para enviar."
    : "Selecione uma opção para continuar.";
}

function collectQuestionAnswers() {
  return Array.from($("question-fields").querySelectorAll(".question-field")).map((field) => {
    const selected = Array.from(field.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked'))
      .map((input) => input.value);
    const custom = field.querySelector("[data-custom-answer]")?.value.trim() || "";
    if (custom) {
      if (field.querySelector('input[type="checkbox"]')) selected.push(custom);
      else return [custom];
    }
    if (!selected.length) throw new Error("Responda todas as perguntas antes de continuar.");
    return selected;
  });
}

async function answerQuestion(reject) {
  const pending = activePendingQuestion();
  if (!pending) return;
  let answers = [];
  try {
    if (!reject) answers = collectQuestionAnswers();
    $("question-card").querySelectorAll("button, input").forEach((element) => { element.disabled = true; });
    await request(`/api/v1/opencode/questions/${encodeURIComponent(pending.id)}`, {
      method: "POST",
      body: JSON.stringify({ answers, reject }),
    });
    state.pendingQuestions = state.pendingQuestions.filter((question) => question.id !== pending.id);
    renderPendingQuestion();
    state.aiSessionBusy = true;
    setAiResponding(true, reject ? "Pergunta cancelada; aguardando OpenCode…" : "Resposta enviada; OpenCode retomou o trabalho…");
    toast(reject ? "Pergunta do OpenCode cancelada." : "Resposta enviada ao OpenCode.");
  } catch (error) {
    toast(error.message, true);
    renderPendingQuestion();
  }
}

function activePendingPermission() {
  return state.pendingPermissions.find((pending) => pending.sessionID && pending.sessionID === state.aiSession?.opencode_session_id);
}

function renderPendingPermission() {
  const details = activePendingPermission();
  if (!details) {
    $("approval-card").hidden = true;
    return;
  }
  $("approval-title").textContent = `Autorizar ${details.permission || details.action || "uso de ferramenta"}?`;
  $("approval-details").textContent = JSON.stringify({
    pedidosNestaSessao: state.pendingPermissions.filter((pending) => pending.sessionID === details.sessionID).length,
    acao: details.permission || details.action,
    diretorio: details.directory || state.aiSession?.project_path,
    ferramenta: details.tool,
    contexto: details.reason || details.context,
    patterns: details.patterns,
    resources: details.resources,
    metadata: details.metadata,
  }, null, 2);
  $("approval-card").hidden = false;
  $("approve-permission").disabled = state.aiPermissionPending || !canOperateAi() || state.aiSession?.permission_mode !== "approval";
  $("approve-session-permission").disabled = state.aiPermissionPending || !canOperateAi() || state.aiSession?.permission_mode !== "approval";
  $("reject-permission").disabled = state.aiPermissionPending || !canOperateAi();
  $("approve-permission").textContent = state.aiPermissionPending ? "Enviando decisão…" : "Autorizar uma vez";
}

function clearPendingPermissions() {
  state.pendingPermissions = [];
  $("approval-card").hidden = true;
}

async function answerPermission(reply) {
  const pending = activePendingPermission();
  const id = pending && (pending.id || pending.requestID);
  if (!id || state.aiPermissionPending || !canOperateAi() || (reply !== "reject" && state.aiSession?.permission_mode !== "approval")) return;
  state.aiPermissionPending = true;
  renderPendingPermission();
  try {
    await request(`/api/v1/opencode/permissions/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ reply, message: null, session_id: state.aiSession.id }),
    });
    state.pendingPermissions = state.pendingPermissions.filter((item) => (item.id || item.requestID) !== id);
    renderPendingPermission();
    toast(reply === "reject" ? "Ação rejeitada." : reply === "always" ? "Ação autorizada enquanto esta sessão estiver ativa." : "Ação autorizada uma vez.");
  } catch (error) { setAiError(`Não foi possível enviar a decisão. ${error.message}`); }
  finally { state.aiPermissionPending = false; renderPendingPermission(); }
}

function titleCase(value) { return String(value || "").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()); }
function aiPhaseLabel(phase) { return ({ sleeping: "Em repouso", starting: "Iniciando", ready: "Pronto", error: "Erro" })[phase] || "Verificando"; }
function modeLabel(mode) { return ({ read_only: "Read-Only", approval: "Approval", unrestricted: "Unrestricted" })[mode] || "Modo desconhecido"; }

$("refresh-docker").addEventListener("click", loadDocker);
$("refresh-services").addEventListener("click", loadServices);
$("refresh-log-sources").addEventListener("click", loadLogs);
$("start-log-stream").addEventListener("click", startLogStream);
$("pause-log-stream").addEventListener("click", toggleLogPause);
$("clear-stream-logs").addEventListener("click", clearStreamLogs);
$("export-stream-logs").addEventListener("click", exportStreamLogs);
$("stream-log-source").addEventListener("change", () => {
  stopLogStream(false);
  clearStreamLogs();
  renderLogTargets();
});
$("stream-log-target").addEventListener("change", () => {
  stopLogStream(false);
  clearStreamLogs();
});
$("stream-log-filter").addEventListener("input", renderStreamLogs);
$("stream-log-level").addEventListener("change", renderStreamLogs);
$("refresh-audit").addEventListener("click", loadAudit);
$("project-form").addEventListener("submit", registerProject);
$("run-doctor").addEventListener("click", loadDoctor);
$("doctor-ai").addEventListener("click", () => openAiFor("doctor", "latest", "Server Doctor"));
$("start-ai").addEventListener("click", startAi);
$("wake-ai").addEventListener("click", wakeAi);
$("stop-ai").addEventListener("click", stopAi);
$("new-ai-session").addEventListener("click", () => { createAiSession().catch(() => {}); });
$("cancel-ai-setup").addEventListener("click", () => { setAiSetup(false); $("start-ai").focus(); });
$("retry-ai").addEventListener("click", loadAi);
$("refresh-ai-history").addEventListener("click", refreshAiHistory);
$("restore-ai-prompt").addEventListener("click", restoreAiPrompt);
try {
  $("ai-show-unrestricted-warning").checked = localStorage.getItem("carobaguard.showUnrestrictedWarning") !== "false";
} catch (_) { /* Keep the visible default when browser storage is unavailable. */ }
$("ai-show-unrestricted-warning").addEventListener("change", (event) => {
  renderUnrestrictedWarning();
  try {
    localStorage.setItem("carobaguard.showUnrestrictedWarning", String(event.target.checked));
    toast("Preferência de aviso salva neste navegador.");
  } catch (_) { toast("Preferência aplicada nesta página; o navegador não permitiu salvá-la.", true); }
});
$("ai-unrestricted-auto-confirm").addEventListener("change", (event) => {
  if (state.user?.role !== "admin") { event.target.checked = false; return; }
  state.unrestrictedAutoConfirm = event.target.checked;
  try {
    localStorage.setItem(`carobaguard.unrestrictedAutoConfirm.${state.user.id}`, String(state.unrestrictedAutoConfirm));
    toast(state.unrestrictedAutoConfirm ? "Confirmação automática ativada neste navegador." : "Confirmação manual ativada.");
  } catch (_) { toast("Preferência aplicada nesta página; o navegador não permitiu salvá-la.", true); }
});
$("ai-session-search").addEventListener("input", () => renderAiSessions(state.aiSessions));
$("chat-prompt").addEventListener("input", updateAiConversation);
$("chat-prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("page-ai").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || state.aiCreating) return;
  if (!$("ai-setup").hidden) { setAiSetup(false); $("start-ai").focus(); }
  else if (!$("ai-session-drawer").hidden) setAiSessionsDrawer(false);
});
$("close-ai-sessions").addEventListener("click", () => setAiSessionsDrawer(false));
$("chat-form").addEventListener("submit", sendChat);
$("question-card").addEventListener("submit", (event) => {
  event.preventDefault();
  answerQuestion(false);
});
$("question-fields").addEventListener("change", updateQuestionSubmitState);
$("question-fields").addEventListener("input", updateQuestionSubmitState);
$("reject-question").addEventListener("click", () => answerQuestion(true));
$("approve-permission").addEventListener("click", () => answerPermission("once"));
$("approve-session-permission").addEventListener("click", () => answerPermission("always"));
$("reject-permission").addEventListener("click", () => answerPermission("reject"));
$("service-filter").addEventListener("input", renderServices);
$("close-logs").addEventListener("click", () => $("log-dialog").close());
$("copy-logs").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("log-output").textContent); toast("Logs copiados."); }
  catch (_) { toast("O navegador bloqueou a cópia.", true); }
});

window.addEventListener("resize", drawHistory);

async function loadSessionWorkspace() {
  const id = state.aiSession?.id;
  if (!id || state.sessionWorkspaceLoading) return;
  state.sessionWorkspaceLoading = true;
  try {
    const details = await request(`/api/v1/opencode/sessions/${encodeURIComponent(id)}`);
    if (state.aiSession?.id !== id) return;
    state.aiSession = details.session;
    const index = state.aiSessions.findIndex((session) => session.id === id);
    if (index >= 0) state.aiSessions[index] = details.session;
    $("session-workspace-status").textContent = `${details.session.status} · PID ${details.session.pid || "—"} · ${details.session.project_path}${details.session.error ? ` · ${details.session.error}` : ""}`;
    if (document.activeElement !== $("session-name")) $("session-name").value = details.session.title;
    $("session-git").textContent = JSON.stringify(details.git, null, 2);
    $("session-output").textContent = details.output || "Sem output registrado.";
    const entries = details.timeline.map((event) => {
      const li = document.createElement("li");
      li.textContent = `${new Date(event.created_at * 1000).toLocaleString()} · ${event.action} · ${event.result}${event.command ? ` · ${event.command}` : ""}`;
      return li;
    });
    $("session-timeline").replaceChildren(...entries);
    state.pendingPermissions = state.pendingPermissions.filter((pending) => pending.sessionID !== details.session.opencode_session_id).concat(details.pending_permissions);
    renderPendingPermission();
    renderAiSessions(state.aiSessions);
    updateAiConversation();
  } catch (error) { setAiError(`Falha ao consultar workspace. ${error.message}`); }
  finally { state.sessionWorkspaceLoading = false; }
}

async function sessionOperation(action, title = null, target = null) {
  const session = target || state.aiSession;
  if (!session || state.sessionOperationPending || !canOperateAi()) return;
  if (session.permission_mode === "unrestricted" && state.user?.role !== "admin") return;
  if (["delete", "archive", "stop"].includes(action)) {
    const question = action === "delete"
      ? `Excluir a sessão "${session.title}"? Se estiver ativa, ela será parada antes. Os arquivos do projeto, o histórico nativo do OpenCode e o Audit Log serão preservados.`
      : `${action === "stop" ? "Parar" : "Arquivar"} a sessão "${session.title}"? O Audit Log e os arquivos do workspace serão preservados.`;
    if (!window.confirm(question)) return;
  }
  state.sessionOperationPending = true;
  state.sessionPendingAction = action;
  setAiError();
  updateAiConversation();
  try {
    if (action === "delete") {
      if (["ready", "starting", "stopping"].includes(session.status)) {
        await request(`/api/v1/opencode/sessions/${encodeURIComponent(session.id)}/actions`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
      }
      await request(`/api/v1/opencode/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      state.aiDrafts.delete(session.id);
      if (state.aiSession?.id === session.id) {
        state.aiSession = null;
        clearChatMessages();
        $("session-workspace-status").textContent = "Sessão excluída. Histórico nativo do OpenCode preservado.";
        $("session-git").textContent = "";
        $("session-output").textContent = "";
        $("session-timeline").replaceChildren();
      }
    } else {
      const confirmation = action === "resume" ? await confirmationFor(session.permission_mode) : null;
      const updated = await request(`/api/v1/opencode/sessions/${encodeURIComponent(session.id)}/actions`, { method: "POST", body: JSON.stringify({ action, title, confirmation }) });
      if (state.aiSession?.id === session.id) state.aiSession = updated;
      if (["sleep", "stop", "archive"].includes(action)) { resetAiRequestState(); setAiResponding(false); }
      if (state.aiSession?.id === session.id) {
        await loadSessionWorkspace();
        await reconcileAiHistory();
      }
    }
    renderAiSessions(await request("/api/v1/opencode/sessions"));
    renderAiStatus(await request("/api/v1/opencode/status"));
    updateAiConversation();
    if (action === "resume") toast("OpenCode acordado para esta conversa.");
  } catch (error) { setAiError(`Não foi possível executar ${action}. ${error.message}`); }
  finally { state.sessionOperationPending = false; state.sessionPendingAction = null; updateAiConversation(); }
}

for (const action of ["sleep", "stop", "archive", "delete"]) {
  $(`session-${action}`).addEventListener("click", () => { void sessionOperation(action); });
}
$("session-refresh").addEventListener("click", () => { void loadSessionWorkspace(); });
$("session-rename-form").addEventListener("submit", (event) => { event.preventDefault(); void sessionOperation("rename", $("session-name").value); });

boot();
