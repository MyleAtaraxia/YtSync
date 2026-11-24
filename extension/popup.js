const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const isEmbedded = window.parent !== window;
const isFirefox = api.runtime?.getURL?.("").startsWith("moz-extension:");
const serverPermissionPattern = (parsed) =>
  isFirefox ? `${parsed.protocol}//${parsed.hostname}/*` : `${parsed.origin}/*`;
let activeTabId = null;
let uiPort = null;

function closeWindow() {
  if (isEmbedded) {
    window.parent.postMessage({ type: "YTSYNC_CLOSE" }, "*");
  } else {
    window.close();
  }
}

function syncFrameSize() {
  if (!isEmbedded) return;
  const rect = document.body.getBoundingClientRect();
  window.parent.postMessage({ type: "YTSYNC_RESIZE", height: rect.height }, "*");
}

$("closeBtn")?.addEventListener("click", closeWindow);

function initGrantMode(rawOrigin) {
  let grantOrigin;
  let grantPattern;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    grantOrigin = parsed.origin;
    grantPattern = serverPermissionPattern(parsed);
  } catch {
    return false;
  }

  const area = document.querySelector(".client-area");
  if (!area) return false;

  const section = document.createElement("div");
  section.className = "section";
  const text = document.createElement("div");
  text.className = "meta";
  text.textContent = `Allow YtSync to connect to ${grantOrigin}?`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "primary";
  btn.textContent = "Allow server";
  const err = document.createElement("div");
  err.className = "error hidden";

  btn.addEventListener("click", async () => {
    err.classList.add("hidden");
    const granted = await api.permissions?.request?.({ origins: [grantPattern] });
    if (granted) {
      window.close();
    } else {
      err.textContent = `Permission denied for ${grantOrigin}`;
      err.classList.remove("hidden");
    }
  });

  section.append(text, btn);
  area.replaceChildren(section, err);
  return true;
}

const grantParam = !isEmbedded ? new URLSearchParams(location.search).get("grant") : null;
const inGrantMode = grantParam ? initGrantMode(grantParam) : false;

if (!inGrantMode) {
  if (isEmbedded) {
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeWindow();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".aero-window")) closeWindow();
    });

    const titlebar = document.querySelector(".titlebar");
    if (titlebar) {
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      titlebar.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("#closeBtn")) return;
        dragging = true;
        lastX = e.screenX;
        lastY = e.screenY;
        titlebar.setPointerCapture(e.pointerId);
      });
      titlebar.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const dx = e.screenX - lastX;
        const dy = e.screenY - lastY;
        if (!dx && !dy) return;
        lastX = e.screenX;
        lastY = e.screenY;
        window.parent.postMessage({ type: "YTSYNC_DRAG", dx, dy }, "*");
      });
      const endDrag = () => {
        dragging = false;
      };
      titlebar.addEventListener("pointerup", endDrag);
      titlebar.addEventListener("pointercancel", endDrag);
    }

    new ResizeObserver(syncFrameSize).observe(document.body);
    requestAnimationFrame(syncFrameSize);
  }
}

function showError(msg) {
  const el = $("error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function render(state) {
  if (state.serverUrl && !$("serverUrl").value) $("serverUrl").value = state.serverUrl;
  if (state.displayName && !$("displayName").value) $("displayName").value = state.displayName;

  const inRoom = Boolean(state.roomId);
  $("lobbyView").classList.toggle("hidden", inRoom);
  $("roomView").classList.toggle("hidden", !inRoom);

  if (inRoom) {
    $("statusText").textContent = state.status;
    $("roleText").textContent = state.role || "pending";
    $("roomIdText").textContent = state.roomId;
    $("rebindBtn").classList.toggle("hidden", state.boundTabId != null && state.boundTabId === activeTabId);
    const entries = Object.entries(state.members || {});
    $("memberCount").textContent = String(entries.length);
    $("memberList").replaceChildren(
      ...entries.map(([id, name]) => {
        const li = document.createElement("li");
        li.textContent = id === state.hostId ? `${name} (host)` : name;
        return li;
      })
    );
    const toggle = $("publicControlToggle");
    toggle.checked = Boolean(state.publicPlaybackControl);
    toggle.disabled = state.role !== "host";
  }

  showError(state.error);
}

function connectUiPort() {
  if (uiPort || !api.runtime.connect) return;
  try {
    uiPort = api.runtime.connect({ name: "ytsync-ui" });
    uiPort.onMessage.addListener((msg) => {
      if (msg?.type === "STATE_UPDATE" && msg.state) {
        render(msg.state);
      }
    });
    uiPort.onDisconnect.addListener(() => {
      uiPort = null;
      if (api.runtime?.id) {
        setTimeout(() => {
          if (!uiPort && api.runtime?.id) connectUiPort();
        }, 1000);
      }
    });
  } catch {
    uiPort = null;
  }
}

async function send(msg) {
  showError("");
  connectUiPort();
  const res = await api.runtime.sendMessage(msg);
  if (!res?.ok) {
    showError(res?.error || "Request failed");
    return null;
  }
  return res;
}

async function ensureServerPermission(rawUrl) {
  let parsed;
  try {
    parsed = new URL((rawUrl || "https://ytsync.ataraxia.ws").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    showError("Invalid server URL");
    return false;
  }
  const { origin } = parsed;
  if (/^(https:\/\/ytsync\.ataraxia\.ws|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(origin)) return true;
  const pattern = serverPermissionPattern(parsed);
  if (api.permissions?.request && api.permissions?.contains) {
    if (await api.permissions.contains({ origins: [pattern] })) return true;
    const granted = await api.permissions.request({ origins: [pattern] });
    if (!granted) showError(`Permission required to connect to ${origin}`);
    return granted;
  }
  const check = await send({ type: "CHECK_SERVER_PERMISSION", origin });
  if (check?.granted) return true;
  await send({ type: "OPEN_PERMISSION_TAB", origin });
  showError(`Approve access to ${origin} in the opened tab, then try again`);
  return false;
}

if (!inGrantMode) {
  $("checkRoomBtn").addEventListener("click", async () => {
    if (!(await ensureServerPermission($("serverUrl").value))) return;
    const roomId = $("joinRoomId").value.trim();
    const res = await send({
      type: "CHECK_ROOM",
      serverUrl: $("serverUrl").value,
      roomId,
    });
    if (!res?.room) return;
    const info = $("roomInfo");
    info.textContent = `${res.room.memberCount} watching${res.room.publicPlaybackControl ? " · Public control" : ""}`;
    info.classList.remove("hidden");
  });

  $("createBtn").addEventListener("click", async () => {
    if (!(await ensureServerPermission($("serverUrl").value))) return;
    const res = await send({
      type: "CREATE_ROOM",
      serverUrl: $("serverUrl").value,
      displayName: $("displayName").value,
      publicPlaybackControl: $("createPublicControl").checked,
    });
    if (res) render(res);
  });

  $("publicControlToggle").addEventListener("change", async () => {
    const res = await send({
      type: "SET_PUBLIC_CONTROL",
      publicPlaybackControl: $("publicControlToggle").checked,
    });
    if (res) render(res);
  });

  $("joinBtn").addEventListener("click", async () => {
    if (!(await ensureServerPermission($("serverUrl").value))) return;
    const res = await send({
      type: "JOIN_ROOM",
      serverUrl: $("serverUrl").value,
      displayName: $("displayName").value,
      roomId: $("joinRoomId").value,
    });
    if (res) render(res);
  });

  $("roomIdText").addEventListener("click", async () => {
    const code = $("roomIdText").textContent;
    if (code) await navigator.clipboard.writeText(code);
  });

  $("rebindBtn").addEventListener("click", async () => {
    const res = await send({ type: "BIND_ACTIVE_TAB" });
    if (res) render(res);
  });

  $("leaveBtn").addEventListener("click", async () => {
    const res = await send({ type: "LEAVE_ROOM" });
    if (res) render(res);
  });

  for (const id of ["serverUrl", "displayName"]) {
    $(id).addEventListener("change", () => {
      send({
        type: "SAVE_SETTINGS",
        serverUrl: $("serverUrl").value,
        displayName: $("displayName").value,
      });
    });
  }

  connectUiPort();
  send({ type: "GET_UI_STATE" }).then((res) => {
    if (!res) return;
    if (res.tabId != null) activeTabId = res.tabId;
    render(res);
  });
}
