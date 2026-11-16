#!/usr/bin/env node
// flatten-standalone.mjs
//
// Makes a Next.js standalone folder safe to ship inside an installer.
//
// pnpm lays out node_modules with symlinks: node_modules/next is only a link
// into node_modules/.pnpm/next@x/node_modules/next, and that package finds its
// own deps (react, styled-jsx, ...) through more links. Installers (Tauri's
// resource copy / NSIS) don't keep symlinks, so the shipped app ends up with
// only node_modules/.pnpm and `require('next')` fails -> server exits with 1.
//
// This script replaces that layout with a plain, flat node_modules made of
// real folders, then removes .pnpm. It also works on a folder whose links are
// already gone (e.g. an installed copy), so it doubles as a repair tool.
//
// Usage:  node flatten-standalone.mjs <standalone-or-app-folder>
//         (defaults to .next/standalone)

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".next/standalone");
const nm = path.join(root, "node_modules");
const store = path.join(nm, ".pnpm");

function fail(msg) {
  console.error(`flatten-standalone: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "server.js"))) {
  fail(`no server.js in ${root} — point this at the standalone/app folder`);
}

const isLink = (p) => {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
};

// List package folders directly inside a node_modules dir: [name, fullPath]
function packagesIn(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".pnpm" || entry === ".bin" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (entry.startsWith("@") && !isLink(full)) {
      for (const sub of fs.readdirSync(full)) {
        out.push([`${entry}/${sub}`, path.join(full, sub)]);
      }
    } else {
      out.push([entry, full]);
    }
  }
  return out;
}

// Remove a symlink/junction without following it.
function unlinkLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmSync(p, { recursive: true, force: true }); }
}

// Every symlink under `dir` (not following links).
function findLinks(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) acc.push(full);
    else if (entry.isDirectory()) findLinks(full, acc);
  }
  return acc;
}

// 1. Links outside node_modules (e.g. Turbopack's .next/node_modules/<pkg>-<hash>):
//    swap each for a real copy of what it points at, while targets still exist.
for (const link of findLinks(root)) {
  if (link.startsWith(nm + path.sep)) continue;
  let target;
  try { target = fs.realpathSync(link); } catch { fail(`broken link ${link}`); }
  unlinkLink(link);
  fs.cpSync(target, link, { recursive: true, dereference: true });
  console.log(`copied link ${path.relative(root, link)}`);
}

if (!fs.existsSync(store)) {
  const left = findLinks(root);
  if (left.length) fail(`symlinks remain and there is no .pnpm folder:\n${left.join("\n")}`);
  console.log("no .pnpm folder — node_modules is already flat, nothing to do");
  process.exit(0);
}

// 2. Drop the top-level pnpm links; the real folders get moved into place next.
for (const [, full] of packagesIn(nm)) {
  if (isLink(full)) unlinkLink(full);
}

// 3. Move every real package folder out of .pnpm/<id>/node_modules/ to the top.
//    (Entries there that are links point at other store entries — skip them.)
const placed = new Map(); // name -> store id it came from
for (const id of fs.readdirSync(store)) {
  const inner = path.join(store, id, "node_modules");
  for (const [name, full] of packagesIn(inner)) {
    if (isLink(full)) continue;
    const dest = path.join(nm, name);
    if (fs.existsSync(dest)) {
      if (placed.has(name)) {
        fail(
          `two versions of ${name} (${placed.get(name)} and ${id}) can't share a flat node_modules.\n` +
          `Use node-linker=hoisted in .npmrc for this build instead.`
        );
      }
      continue; // a real (non-pnpm) copy is already there
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
    placed.set(name, id);
  }
}

fs.rmSync(store, { recursive: true, force: true });

// 4. Nothing may still be a symlink, and the server's entry point must resolve.
const left = findLinks(root);
if (left.length) fail(`symlinks still present:\n${left.join("\n")}`);

for (const must of ["next", "react", "react-dom"]) {
  if (!fs.existsSync(path.join(nm, must, "package.json"))) {
    fail(`${must} is missing from node_modules after flattening`);
  }
}

console.log(`flattened ${placed.size} packages into ${path.relative(process.cwd(), nm) || nm}:`);
for (const name of [...placed.keys()].sort()) console.log(`  ${name}`);
