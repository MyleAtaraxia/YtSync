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
assert.deepEqual(JSON.parse(encodeAuth({ ticket: { name: "ali", key: "k1" } })), {
  type: "auth",
  name: "ali",
  "identity-key": "k1",
});

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

// Exercise bundled background.js with a room socket and separate tab players.
let onMessage;
let activeTabId = 42;
const tabPlayback = new Map([
  [42, { videoId: "abc", positionSec: 10, paused: false }],
  [43, { videoId: "next", positionSec: 47.5, paused: true, playbackRate: 1.25 }],
]);
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
    query: async () => [{ id: activeTabId }],
    sendMessage: async (tabId, msg) => {
      sentToTabs.push({ tabId, msg });
      return msg.type === "GET_VIDEO_STATE" ? tabPlayback.get(tabId) : undefined;
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
await Promise.resolve();
assert.equal(sockets[0].sent.length, 1);

// Forwarded from bound tab top frame
onMessage({ type: "PLAYER_EVENT", command: { action: "pause", videoId: "abc" } }, { tab: { id: 42 }, frameId: 0 }, () => {});
await Promise.resolve();
assert.deepEqual(sockets[0].sent[1], { type: "command", action: "pause", videoId: "abc" });

activeTabId = 43;
assert.equal((await callBg({ type: "GET_UI_STATE" })).boundTabId, 42);
const rebound = await callBg({ type: "BIND_ACTIVE_TAB" });
assert.equal(rebound.ok, true);
assert.equal(rebound.boundTabId, 43);
assert.equal(rebound.snapshot.videoId, "next");
assert.equal(sessionStore.ytsyncSession.boundTabId, 43);
assert.deepEqual(sockets[0].sent[2], {
  type: "command",
  action: "video",
  ...tabPlayback.get(43),
});
assert.ok(sentToTabs.some(({ tabId, msg }) => tabId === 42 && msg.type === "SET_ROLE" && msg.role === null));
assert.ok(sentToTabs.some(({ tabId, msg }) => tabId === 43 && msg.type === "SET_ROLE" && msg.role === "host"));

onMessage({ type: "PLAYER_EVENT", command: { action: "play", videoId: "abc" } }, { tab: { id: 42 }, frameId: 0 });
onMessage({ type: "PLAYER_EVENT", command: { action: "play", videoId: "next" } }, { tab: { id: 43 }, frameId: 0 });
await Promise.resolve();
assert.deepEqual(sockets[0].sent.slice(3), [{ type: "command", action: "play", videoId: "next" }]);

activeTabId = 44;
assert.equal((await callBg({ type: "BIND_ACTIVE_TAB" })).ok, false);
assert.equal((await callBg({ type: "GET_UI_STATE" })).boundTabId, 43);

// A player-state reply from an earlier click cannot reclaim the room.
const slowProbeStarted = Promise.withResolvers();
const slowPlayback = Promise.withResolvers();
tabPlayback.set(45, {
  then(resolve, reject) {
    slowProbeStarted.resolve();
    return slowPlayback.promise.then(resolve, reject);
  },
});
activeTabId = 45;
const slowBind = callBg({ type: "BIND_ACTIVE_TAB" });
await slowProbeStarted.promise;
activeTabId = 42;
assert.equal((await callBg({ type: "BIND_ACTIVE_TAB" })).boundTabId, 42);
slowPlayback.resolve({ videoId: "late" });
assert.equal((await slowBind).ok, false);
assert.equal(sockets[0].sent.at(-1).videoId, "abc");

const roomSnapshot = { revision: 9, videoId: "abc", positionSec: 12, paused: true, playbackRate: 1 };
const hostSocket = sockets[0];
hostSocket.emit("message", { data: JSON.stringify({ type: "ack", videoId: "abc", revision: 8 }) });
hostSocket.emit("message", {
  data: JSON.stringify({ type: "room_settings", publicPlaybackControl: true, snapshot: roomSnapshot }),
});

// With public control enabled, the host's new tab adopts room playback.
const sentBeforePublicBind = hostSocket.sent.length;
activeTabId = 43;
const publicBind = await callBg({ type: "BIND_ACTIVE_TAB" });
assert.equal(publicBind.boundTabId, 43);
assert.equal(publicBind.publicPlaybackControl, true);
assert.equal(hostSocket.sent.length, sentBeforePublicBind);
assert.equal(sentToTabs.at(-1).tabId, 43);
assert.equal(sentToTabs.at(-1).msg.type, "APPLY_SNAPSHOT");
assert.deepEqual(sentToTabs.at(-1).msg.snapshot, roomSnapshot);

// A follower joining and rebinding uses the server's playback snapshot.
activeTabId = 42;
assert.equal((await callBg({ type: "JOIN_ROOM", roomId: "room-8" })).ok, true);
const followerSocket = sockets.at(-1);
followerSocket.emit("open");
followerSocket.emit("message", { data: JSON.stringify({ type: "welcome", role: "follower", snapshot: roomSnapshot }) });
const sentBeforeFollowerBind = followerSocket.sent.length;
activeTabId = 43;
assert.equal((await callBg({ type: "BIND_ACTIVE_TAB" })).boundTabId, 43);
assert.equal(followerSocket.sent.length, sentBeforeFollowerBind);
assert.equal(sentToTabs.at(-1).tabId, 43);
assert.equal(sentToTabs.at(-1).msg.type, "APPLY_SNAPSHOT");
assert.deepEqual(sentToTabs.at(-1).msg.snapshot, roomSnapshot);

// Fatal ticket error disconnects and clears the room.
followerSocket.emit("message", { data: JSON.stringify({ type: "error", code: "invalid_ticket", message: "Invalid ticket" }) });
assert.equal(followerSocket.closed, true);
const afterErr = await callBg({ type: "GET_UI_STATE" });
assert.equal(afterErr.roomId, null);
assert.equal(afterErr.error, "Invalid ticket");

// YouTube can advance the URL before replacing the ended video element.
const playerCommands = [];
const endedVideo = Object.assign(new EventTarget(), {
  ended: true, readyState: 4, paused: true, currentTime: 120, playbackRate: 1,
});
let videoElement = endedVideo;
let onContentMessage;
const pageLocation = { href: "https://www.youtube.com/watch?v=previous" };
const pageWindow = new EventTarget();
vm.runInNewContext(fs.readFileSync(path.join(root, "dist/chrome/content.js"), "utf8"), {
  URL,
  clearTimeout,
  location: pageLocation,
  window: pageWindow,
  document: { querySelector: (selector) => selector === "video" ? videoElement : null },
  MutationObserver: class { observe() {} },
  chrome: {
    runtime: {
      onMessage: { addListener: (fn) => { onContentMessage = fn; } },
      sendMessage: async (msg) => {
        if (msg.type === "PLAYER_EVENT") playerCommands.push(msg.command);
      },
    },
  },
});
onContentMessage({ type: "SET_ROLE", role: "host", publicPlaybackControl: false });
pageLocation.href = "https://www.youtube.com/watch?v=autoplay";
pageWindow.dispatchEvent(new Event("yt-navigate-finish"));
videoElement = null;
pageWindow.dispatchEvent(new Event("yt-navigate-finish"));
videoElement = Object.assign(new EventTarget(), {
  ended: false, readyState: 0, paused: false, currentTime: 0, playbackRate: 1.25,
});
pageWindow.dispatchEvent(new Event("yt-navigate-finish"));
assert.equal(playerCommands.length, 0);

videoElement.readyState = 1;
videoElement.currentTime = 0.25;
videoElement.dispatchEvent(new Event("loadedmetadata"));
videoElement.dispatchEvent(new Event("canplay"));
endedVideo.dispatchEvent(new Event("pause"));
assert.deepEqual(playerCommands, [{
  action: "video", videoId: "autoplay", paused: false, positionSec: 0.25, playbackRate: 1.25,
}]);

// Play can also be the first event that observes the new URL.
pageLocation.href = "https://www.youtube.com/watch?v=playlist";
videoElement.currentTime = 0;
videoElement.dispatchEvent(new Event("play"));
pageWindow.dispatchEvent(new Event("yt-navigate-finish"));
assert.equal(playerCommands.length, 2);
assert.equal(playerCommands[1].action, "video");
assert.equal(playerCommands[1].videoId, "playlist");

console.log("ok");
