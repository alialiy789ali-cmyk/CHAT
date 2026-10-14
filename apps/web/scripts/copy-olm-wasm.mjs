/**
 * Copies the Olm WebAssembly payload into `public/` where the browser can fetch it.
 *
 * The Olm package ships `olm.wasm` next to its glue code, but a browser cannot read
 * `node_modules` — the file has to be served from the app's own origin. Copying it here keeps the
 * dependency the single source of truth (no vendored binary in git) while making the file
 * available at `/olm.wasm` in development and in production builds.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('@matrix-org/olm/package.json'));
const source = path.join(packageRoot, 'olm.wasm');
const targetDir = path.resolve(import.meta.dirname, '../public');
const target = path.join(targetDir, 'olm.wasm');

if (!existsSync(source)) {
  console.error(`[copy-olm-wasm] missing ${source} — run npm install first`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

// Re-copy when the dependency is newer, so an upgrade can never leave a stale wasm behind.
const needsCopy = !existsSync(target) || statSync(source).mtimeMs > statSync(target).mtimeMs;
if (needsCopy) {
  copyFileSync(source, target);
  console.log(`[copy-olm-wasm] ${path.relative(process.cwd(), target)} (${Math.round(statSync(target).size / 1024)} KB)`);
} else {
  console.log('[copy-olm-wasm] up to date');
}
