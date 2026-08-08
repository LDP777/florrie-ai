/**
 * Launch Chromium for the behaviour checks.
 *
 * Playwright pins a browser build per version and refuses to start if that
 * exact revision is absent. CI images and this sandbox both routinely carry a
 * *different* revision, and `npx playwright install` is not always available or
 * wanted mid-build. A gesture test that silently stops running is worse than no
 * gesture test, so fall back to whatever Chromium is actually on disk.
 */
import { chromium } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', '/ms-playwright'].filter(Boolean);

function findChromium() {
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue;
      for (const bin of [
        join(root, dir, 'chrome-linux', 'chrome'),
        join(root, dir, 'chrome-linux', 'headless_shell'),
        join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(root, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]) if (existsSync(bin)) return bin;
    }
  }
  return null;
}

export async function launch(opts = {}) {
  try {
    return await chromium.launch(opts);
  } catch (err) {
    const exe = findChromium();
    if (!exe) throw err;
    return chromium.launch({ ...opts, executablePath: exe });
  }
}
