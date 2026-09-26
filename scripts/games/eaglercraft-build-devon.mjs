// Copy into the eaglercraft-ts project root and run:
//   OUT_DIR=<Devon>/public/games/eaglercraft node build-devon.mjs
// Builds the Eaglercraft client for Devon's Games page (OUT_DIR, default
// dist-devon/). Same page as build.mjs, but instead of one ~80 MB HTML file:
//   - classes.js is gzipped and split into 3 MB parts
//   - the asset pack is split into 3 MB parts
//   - a small loader downloads the parts, joins them into blob: URLs, then runs
//     classes.js and the other scripts in their original order
// This keeps every file small enough for static hosting (EdgeOne Pages).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readEPK, writeEPK } from "./tools/epk.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const out = process.env.OUT_DIR || join(root, "dist-devon");
const read = (p) => readFileSync(join(root, p), "utf8");
const PART = 3_000_000;

console.log("[devon] tsc");
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", root], { stdio: "inherit" });

const MODAPI_VERSION = "v2.7.97";
const BUILTIN_PACKS = ["packs/tidewake-shaders"];

function listFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]);
}
function buildAssets() {
    const base = readFileSync(join(root, "vendor/assets.epk"));
    if (process.env.NO_PACKS === "1") return base;
    const epk = readEPK(base);
    for (const pack of BUILTIN_PACKS) {
        const packRoot = join(root, pack);
        for (const file of listFiles(join(packRoot, "assets"))) {
            epk.files.set(relative(packRoot, file).split(sep).join("/"), readFileSync(file));
        }
    }
    return writeEPK(epk);
}
function readCompiled(ref) {
    let code = read(ref);
    if (ref.startsWith("build/")) {
        const src = read(ref.replace(/^build\//, "src/").replace(/\.js$/, ".ts"));
        if (!src.trimStart().startsWith('"use strict"')) code = code.replace(/^"use strict";\n/, "");
    }
    return code;
}
function postinitData() {
    const code = readCompiled("build/modapi/postinit.js");
    if (code.includes("`") || code.includes("\\")) throw new Error("postinit.js must not contain backticks or backslashes");
    const templated = code.replace(`ModAPI.version = "${MODAPI_VERSION}";`, `ModAPI.version = "__modapi_version_code__";`);
    return "globalThis.modapi_postinit = `" + templated + "`;";
}
function builtinMods() {
    const dir = join(root, "build/mods/builtin");
    const mods = readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => ({
        name: f.replace(/\.js$/, ""),
        code: readCompiled("build/mods/builtin/" + f),
    }));
    return "globalThis.modapi_builtinMods = " + JSON.stringify(mods).replace(/</g, "\\u003c") + ";";
}
const special = {
    "@builtin-mods": builtinMods,
    "@postinit-data": postinitData,
    "@libserverside": () => '{"._|_libserverside_|_."}',
};
function load(ref) {
    let code = special[ref] ? special[ref]() : readCompiled(ref);
    if (ref === "build/boot/launch-countdown.js") {
        // Assets come from the loader; and the page's load event has already
        // fired by the time this runs, so start the countdown straight away
        code = code
            .replace("__EAGLER_ASSETS_URI__", "window.__devonAssetsURL")
            .replace('window.addEventListener("load", function () {',
                '(function (f) { document.readyState === "complete" ? f() : window.addEventListener("load", f); })(function () {');
        if (!code.includes("__devonAssetsURL") || !code.includes("readyState")) throw new Error("launch-countdown patch failed");
    }
    if (/<\/script/i.test(code)) throw new Error(ref + " contains </script");
    return code;
}

function writeParts(name, buf) {
    const n = Math.ceil(buf.length / PART);
    for (let i = 0; i < n; i++) {
        writeFileSync(join(out, "Build", `${name}.part${String(i).padStart(2, "0")}`), buf.subarray(i * PART, (i + 1) * PART));
    }
    console.log(`[devon] ${name}: ${(buf.length / 1048576).toFixed(1)} MB in ${n} parts`);
    return { parts: n, size: buf.length };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "Build"), { recursive: true });
const classes = writeParts("classes.js.gz", gzipSync(readFileSync(join(root, "vendor/classes.js")), { level: 9 }));
const assets = writeParts("assets.epk", buildAssets());

let html = read("index.template.html");
// Head: launch options run now; classes.js and the countdown are run by the loader
html = html.replace(/<script type="text\/javascript"><!-- @inline (\S+) --><\/script>/g, (_, ref) => {
    if (ref === "build/boot/launch-options.js") return `<script type="text/javascript">${load(ref)}</script>`;
    if (ref === "vendor/classes.js") return '<script type="text/x-devon-classes"></script>';
    return `<script type="text/x-devon-deferred">${load(ref)}</script>`;
});
// Body scripts wait for classes.js too (kept as inert script tags with their ids)
html = html.replace(/<script id="([^"]+)"><!-- @inline (\S+) --><\/script>/g,
    (_, id, ref) => `<script type="text/x-devon-deferred" id="${id}">${load(ref)}</script>`);
if (html.includes("@inline")) throw new Error("unhandled @inline marker");

const loaderUI = `
<div id="devon_loading" style="position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#111;color:#ddd;font-family:system-ui,-apple-system,sans-serif;">
<div style="font-size:18px;font-weight:600;">EaglercraftX 1.8</div>
<div style="width:240px;height:6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;"><div id="devon_fill" style="width:0%;height:100%;background:#ff7a2f;transition:width .15s;"></div></div>
<div id="devon_status" style="font-size:12px;color:#999;">Downloading game…</div>
</div>`;
const loader = `<script>
(function () {
  var CLASSES = ${JSON.stringify(classes)}, ASSETS = ${JSON.stringify(assets)};
  var total = CLASSES.size + ASSETS.size, got = 0;
  var fill = document.getElementById("devon_fill"), status = document.getElementById("devon_status");
  function progress() { fill.style.width = Math.round(100 * got / total) + "%"; }
  function fail(e) {
    var msg = e && e.message ? e.message : String(e);
    status.textContent = msg; status.style.color = "#ff8a80";
    try { parent.postMessage({ devonGame: "error", message: msg }, "*"); } catch (x) {}
  }
  function part(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      if (!res.body || !res.body.getReader) return res.blob().then(function (b) { got += b.size; progress(); return b; });
      var reader = res.body.getReader(), chunks = [];
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks);
          chunks.push(r.value); got += r.value.byteLength; progress();
          return pump();
        });
      }
      return pump();
    });
  }
  function joined(name, info) {
    var jobs = [];
    for (var i = 0; i < info.parts; i++) jobs.push(part("Build/" + name + ".part" + (i < 10 ? "0" : "") + i));
    return Promise.all(jobs).then(function (parts) { return new Blob(parts); });
  }
  function gunzip(blob) {
    if (typeof DecompressionStream === "undefined") throw new Error("This browser is too old to run Eaglercraft here (needs Safari 16.4+ / Chrome 80+)");
    return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
  }
  function run(el, attrs) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      if (el.id) s.id = el.id;
      if (attrs && attrs.src) {
        s.src = attrs.src;
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error("Couldn't start the game")); };
      } else {
        s.text = el.textContent;
      }
      el.parentNode.replaceChild(s, el);
      if (!attrs || !attrs.src) resolve();
    });
  }
  Promise.all([
    joined("classes.js.gz", CLASSES).then(gunzip).then(function (b) { return URL.createObjectURL(new Blob([b], { type: "text/javascript" })); }),
    joined("assets.epk", ASSETS).then(function (b) { return URL.createObjectURL(b); }),
  ]).then(function (urls) {
    status.textContent = "Starting…";
    window.__devonAssetsURL = urls[1];
    // classes.js records its own <script> element; the singleplayer worker is loaded from its src
    return run(document.querySelector('script[type="text/x-devon-classes"]'), { src: urls[0] });
  }).then(function () {
    var list = document.querySelectorAll('script[type="text/x-devon-deferred"]');
    var chain = Promise.resolve();
    Array.prototype.forEach.call(list, function (el) { chain = chain.then(function () { return run(el); }); });
    return chain;
  }).then(function () {
    var ui = document.getElementById("devon_loading");
    if (ui) ui.parentNode.removeChild(ui);
    try { parent.postMessage({ devonGame: "ready" }, "*"); } catch (x) {}
  }).catch(fail);
})();
</script>`;
html = html.replace("</body>", loaderUI + "\n" + loader + "\n</body>");
writeFileSync(join(out, "index.html"), html);
console.log(`[devon] index.html (${(html.length / 1024).toFixed(0)} KB)`);
