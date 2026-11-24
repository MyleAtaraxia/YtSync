if (!globalThis.__ytsyncLoaded) {
globalThis.__ytsyncLoaded = true;

const api = globalThis.browser ?? globalThis.chrome;
const DRIFT_THRESHOLD_SEC = 0.5;
const SUPPRESS_MS = 800;

let role = null;
let publicPlaybackControl = false;
let boundVideo = null;
let lastVideoId = null;
let navigatingToVideoId = null;
let lastSnapshot = null;
let pendingSync = null;
let suppressUntil = 0;
let ignoreNextSeekedUntil = 0;
let recheckTimer = null;
let syncButton = null;
let checkScheduled = false;

function canControl() {
  return role === "host" || (role === "follower" && publicPlaybackControl);
}

function canReceiveSync() {
  return role === "follower" || (role === "host" && publicPlaybackControl);
}

function getVideoId(href = location.href) {
  try {
    const url = new URL(href);
    const v = url.searchParams.get("v");
    if (v) return v;
    const match = url.pathname.match(/^\/shorts\/([^/?]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isAdPlaying() {
  return Boolean(document.querySelector("#movie_player.ad-showing"));
}

function removeSyncPrompt() {
  syncButton?.remove();
  syncButton = null;
}

function showSyncPrompt() {
  if (syncButton) return;
  const btn = document.createElement("button");
  btn.textContent = "YtSync: Click to sync";
  Object.assign(btn.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: "2147483647",
    padding: "7px 14px",
    borderRadius: "18px",
    border: "1px solid #0d69a8",
    background: "linear-gradient(180deg, #86e8ff 0%, #27b4f5 48%, #0488dc 50%, #1eb9f2 100%)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.85), 0 4px 14px rgba(10,82,145,0.45)",
    color: "#fff",
    textShadow: "0 1px 1px rgba(0,48,92,0.7)",
    font: '600 13px "Segoe UI", Tahoma, sans-serif',
    cursor: "pointer",
  });
  btn.addEventListener("click", () => {
    removeSyncPrompt();
    tryApplyPending();
  });
  document.body.appendChild(btn);
  syncButton = btn;
}

function scheduleFollowerRecheck() {
  clearTimeout(recheckTimer);
  const delay = Math.max(20, suppressUntil - Date.now() + 20);
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    if (!canControl() && canReceiveSync() && lastSnapshot) {
      pendingSync = lastSnapshot;
      tryApplyPending();
    }
  }, delay);
}

function emitHostCommand(action) {
  if (!canControl()) {
    if (action !== "video" && canReceiveSync() && lastSnapshot) {
      if (Date.now() < suppressUntil) {
        scheduleFollowerRecheck();
      } else {
        pendingSync = lastSnapshot;
        tryApplyPending();
      }
    }
    return;
  }
  if (navigatingToVideoId) return;
  const videoId = getVideoId();
  if (!videoId || !boundVideo || isAdPlaying()) return;
  if (videoId !== lastVideoId) {
    // The URL can advance while the old player is ending or the new one is loading.
    if (boundVideo.ended || boundVideo.readyState < 1 || pendingSync?.snapshot?.videoId === videoId) return;
    lastVideoId = videoId;
    pendingSync = null;
    removeSyncPrompt();
    suppressUntil = 0;
    ignoreNextSeekedUntil = 0;
    action = "video";
  }
  if (action !== "video" && Date.now() < suppressUntil) return;
  if (action === "seek" && Date.now() < ignoreNextSeekedUntil) {
    ignoreNextSeekedUntil = 0;
    return;
  }
  if (pendingSync?.snapshot?.videoId && pendingSync.snapshot.videoId !== videoId) return;
  api.runtime.sendMessage({
    type: "PLAYER_EVENT",
    command: {
      action,
      videoId,
      paused: boundVideo.paused,
      positionSec: boundVideo.currentTime,
      playbackRate: boundVideo.playbackRate,
    },
  });
}

function computeTargetTime(snapshot, clockOffsetMs) {
  const base = Number(snapshot.positionSec ?? 0);
  if (snapshot.paused || typeof snapshot.serverTimeMs !== "number") {
    return Math.max(0, base);
  }
  const elapsedSec = (Date.now() + clockOffsetMs - snapshot.serverTimeMs) / 1000;
  const rate = Number(snapshot.playbackRate || 1);
  return Math.max(0, base + Math.max(0, elapsedSec) * rate);
}

function tryApplyPending() {
  if (!canReceiveSync() || !pendingSync) return;
  const { snapshot, clockOffsetMs } = pendingSync;
  if (!snapshot?.videoId) return;

  const currentId = getVideoId();
  if (currentId !== snapshot.videoId) {
    if (navigatingToVideoId !== snapshot.videoId) {
      navigatingToVideoId = snapshot.videoId;
      location.href = `https://www.youtube.com/watch?v=${encodeURIComponent(snapshot.videoId)}`;
    }
    return;
  }
  lastVideoId = currentId;
  navigatingToVideoId = null;

  if (!boundVideo || boundVideo.readyState < 1 || isAdPlaying()) return;

  suppressUntil = Date.now() + SUPPRESS_MS;
  const targetRate = Number(snapshot.playbackRate || 1);
  if (boundVideo.playbackRate !== targetRate) {
    boundVideo.playbackRate = targetRate;
  }

  const targetTime = computeTargetTime(snapshot, clockOffsetMs);
  if (Math.abs(boundVideo.currentTime - targetTime) > DRIFT_THRESHOLD_SEC) {
    ignoreNextSeekedUntil = Date.now() + 3000;
    boundVideo.currentTime = targetTime;
  }

  const applied = pendingSync;
  if (snapshot.paused) {
    boundVideo.pause();
    removeSyncPrompt();
    pendingSync = null;
  } else {
    const playPromise = boundVideo.play();
    if (playPromise?.then) {
      playPromise
        .then(() => {
          if (pendingSync !== applied) return;
          removeSyncPrompt();
          pendingSync = null;
        })
        .catch(() => {
          if (pendingSync !== applied) return;
          showSyncPrompt();
        });
    } else {
      pendingSync = null;
    }
  }
}

function onVideoEvent(event) {
  if (event.currentTarget !== boundVideo) return;
  if (event.type === "loadedmetadata" || event.type === "canplay") {
    checkPage();
  } else {
    emitHostCommand(event.type === "seeked" ? "seek" : event.type === "ratechange" ? "rate" : event.type);
  }
}

function attachVideo(video) {
  if (boundVideo === video) return;
  boundVideo = video;
  if (!video) return;

  for (const type of ["play", "pause", "seeked", "ratechange", "loadedmetadata", "canplay"]) {
    video.addEventListener(type, onVideoEvent);
  }
}

function checkPage() {
  checkScheduled = false;
  attachVideo(document.querySelector("video"));
  const videoId = getVideoId();
  if (navigatingToVideoId) {
    if (videoId === navigatingToVideoId) {
      navigatingToVideoId = null;
      lastVideoId = videoId;
    }
    tryApplyPending();
    return;
  }
  if (videoId && videoId !== lastVideoId) {
    if (!canControl() || pendingSync?.snapshot?.videoId === videoId) {
      lastVideoId = videoId;
    } else {
      pendingSync = null;
      removeSyncPrompt();
      emitHostCommand("video");
    }
  }
  tryApplyPending();
}

function scheduleCheck() {
  if (checkScheduled) return;
  checkScheduled = true;
  requestAnimationFrame(checkPage);
}

window.addEventListener("yt-navigate-finish", checkPage);
window.addEventListener("popstate", checkPage);

const observer = new MutationObserver(scheduleCheck);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "GET_VIDEO_STATE") {
    const video = document.querySelector("video");
    sendResponse(
      video
        ? {
            videoId: getVideoId(),
            url: location.href,
            positionSec: video.currentTime,
            paused: video.paused,
            playbackRate: video.playbackRate,
            adPlaying: isAdPlaying(),
          }
        : null
    );
    return;
  }

  if (msg?.type === "SET_ROLE") {
    role = msg.role;
    publicPlaybackControl = Boolean(msg.publicPlaybackControl);
    if (!canReceiveSync()) {
      clearTimeout(recheckTimer);
      recheckTimer = null;
      navigatingToVideoId = null;
      lastSnapshot = null;
      pendingSync = null;
      removeSyncPrompt();
    }
    return;
  }

  if (msg?.type === "APPLY_SNAPSHOT") {
    if (navigatingToVideoId && msg.snapshot?.videoId !== navigatingToVideoId) {
      navigatingToVideoId = null;
    }
    lastSnapshot = { snapshot: msg.snapshot, clockOffsetMs: msg.clockOffsetMs ?? 0 };
    pendingSync = lastSnapshot;
    tryApplyPending();
  }
});

checkPage();
api.runtime
  .sendMessage({
    type: "CONTENT_READY",
    videoId: getVideoId(),
    paused: boundVideo ? boundVideo.paused : true,
    positionSec: boundVideo ? boundVideo.currentTime : 0,
    playbackRate: boundVideo ? boundVideo.playbackRate : 1,
  })
  .catch?.(() => {});
}
