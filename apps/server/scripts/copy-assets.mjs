/**
 * Copies the non-TypeScript files the built server needs at runtime into `dist`.
 *
 * `tsc` only emits JavaScript, so a build that compiles cleanly still cannot boot: the migration
 * runner reads `dist/db/migrations/*.sql` next to the compiled file. That failure only appeared the
 * first time the project was built and started on a clean machine (CI), which is exactly the sort of
 * thing a compile step happily hides.
 *
 * Add new asset directories to `ASSETS` rather than teaching the runtime about two locations: a
 * deployment artifact must be self-contained.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const ASSETS = ['db/migrations'];

for (const asset of ASSETS) {
  const from = path.join(packageRoot, 'src', asset);
  const to = path.join(packageRoot, 'dist', asset);
  if (!existsSync(from)) {
    console.error(`copy-assets: missing source ${path.relative(packageRoot, from)}`);
    process.exitCode = 1;
    continue;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copy-assets: ${path.relative(packageRoot, from)} → ${path.relative(packageRoot, to)}`);
}
