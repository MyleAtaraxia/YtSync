const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

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
    $("tabText").textContent = state.boundTabId != null ? `#${state.boundTabId}` : "none";
    const toggle = $("publicControlToggle");
    toggle.checked = Boolean(state.publicPlaybackControl);
    toggle.disabled = state.role !== "host";
  }

  showError(state.error);
}

async function send(msg) {
  showError("");
  const res = await api.runtime.sendMessage(msg);
  if (!res?.ok) {
    showError(res?.error || "Request failed");
    return null;
  }
  return res;
}

async function ensureServerPermission(rawUrl) {
  let origin;
  try {
    origin = new URL((rawUrl || "https://ytsync.ataraxia.ws").trim()).origin;
  } catch {
    showError("Invalid server URL");
    return false;
  }
  if (/^(https:\/\/ytsync\.ataraxia\.ws|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(origin)) return true;
  if (!api.permissions?.request) return true;
  const pattern = `${origin}/*`;
  if (await api.permissions.contains({ origins: [pattern] })) return true;
  const granted = await api.permissions.request({ origins: [pattern] });
  if (!granted) showError(`Permission required to connect to ${origin}`);
  return granted;
}

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

$("copyRoomBtn").addEventListener("click", async () => {
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

api.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE_UPDATE" && msg.state) {
    render(msg.state);
  }
});

send({ type: "GET_UI_STATE" }).then((res) => res && render(res));
