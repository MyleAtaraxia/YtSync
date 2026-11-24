import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
const JS_ENTRIES = ["background.js", "content.js", "popup.js", "overlay.js"];
const HTML_FILES = ["popup.html"];

function zipDir(srcDir, outZip) {
  fs.rmSync(outZip, { force: true });
  const files = fs.readdirSync(srcDir);
  if (process.platform === "win32") {
    execFileSync("tar", ["-a", "-cf", outZip, "-C", srcDir, ...files], { stdio: "pipe" });
  } else {
    execFileSync("zip", ["-rq", outZip, ...files], { cwd: srcDir, stdio: "pipe" });
  }
}

export async function build() {
  const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const version = base.version;

  const chromeManifest = {
    ...base,
    background: { service_worker: base.background.service_worker },
  };
  delete chromeManifest.browser_specific_settings;

  const firefoxManifest = {
    ...base,
    background: { scripts: base.background.scripts },
    optional_permissions: base.optional_host_permissions,
  };
  delete firefoxManifest.optional_host_permissions;

  for (const [target, manifest] of [
    ["chrome", chromeManifest],
    ["firefox", firefoxManifest],
  ]) {
    const out = path.join(dist, target);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });

    const res = await Bun.build({
      entrypoints: JS_ENTRIES.map((f) => path.join(root, f)),
      outdir: out,
      target: "browser",
      format: "iife",
      minify: true,
    });
    if (!res.success) {
      throw new Error(res.logs.map((l) => l.message).join("\n"));
    }

    for (const file of HTML_FILES) {
      const html = fs.readFileSync(path.join(root, file), "utf8");
      fs.writeFileSync(path.join(out, file), html.replace(/>\s+</g, "><").trim());
    }

    fs.cpSync(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });

    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest));
    zipDir(out, path.join(dist, `ytsync-${target}-v${version}.zip`));
  }

  console.log(`[${new Date().toLocaleTimeString()}] built & zipped chrome + firefox (v${version})`);
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === import.meta.filename.toLowerCase()) {
  await build();
  if (process.argv.includes("--watch")) {
    let timer;
    fs.watch(root, (_event, filename) => {
      if (!filename || !/^(manifest\.json|.+\.(js|html))$/.test(filename)) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await build();
        } catch (err) {
          console.error("build failed:", err.message);
        }
      }, 100);
    });
    console.log("watching for changes...");
  }
}
