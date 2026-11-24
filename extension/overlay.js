(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const FRAME_ID = "__ytsync_overlay_frame";
  const STATE_KEY = "__ytsyncOverlayCleanup";

  const existing = document.getElementById(FRAME_ID);
  if (existing) {
    globalThis[STATE_KEY]?.();
    return;
  }

  const popupUrl = api.runtime.getURL("popup.html");
  const extensionOrigin = new URL(popupUrl).origin;

  const iframe = document.createElement("iframe");
  iframe.id = FRAME_ID;
  iframe.src = popupUrl;
  iframe.allow = "clipboard-write";
  iframe.setAttribute("allowtransparency", "true");
  Object.assign(iframe.style, {
    position: "fixed",
    top: "6px",
    right: "6px",
    width: "336px",
    height: "420px",
    border: "none",
    margin: "0",
    padding: "0",
    background: "transparent",
    backgroundColor: "transparent",
    colorScheme: "light",
    zIndex: "2147483647",
    overflow: "hidden",
    pointerEvents: "auto",
  });

  const PREFERRED_WIDTH = 336;
  let desiredHeight = 420;
  let dragged = false;

  function applyLayout() {
    const width = Math.min(PREFERRED_WIDTH, window.innerWidth);
    const height = Math.min(Math.ceil(desiredHeight), window.innerHeight);
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;

    const maxTop = Math.max(0, window.innerHeight - height);
    const currentTop = parseFloat(iframe.style.top);
    const nextTop = Math.min(maxTop, Math.max(0, Number.isFinite(currentTop) ? currentTop : 6));
    iframe.style.top = `${nextTop}px`;

    if (dragged) {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const currentLeft = parseFloat(iframe.style.left);
      const nextLeft = Math.min(maxLeft, Math.max(0, Number.isFinite(currentLeft) ? currentLeft : 0));
      iframe.style.left = `${nextLeft}px`;
    }
  }

  function onOutsidePointerDown(event) {
    if (event.target === iframe) return;
    cleanup();
  }

  function cleanup() {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("resize", applyLayout);
    document.removeEventListener("pointerdown", onOutsidePointerDown, true);
    iframe.remove();
    delete globalThis[STATE_KEY];
  }

  function onMessage(event) {
    if (event.source !== iframe.contentWindow || event.origin !== extensionOrigin) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "YTSYNC_CLOSE") {
      cleanup();
      return;
    }

    if (msg.type === "YTSYNC_RESIZE") {
      if (typeof msg.height === "number" && msg.height > 0) desiredHeight = msg.height;
      applyLayout();
      return;
    }

    if (msg.type === "YTSYNC_DRAG") {
      dragged = true;
      const rect = iframe.getBoundingClientRect();
      const maxLeft = Math.max(0, window.innerWidth - rect.width);
      const maxTop = Math.max(0, window.innerHeight - rect.height);
      const nextLeft = Math.min(maxLeft, Math.max(0, rect.left + (msg.dx || 0)));
      const nextTop = Math.min(maxTop, Math.max(0, rect.top + (msg.dy || 0)));
      iframe.style.right = "auto";
      iframe.style.left = `${nextLeft}px`;
      iframe.style.top = `${nextTop}px`;
    }
  }

  window.addEventListener("message", onMessage);
  window.addEventListener("resize", applyLayout);
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  globalThis[STATE_KEY] = cleanup;
  (document.documentElement || document.body).appendChild(iframe);
  applyLayout();
})();
