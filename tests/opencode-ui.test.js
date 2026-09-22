"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise the actual client state transitions without a browser dependency.
// Layout, focus order and responsive behavior are verified separately in Chromium.
function client(storedPreference = null) {
  class Element {
    constructor() {
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = "";
      this.textContent = "";
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.children = [];
      this.classList = { contains: () => true };
      this.scrollTop = this.scrollHeight = this.clientHeight = 0;
    }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { document.activeElement = this; }
    querySelector() { return elements.submit; }
    querySelectorAll() { return []; }
  }
  const elements = {};
  const document = {
    getElementById(id) { return elements[id] ||= new Element(); },
    createElement() { return new Element(); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      return radios.find((radio) => selector.includes(radio.value)) || radios.find((radio) => radio.checked);
    },
  };
  elements.submit = new Element();
  const radios = ["read_only", "approval", "unrestricted"].map((value) => Object.assign(new Element(), { name: "ai-mode", value, checked: value === "read_only" }));
  document.getElementById("ai-setup").querySelectorAll = () => radios;
  document.getElementById("ai-setup").hidden = true;
  document.getElementById("ai-session-drawer").hidden = true;
  const storage = new Map([["carobaguard.showUnrestrictedWarning", storedPreference]]);
  const context = vm.createContext({
    document, TextEncoder, Headers, console,
    CarobaChatRecovery: require("../web/chat-recovery.js"),
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { addEventListener() {}, setTimeout() {}, clearTimeout() {}, confirm: () => true },
  });
  const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  vm.runInContext(source.replace(/boot\(\);\s*$/, ""), context);
  vm.runInContext('toast = () => {}; state.user = { role: "admin", username: "admin" }; state.aiInstalled = true;', context);
  return { run: (code) => vm.runInContext(code, context), elements, storage, radios };
}

test("warning preference persists, hides only the banner and preserves the mode", () => {
  const { run, elements, storage } = client("false");
  run('state.aiMode = "unrestricted"; state.aiPhase = "ready"; state.aiSession = { id: "s1", permission_mode: "unrestricted" }; updateAiConversation(); renderUnrestrictedWarning();');
  assert.equal(elements["unrestricted-warning"].hidden, true);
  assert.equal(elements["ai-mode-badge"].textContent, "Unrestricted");
  elements["ai-show-unrestricted-warning"].checked = true;
  elements["ai-show-unrestricted-warning"].listeners.change({ target: elements["ai-show-unrestricted-warning"] });
  assert.equal(elements["unrestricted-warning"].hidden, false);
  assert.equal(storage.get("carobaguard.showUnrestrictedWarning"), "true");
  run('state.aiPhase = "sleeping"; renderUnrestrictedWarning();');
  assert.equal(elements["unrestricted-warning"].hidden, true);
});

test("status refresh does not overwrite the project being configured", () => {
  const { run, elements } = client();
  elements["ai-setup"].hidden = false;
  run('$("ai-project").value = "/srv/new-project"; renderAiStatus({ installed: true, phase: "ready", permission_mode: "read_only", project_path: "/srv/old-project", memory_bytes: 0, idle_timeout_seconds: 300 });');
  assert.equal(elements["ai-project"].value, "/srv/new-project");
});

test("permissions from another session cannot be shown or approved", async () => {
  const { run, elements } = client();
  run('state.aiSession = { id: "a", opencode_session_id: "remote-a", permission_mode: "approval" }; state.pendingPermissions = [{ id: "per_b", sessionID: "remote-b" }]; request = () => { throw new Error("must not send"); }; renderPendingPermission();');
  assert.equal(elements["approval-card"].hidden, true);
  await run('answerPermission("once")');
});

test("approval reply removes the exact request even when SSE resolves it during POST", async () => {
  const { run } = client();
  run('state.aiSession = { opencode_session_id: "a", permission_mode: "approval" }; state.pendingPermissions = [{ id: "per_a", sessionID: "a" }, { id: "per_b", sessionID: "b" }]; request = async () => { state.pendingPermissions.shift(); return {}; };');
  await run('answerPermission("once")');
  assert.equal(run('state.pendingPermissions[0].id'), "per_b");
  assert.equal(run('state.aiPermissionPending'), false);
});

test("read-only never enables an approval button for an unexpected permission event", () => {
  const { run, elements } = client();
  run('state.aiSession = { opencode_session_id: "a", permission_mode: "read_only" }; state.pendingPermissions = [{ id: "per_a", sessionID: "a" }]; renderPendingPermission();');
  assert.equal(elements["approve-permission"].disabled, true);
  assert.equal(elements["reject-permission"].disabled, false);
});

test("roles and UTF-8 limits gate the composer; the backend authorizes unrestricted resumption", () => {
  const { run, elements, radios } = client();
  run('state.user.role = "viewer"; updateAiConversation();');
  assert.equal(elements["start-ai"].disabled, true);
  assert.equal(radios[2].disabled, true);
  run('state.user.role = "operator"; state.aiSession = { permission_mode: "unrestricted" }; updateAiConversation();');
  assert.equal(elements["chat-prompt"].disabled, true);
  run('state.user.role = "admin"; updateAiConversation();');
  assert.equal(elements["chat-prompt"].disabled, false);
  run('state.aiSession.permission_mode = "read_only"; $("chat-prompt").value = "a"; updateAiConversation();');
  assert.equal(elements.submit.disabled, false);
  run('$("chat-prompt").value = "😀".repeat(8001); updateAiConversation();');
  assert.equal(elements.submit.disabled, true);
});

test("session creation locks configuration and prevents duplicate POSTs", async () => {
  const { run, elements, radios } = client();
  run('updateAiConversation(); globalThis.posts = 0; request = () => { posts++; return new Promise((resolve) => { globalThis.finish = resolve; }); };');
  const creation = run('createAiSession()');
  await Promise.resolve();
  assert.equal(elements["new-ai-session"].disabled, true);
  assert.equal(elements["cancel-ai-setup"].disabled, true);
  assert.ok(radios.every((radio) => radio.disabled));
  await run('createAiSession()');
  assert.equal(run('posts'), 1);
  run('request = async (url) => url.endsWith("sessions") ? [] : ({ installed: true, phase: "ready", permission_mode: "read_only", memory_bytes: 0 }); finish({ id: "a", project_path: "/srv", permission_mode: "read_only" });');
  await creation;
  assert.equal(run('state.aiCreating'), false);
});

for (const outcome of ["resolve", "reject"]) {
  test(`late POST ${outcome} cannot modify a newer request in the same session`, async () => {
    const { run } = client();
    run('state.aiSession = { id: "a", permission_mode: "read_only" }; $("chat-prompt").value = "primeiro pedido"; updateAiConversation(); request = () => new Promise((resolve, reject) => { globalThis.resolvePost = resolve; globalThis.rejectPost = reject; });');
    const post = run('sendChat({ preventDefault() {} })');
    run('resetAiRequestState(); state.aiPendingRequest = { sessionId: "a", text: "outro pedido", postSettled: false };');
    run(outcome === "resolve" ? 'resolvePost({ parts: [] })' : 'rejectPost(new Error("resposta atrasada"))');
    await post;
    assert.equal(run('state.aiPendingRequest.postSettled'), false);
    assert.equal(run('state.aiPendingRequest.text'), "outro pedido");
  });
}

test("restoring a failed prompt never sends and preserves an existing draft", () => {
  const { run, elements } = client();
  run('state.aiSession = { id: "a", permission_mode: "read_only" }; state.aiFailedRequest = { sessionId: "a", text: "mensagem original" }; state.aiChatError = "falha"; request = () => { throw new Error("must not send"); }; $("chat-prompt").value = "rascunho atual"; updateAiConversation(); restoreAiPrompt();');
  assert.equal(elements["chat-prompt"].value, "rascunho atual");
  run('$("chat-prompt").value = ""; updateAiConversation(); restoreAiPrompt();');
  assert.equal(elements["chat-prompt"].value, "mensagem original");
  assert.equal(run('state.aiDrafts.get("a")'), "mensagem original");
});

test("manual recovery reads history without reposting a failed message", async () => {
  const { run, elements } = client();
  run('state.aiSession = { id: "a", permission_mode: "read_only" }; state.aiFailedRequest = { sessionId: "a", text: "pedido", baselineIds: [] }; state.aiChatError = "resposta perdida"; request = async (url, options) => { if (options?.method === "POST") throw new Error("must not resend"); if (url.endsWith("status")) return { phase: "ready", installed: true, permission_mode: "read_only", memory_bytes: 0 }; return [{ id: "u", role: "user", text: "pedido" }, { id: "a", role: "assistant", text: "resposta recuperada" }]; }; updateAiConversation();');
  await run('refreshAiHistory()');
  assert.equal(run('state.aiChatError'), null);
  assert.equal(elements["ai-chat-recovery"].hidden, true);
  assert.match(elements["ai-history-status"].textContent, /Nenhuma mensagem foi reenviada/);
});

test("session approval includes the local session ID and offers a temporary grant", async () => {
  const { run, elements } = client();
  run('state.aiSession = { id: "local-a", opencode_session_id: "remote-a", permission_mode: "approval" }; state.pendingPermissions = [{ id: "per_a", sessionID: "remote-a" }]; globalThis.sent = null; request = async (path, options) => { sent = JSON.parse(options.body); return {}; }; renderPendingPermission();');
  assert.equal(elements["approve-session-permission"].disabled, false);
  await run('answerPermission("always")');
  assert.equal(run('sent.session_id'), "local-a");
  assert.equal(run('sent.reply'), "always");
});

test("archived sessions keep history but disable sending", () => {
  const { run, elements } = client();
  run('state.aiSession = { id: "archived", status: "archived", permission_mode: "read_only" }; $("chat-prompt").value = "do work"; updateAiConversation();');
  assert.equal(elements["chat-prompt"].disabled, true);
  assert.equal(elements.submit.disabled, true);
});

test("late workspace detail response cannot replace another selected session", async () => {
  const { run } = client();
  run('state.aiSession = { id: "a" }; request = async () => { state.aiSession = { id: "b" }; return { session: { id: "a" } }; };');
  await run('loadSessionWorkspace()');
  assert.equal(run('state.aiSession.id'), "b");
  assert.equal(run('state.sessionWorkspaceLoading'), false);
});
