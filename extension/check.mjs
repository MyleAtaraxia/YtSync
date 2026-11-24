import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { build } from "./build.mjs";
import { encodeAuth, roomWsUrl } from "./protocol.js";

const root = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.background.service_worker);
assert.ok(Array.isArray(manifest.background.scripts));
assert.ok(manifest.browser_specific_settings?.gecko?.id);

assert.equal(roomWsUrl("https://sync.example.com/", "abc 123"), "wss://sync.example.com/room/abc%20123/join");
assert.deepEqual(JSON.parse(encodeAuth({ ticket: { name: "ali", key: "k1" }, passcode: "secret" })), {
  type: "auth",
  name: "ali",
  "identity-key": "k1",
  passcode: "secret",
});
assert.equal("passcode" in JSON.parse(encodeAuth({ ticket: { name: "ali", key: "k1" } })), false);

await build();

const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "dist/chrome/manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, "dist/firefox/manifest.json"), "utf8"));
assert.deepEqual(chromeManifest.background, { service_worker: "background.js" });
assert.equal("browser_specific_settings" in chromeManifest, false);
assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
assert.ok(firefoxManifest.browser_specific_settings?.gecko?.id);

for (const target of ["chrome", "firefox"]) {
  const zipPath = path.join(root, "dist", `ytsync-${target}-v${manifest.version}.zip`);
  assert.ok(fs.existsSync(zipPath), `missing ${zipPath}`);
  const entries = execFileSync("tar", ["-tf", zipPath], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.ok(!entries.some((e) => e.startsWith("./")), "zip entries must not have ./ prefix");
  for (const name of ["manifest.json", "background.js", "content.js", "popup.html", "popup.js"]) {
    assert.ok(entries.includes(name), `missing ${name} in ${zipPath}`);
  }
}

// Exercise bundled background.js: ticket claim, passcode auth, bound-tab enforcement, fatal error handling
let onMessage;
const sentToTabs = [];
const sockets = [];
const localStore = {};
const sessionStore = {};

class FakeWebSocket {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    sockets.push(this);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const fakeApi = {
  runtime: {
    onMessage: { addListener: (fn) => (onMessage = fn) },
  },
  tabs: {
    query: async () => [{ id: 42 }],
    sendMessage: async (tabId, msg) => {
      sentToTabs.push({ tabId, msg });
      return msg.type === "GET_VIDEO_STATE" ? { videoId: "dQw4w9WgXcQ", currentTime: 10, paused: false } : undefined;
    },
    onRemoved: { addListener: () => {} },
  },
  storage: {
    local: {
      set: async (v) => Object.assign(localStore, v),
      get: async (d) => ({ ...d, ...localStore }),
    },
    session: {
      set: async (v) => Object.assign(sessionStore, v),
      get: async (d) => ({ ...d, ...sessionStore }),
    },
  },
};

const fakeFetch = async (url, init = {}) => {
  if (url.endsWith("/ticket/alice") && init.method === "POST") {
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: "ok", "identity-key": "key-123" }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const context = {
  chrome: fakeApi,
  WebSocket: FakeWebSocket,
  fetch: fakeFetch,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  URL,
  encodeURIComponent,
};
context.globalThis = context;

vm.runInNewContext(fs.readFileSync(path.join(root, "dist/chrome/background.js"), "utf8"), context);

const callBg = (msg, sender = {}) =>
  new Promise((resolve) => {
    const isAsync = onMessage(msg, sender, resolve);
    if (!isAsync) resolve(undefined);
  });

const joined = await callBg({
  type: "JOIN_ROOM",
  serverUrl: "http://localhost:8080",
  displayName: "alice",
  roomId: "room-7",
  passcode: "pw99",
});
assert.equal(joined.ok, true);
assert.equal(joined.roomId, "room-7");
assert.equal(joined.boundTabId, 42);
assert.equal(sockets.length, 1);
assert.equal(sockets[0].url, "ws://localhost:8080/room/room-7/join");

sockets[0].emit("open");
assert.deepEqual(sockets[0].sent[0], {
  type: "auth",
  name: "alice",
  "identity-key": "key-123",
  passcode: "pw99",
});

sockets[0].emit("message", {
  data: JSON.stringify({
    type: "welcome",
    role: "host",
    snapshot: { revision: 1, videoId: "abc", paused: false, positionSec: 5, playbackRate: 1, serverTimeMs: Date.now() },
  }),
});

// Ignored from wrong tab or iframe
onMessage({ type: "PLAYER_EVENT", command: { action: "pause" } }, { tab: { id: 99 }, frameId: 0 }, () => {});
onMessage({ type: "PLAYER_EVENT", command: { action: "pause" } }, { tab: { id: 42 }, frameId: 1 }, () => {});
assert.equal(sockets[0].sent.length, 1);

// Forwarded from bound tab top frame
onMessage({ type: "PLAYER_EVENT", command: { action: "pause", videoId: "abc" } }, { tab: { id: 42 }, frameId: 0 }, () => {});
assert.deepEqual(sockets[0].sent[1], { type: "command", action: "pause", videoId: "abc" });

// Fatal passcode error disconnects and clears room without reconnecting
sockets[0].emit("message", { data: JSON.stringify({ type: "error", code: "invalid_passcode", message: "Wrong passcode" }) });
assert.equal(sockets[0].closed, true);
const afterErr = await callBg({ type: "GET_UI_STATE" });
assert.equal(afterErr.roomId, null);
assert.equal(afterErr.error, "Wrong passcode");

console.log("ok");
