#!/usr/bin/env node
/**
 * Photograph the desktop app for the website.
 *
 * The Tauri window cannot be driven programmatically, so this serves the app's
 * web build with a stubbed IPC (`stub.js`), drives it into each state with
 * `?shot=<name>`, and captures the result with headless Chrome.
 *
 * Everything it changes is put back in a `finally`, so an interrupted run does
 * not leave the desktop app pointing at a stub.
 *
 *   node apps/site/scripts/screenshots/capture.mjs [name…]
 *
 * With no arguments it captures every shot.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');

const DESKTOP = resolve(repo, 'apps/desktop');
const INDEX_HTML = resolve(DESKTOP, 'index.html');
const STUB_SOURCE = resolve(here, 'stub.js');
const STUB_TARGET = resolve(DESKTOP, 'public/__shot-stub.js');
const OUT_DIR = resolve(repo, 'apps/site/public/screenshots');

const PORT = 5599;
const SCRIPT_TAG = '<script src="/__shot-stub.js"></script>';

/** Every screenshot the site uses, and the state `stub.js` drives for it. */
const SHOTS = [
  'editor',
  'tasks',
  'diagram',
  'conflict',
  'sync',
  'links',
  'history',
  'palette',
  'code',
];

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const WIDTH = 1280;
const HEIGHT = 840;

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'ignore', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`dev server never came up at ${url}`);
}

async function main() {
  const wanted = process.argv.slice(2);
  const shots = wanted.length > 0 ? wanted : SHOTS;

  const unknown = shots.filter((shot) => !SHOTS.includes(shot));
  if (unknown.length > 0) {
    throw new Error(`unknown shot(s): ${unknown.join(', ')}. Known: ${SHOTS.join(', ')}`);
  }

  if (!existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME}. Set CHROME to your Chrome or Chromium binary.`);
  }

  const originalHtml = await readFile(INDEX_HTML, 'utf8');
  let vite;

  try {
    await mkdir(dirname(STUB_TARGET), { recursive: true });
    await copyFile(STUB_SOURCE, STUB_TARGET);
    await writeFile(
      INDEX_HTML,
      originalHtml.replace(
        '<script type="module" src="/src/main.tsx"></script>',
        `${SCRIPT_TAG}\n    <script type="module" src="/src/main.tsx"></script>`,
      ),
    );

    vite = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
      cwd: DESKTOP,
      stdio: 'ignore',
    });
    await waitForServer(`http://localhost:${PORT}/`);

    await mkdir(OUT_DIR, { recursive: true });

    for (const shot of shots) {
      const out = resolve(OUT_DIR, `${shot}.png`);
      process.stdout.write(`capturing ${shot}… `);
      await run(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        // Chrome headless reports a dark colour scheme by default, and the app
        // follows the system. The site's own palette is light, so the shots are
        // taken light to match. `1` is light, `2` is dark.
        '--blink-settings=preferredColorScheme=1',
        `--window-size=${WIDTH},${HEIGHT}`,
        // The stub does its work over several seconds of timers; virtual time
        // lets Chrome run them all before the shutter, without a real wait.
        '--virtual-time-budget=12000',
        '--force-device-scale-factor=2',
        `--screenshot=${out}`,
        `http://localhost:${PORT}/?shot=${shot}`,
      ]);
      process.stdout.write('done\n');
    }

    console.log(`\nWrote ${shots.length} screenshot(s) to ${OUT_DIR}`);
  } finally {
    vite?.kill();
    await writeFile(INDEX_HTML, originalHtml);
    await rm(STUB_TARGET, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
