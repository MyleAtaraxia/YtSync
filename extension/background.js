import {
  DEFAULT_SERVER_URL,
  claimTicket,
  createRoom,
  decodeServerMessage,
  encodeAuth,
  encodeCommand,
  encodePing,
  encodeSetPublicControl,
  getRoomInfo,
  normalizeServerUrl,
  roomWsUrl,
} from "./protocol.js";

const api = globalThis.browser ?? globalThis.chrome;
const sessionStore = api.storage.session ?? api.storage.local;
const PING_INTERVAL_MS = 20_000;
const FATAL_ERROR_CODES = new Set(["invalid_ticket", "ticket_expired", "room_not_found"]);

const state = {
  status: "idle",
  roomId: null,
  role: null,
  publicPlaybackControl: false,
  boundTabId: null,
  ticket: null,
  serverUrl: DEFAULT_SERVER_URL,
  displayName: "",
  snapshot: null,
  clockOffsetMs: 0,
  error: null,
};

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let manualClose = false;
let pendingVideoId = null;
let deferredSnapshot = null;
let syncNavVideoId = null;

function canControl() {
  return state.role === "host" || (state.role === "follower" && state.publicPlaybackControl);
}

function shouldApplySnapshot() {
  return state.role === "follower" || (state.role === "host" && state.publicPlaybackControl);
}

async function persistSession() {
  await sessionStore.set({
    ytsyncSession: state.roomId
      ? {
          roomId: state.roomId,
          role: state.role,
          publicPlaybackControl: state.publicPlaybackControl,
          boundTabId: state.boundTabId,
          ticket: state.ticket,
          serverUrl: state.serverUrl,
        }
      : null,
  });
}

function publicState() {
  return {
    status: state.status,
    roomId: state.roomId,
    role: state.role,
    publicPlaybackControl: state.publicPlaybackControl,
    boundTabId: state.boundTabId,
    serverUrl: state.serverUrl,
    displayName: state.displayName,
    snapshot: state.snapshot,
    error: state.error,
  };
}

function updateBadge() {
  const action = api.action;
  if (!action?.setBadgeText) return;
  if (state.status === "connected") {
    action.setBadgeText({ text: "ON" });
    action.setBadgeBackgroundColor?.({ color: "#1a7f37" });
  } else if (state.status === "reconnecting" || state.status === "connecting") {
    action.setBadgeText({ text: "..." });
    action.setBadgeBackgroundColor?.({ color: "#9a6700" });
  } else if (state.status === "error") {
    action.setBadgeText({ text: "ERR" });
    action.setBadgeBackgroundColor?.({ color: "#cf222e" });
  } else {
    action.setBadgeText({ text: "" });
  }
}

function notifyPopup() {
  updateBadge();
  try {
    api.runtime.sendMessage({ type: "STATE_UPDATE", state: publicState() })?.catch?.(() => {});
  } catch {}
}

function stopTimers() {
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  pingTimer = null;
  reconnectTimer = null;
}

function closeSocket(isManual) {
  manualClose = isManual;
  stopTimers();
  if (ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }
}

async function sendToBoundTab(message) {
  if (state.boundTabId == null) return;
  try {
    await api.tabs.sendMessage(state.boundTabId, message);
  } catch {}
}

function scheduleReconnect() {
  if (manualClose || !state.roomId || !state.ticket) return;
  state.status = "reconnecting";
  notifyPopup();
  const baseDelay = Math.min(1000 * 2 ** reconnectAttempt, 15_000);
  const jitter = Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connectSocket(), baseDelay + jitter);
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (pendingVideoId) {
    if (!deferredSnapshot || (snapshot.revision ?? 0) >= (deferredSnapshot.revision ?? 0)) {
      deferredSnapshot = snapshot;
    }
    return;
  }
  if (state.snapshot && typeof snapshot.revision === "number" && snapshot.revision < state.snapshot.revision) {
    return;
  }
  state.snapshot = snapshot;
  if (shouldApplySnapshot()) {
    syncNavVideoId = snapshot.videoId || null;
    sendToBoundTab({
      type: "APPLY_SNAPSHOT",
      snapshot,
      clockOffsetMs: state.clockOffsetMs,
    });
  }
}

function syncTabRole() {
  sendToBoundTab({
    type: "SET_ROLE",
    role: state.role,
    roomId: state.roomId,
    publicPlaybackControl: state.publicPlaybackControl,
  });
}

function recordLocalCommand(command) {
  if (!command) return;
  if (command.action === "video" && command.videoId) {
    pendingVideoId = command.videoId;
    deferredSnapshot = null;
    syncNavVideoId = null;
  }
  if (
    command.action === "video" ||
    !state.snapshot?.videoId ||
    !command.videoId ||
    command.videoId === state.snapshot.videoId
  ) {
    state.snapshot = {
      ...(state.snapshot || {}),
      videoId: command.videoId || state.snapshot?.videoId || "",
      paused: Boolean(command.paused),
      positionSec: Number(command.positionSec ?? 0),
      playbackRate: Number(command.playbackRate || 1),
      serverTimeMs: Date.now(),
    };
  }
}

async function pushInitialHostState() {
  if (state.role !== "host" || state.boundTabId == null || ws?.readyState !== WebSocket.OPEN) return;
  try {
    const info = await api.tabs.sendMessage(state.boundTabId, { type: "GET_VIDEO_STATE" });
    if (info?.videoId && ws?.readyState === WebSocket.OPEN) {
      const cmd = {
        action: "video",
        videoId: info.videoId,
        paused: Boolean(info.paused),
        positionSec: Number(info.currentTime ?? 0),
        playbackRate: Number(info.playbackRate || 1),
      };
      recordLocalCommand(cmd);
      ws.send(encodeCommand(cmd));
    }
  } catch {}
}

function handleServerMessage(raw) {
  let msg;
  try {
    msg = decodeServerMessage(raw);
  } catch {
    return;
  }
  if (!msg) return;

  if (msg.type === "welcome") {
    state.status = "connected";
    state.role = msg.role === "host" ? "host" : "follower";
    state.publicPlaybackControl = Boolean(msg.publicPlaybackControl);
    state.error = null;
    pendingVideoId = null;
    deferredSnapshot = null;
    reconnectAttempt = 0;
    persistSession();
    syncTabRole();
    notifyPopup();
    if (msg.snapshot?.videoId) {
      applySnapshot(msg.snapshot);
    } else if (state.role === "host") {
      pushInitialHostState();
    }
    return;
  }

  if (msg.type === "ack") {
    if (state.snapshot && typeof msg.revision === "number" && msg.revision > (state.snapshot.revision ?? 0)) {
      state.snapshot.revision = msg.revision;
    }
    if (msg.videoId && msg.videoId === pendingVideoId) {
      pendingVideoId = null;
      const pending = deferredSnapshot;
      deferredSnapshot = null;
      if (pending && (pending.revision ?? 0) > (msg.revision ?? 0)) {
        applySnapshot(pending);
      }
    }
    return;
  }

  if (msg.type === "room_settings") {
    state.publicPlaybackControl = Boolean(msg.publicPlaybackControl);
    if (!canControl()) {
      pendingVideoId = null;
      deferredSnapshot = null;
    }
    persistSession();
    syncTabRole();
    notifyPopup();
    if (msg.snapshot?.videoId) applySnapshot(msg.snapshot);
    return;
  }

  if (msg.type === "snapshot") {
    applySnapshot(msg.snapshot ?? msg);
    return;
  }

  if (msg.type === "pong" && typeof msg.serverTimeMs === "number") {
    const rtt = typeof msg.clientTimeMs === "number" ? Math.max(0, Date.now() - msg.clientTimeMs) : 0;
    state.clockOffsetMs = msg.serverTimeMs + rtt / 2 - Date.now();
    return;
  }

  if (msg.type === "error") {
    state.error = msg.message || msg.code || "Server error";
    if (msg.code === "forbidden" || msg.code === "invalid_command") {
      pendingVideoId = null;
      deferredSnapshot = null;
    }
    if (FATAL_ERROR_CODES.has(msg.code)) {
      state.status = "error";
      closeSocket(true);
      state.roomId = null;
      state.role = null;
      state.publicPlaybackControl = false;
      pendingVideoId = null;
      deferredSnapshot = null;
      persistSession();
      syncTabRole();
    }
    notifyPopup();
  }
}

function connectSocket() {
  if (!state.roomId || !state.ticket) return;
  closeSocket(false);
  state.status = reconnectAttempt > 0 ? "reconnecting" : "connecting";
  state.error = null;
  notifyPopup();

  const socket = new WebSocket(roomWsUrl(state.serverUrl, state.roomId));
  ws = socket;

  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    socket.send(encodeAuth({ ticket: state.ticket }));
    pingTimer = setInterval(() => {
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(encodePing(Date.now()));
      }
    }, PING_INTERVAL_MS);
  });

  socket.addEventListener("message", (event) => {
    if (ws !== socket) return;
    handleServerMessage(event.data);
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    state.error = state.error || "WebSocket connection error";
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    stopTimers();
    ws = null;
    pendingVideoId = null;
    deferredSnapshot = null;
    if (!manualClose && state.roomId) {
      scheduleReconnect();
    }
  });
}

async function getActiveYouTubeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  if (tab.url && !/^https:\/\/www\.youtube\.com\//i.test(tab.url)) {
    throw new Error("Active tab must be a YouTube page");
  }
  try {
    await api.tabs.sendMessage(tab.id, { type: "GET_VIDEO_STATE" });
    return tab.id;
  } catch {
    if (api.scripting?.executeScript) {
      try {
        await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await api.tabs.sendMessage(tab.id, { type: "GET_VIDEO_STATE" });
        return tab.id;
      } catch {}
    }
    throw new Error("Active tab must be a YouTube page");
  }
}

async function leaveRoom() {
  const prevTab = state.boundTabId;
  closeSocket(true);
  state.status = "idle";
  state.roomId = null;
  state.role = null;
  state.publicPlaybackControl = false;
  state.boundTabId = null;
  state.snapshot = null;
  state.error = null;
  pendingVideoId = null;
  deferredSnapshot = null;
  syncNavVideoId = null;
  reconnectAttempt = 0;
  await persistSession();
  notifyPopup();
  if (prevTab != null) {
    try {
      await api.tabs.sendMessage(prevTab, { type: "SET_ROLE", role: null, roomId: null, publicPlaybackControl: false });
    } catch {}
  }
}

async function handlePopupAction(msg) {
  if (msg.type === "GET_UI_STATE") {
    return publicState();
  }

  if (msg.type === "SAVE_SETTINGS") {
    state.serverUrl = normalizeServerUrl(msg.serverUrl);
    state.displayName = (msg.displayName ?? "").trim();
    await api.storage.local.set({ serverUrl: state.serverUrl, displayName: state.displayName });
    return publicState();
  }

  if (msg.type === "CHECK_ROOM") {
    const serverUrl = normalizeServerUrl(msg.serverUrl ?? state.serverUrl);
    return { room: await getRoomInfo(serverUrl, msg.roomId) };
  }

  if (msg.type === "CREATE_ROOM") {
    const serverUrl = normalizeServerUrl(msg.serverUrl ?? state.serverUrl);
    const displayName = (msg.displayName ?? state.displayName).trim();
    const publicPlaybackControl = Boolean(msg.publicPlaybackControl);
    const tabId = await getActiveYouTubeTabId();
    const ticket = await claimTicket(serverUrl, displayName);
    const { roomId } = await createRoom(serverUrl, { ticket, publicPlaybackControl });

    await leaveRoom();
    state.serverUrl = serverUrl;
    state.displayName = displayName;
    state.ticket = ticket;
    state.publicPlaybackControl = publicPlaybackControl;
    state.roomId = roomId;
    state.boundTabId = tabId;
    await api.storage.local.set({ serverUrl, displayName });
    await persistSession();
    connectSocket();
    return publicState();
  }

  if (msg.type === "SET_PUBLIC_CONTROL") {
    if (state.role !== "host") throw new Error("Only host can change playback control");
    if (ws?.readyState !== WebSocket.OPEN) throw new Error("Not connected to room");
    const enabled = Boolean(msg.publicPlaybackControl);
    ws.send(encodeSetPublicControl(enabled));
    state.publicPlaybackControl = enabled;
    await persistSession();
    syncTabRole();
    return publicState();
  }

  if (msg.type === "JOIN_ROOM") {
    const serverUrl = normalizeServerUrl(msg.serverUrl ?? state.serverUrl);
    const displayName = (msg.displayName ?? state.displayName).trim();
    const roomId = (msg.roomId ?? "").trim();
    if (!roomId) throw new Error("Room ID is required");

    const tabId = await getActiveYouTubeTabId();
    const ticket = await claimTicket(serverUrl, displayName);

    await leaveRoom();
    state.serverUrl = serverUrl;
    state.displayName = displayName;
    state.ticket = ticket;
    state.roomId = roomId;
    state.boundTabId = tabId;
    await api.storage.local.set({ serverUrl, displayName });
    await persistSession();
    connectSocket();
    return publicState();
  }

  if (msg.type === "BIND_ACTIVE_TAB") {
    if (!state.roomId) throw new Error("Not in a room");
    const prevTab = state.boundTabId;
    const tabId = await getActiveYouTubeTabId();
    if (prevTab != null && prevTab !== tabId) {
      try {
        await api.tabs.sendMessage(prevTab, { type: "SET_ROLE", role: null, roomId: null });
      } catch {}
    }
    state.boundTabId = tabId;
    await persistSession();
    syncTabRole();
    if (shouldApplySnapshot() && state.snapshot) {
      await sendToBoundTab({
        type: "APPLY_SNAPSHOT",
        snapshot: state.snapshot,
        clockOffsetMs: state.clockOffsetMs,
      });
    }
    return publicState();
  }

  if (msg.type === "LEAVE_ROOM") {
    await leaveRoom();
    return publicState();
  }

  return null;
}

async function restore() {
  const prefs = await api.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, displayName: "" });
  state.serverUrl = normalizeServerUrl(prefs.serverUrl);
  state.displayName = prefs.displayName || "";

  const { ytsyncSession } = await sessionStore.get({ ytsyncSession: null });
  if (ytsyncSession?.roomId && ytsyncSession?.ticket) {
    Object.assign(state, {
      roomId: ytsyncSession.roomId,
      role: ytsyncSession.role ?? null,
      publicPlaybackControl: Boolean(ytsyncSession.publicPlaybackControl),
      boundTabId: ytsyncSession.boundTabId ?? null,
      ticket: ytsyncSession.ticket,
      serverUrl: normalizeServerUrl(ytsyncSession.serverUrl ?? state.serverUrl),
    });
    connectSocket();
  }
}

const ready = restore();

api.tabs?.onRemoved?.addListener((tabId) => {
  if (tabId === state.boundTabId) {
    state.boundTabId = null;
    persistSession();
    notifyPopup();
  }
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "PLAYER_EVENT") {
    ready.then(() => {
      if (
        sender?.tab?.id === state.boundTabId &&
        sender?.frameId === 0 &&
        canControl() &&
        state.status === "connected" &&
        ws?.readyState === WebSocket.OPEN
      ) {
        recordLocalCommand(msg.command);
        ws.send(encodeCommand(msg.command));
      }
    });
    return;
  }

  if (msg.type === "CONTENT_READY") {
    ready.then(() => {
      if (sender?.tab?.id === state.boundTabId && sender?.frameId === 0 && state.roomId) {
        syncTabRole();
        const isLocalFullNav =
          canControl() &&
          state.status === "connected" &&
          ws?.readyState === WebSocket.OPEN &&
          msg.videoId &&
          state.snapshot?.videoId &&
          msg.videoId !== state.snapshot.videoId &&
          msg.videoId !== syncNavVideoId;
        syncNavVideoId = null;
        if (isLocalFullNav) {
          const cmd = {
            action: "video",
            videoId: msg.videoId,
            paused: Boolean(msg.paused),
            positionSec: Number(msg.positionSec ?? 0),
            playbackRate: Number(msg.playbackRate || 1),
          };
          recordLocalCommand(cmd);
          ws.send(encodeCommand(cmd));
          return;
        }
        if (shouldApplySnapshot() && state.snapshot) {
          sendToBoundTab({
            type: "APPLY_SNAPSHOT",
            snapshot: state.snapshot,
            clockOffsetMs: state.clockOffsetMs,
          });
        }
      }
    });
    return;
  }

  ready
    .then(() => handlePopupAction(msg))
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
