export const DEFAULT_SERVER_URL = "https://ytsync.ataraxia.ws";

export function normalizeServerUrl(url) {
  return (url || DEFAULT_SERVER_URL).trim().replace(/\/+$/, "");
}

export function roomWsUrl(serverUrl, roomId) {
  const base = normalizeServerUrl(serverUrl).replace(/^http/i, "ws");
  return `${base}/room/${encodeURIComponent(roomId)}/join`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text };
  }
}

export async function claimTicket(serverUrl, name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Display name is required");
  const url = `${normalizeServerUrl(serverUrl)}/ticket/${encodeURIComponent(trimmed)}`;
  const res = await fetch(url, { method: "POST" });
  const data = await readJson(res);
  if (!res.ok || !data["identity-key"]) {
    throw new Error(data.error || `Failed to claim ticket (${res.status})`);
  }
  return { name: trimmed, key: data["identity-key"] };
}

export async function getRoomInfo(serverUrl, roomId) {
  const id = roomId.trim();
  if (!id) throw new Error("Room ID is required");
  const url = `${normalizeServerUrl(serverUrl)}/room/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(data.error || `Room lookup failed (${res.status})`);
  }
  return {
    id: data["join-code"] ?? data.id ?? id,
    memberCount: Number(data.memberCount ?? data.members ?? data.people ?? 0),
    publicPlaybackControl: Boolean(data.publicPlaybackControl ?? false),
  };
}

export async function createRoom(serverUrl, { ticket, publicPlaybackControl = false }) {
  const url = `${normalizeServerUrl(serverUrl)}/room/new`;
  const body = { name: ticket.name, "identity-key": ticket.key, publicPlaybackControl: Boolean(publicPlaybackControl) };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  const roomId = data["join-code"] ?? data.roomId ?? data.room_id ?? data.id;
  if (!res.ok || !roomId) {
    throw new Error(data.error || `Failed to create room (${res.status})`);
  }
  return { roomId: String(roomId) };
}

export function encodeAuth({ ticket }) {
  return JSON.stringify({ type: "auth", name: ticket.name, "identity-key": ticket.key });
}

export function encodeCommand(command) {
  return JSON.stringify({ type: "command", ...command });
}

export function encodeSetPublicControl(enabled) {
  return JSON.stringify({ type: "set_public_control", publicPlaybackControl: Boolean(enabled) });
}

export function encodePing(clientTimeMs = Date.now()) {
  return JSON.stringify({ type: "ping", clientTimeMs });
}

export function decodeServerMessage(raw) {
  const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!msg || typeof msg.type !== "string") return null;
  return msg;
}
