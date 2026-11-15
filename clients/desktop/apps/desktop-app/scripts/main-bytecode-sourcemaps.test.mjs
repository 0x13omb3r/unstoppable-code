import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import {
  flattenBytecodeMap,
  prepareMainSourcemaps,
  removeMainUploadFiles,
} from '../../../scripts/lib/main-sourcemaps.mjs';

const require = createRequire(import.meta.url);
test('Electron bytecode and fallback exception frames resolve to the original TypeScript lines', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'main-map-golden-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'probe.ts');
  const lines = [
    'export function first() {',
    '  const unicode = "astral 🐈 UTF-16";',
    '  throw new Error("main map probe " + unicode);',
    '}',
    'export function second() {',
    '  first();',
    '}',
    'second();',
  ];
  await writeFile(entry, lines.join('\n'));
  const out = join(root, 'out');
  // Use the production plugin, compiler, loader and the repo-pinned Electron.
  const { build } = await import('electron-vite');
  const config = {
    main: {
      root: resolve('.'),
      esbuild: { keepNames: true, charset: 'utf8' },
      build: {
        outDir: out,
        sourcemap: 'hidden',
        minify: true,
        bytecode: { removeBundleJS: false },
        rollupOptions: {
          input: entry,
          output: { entryFileNames: 'index.js', inlineDynamicImports: true },
        },
      },
    },
  };
  const configPath = join(root, 'electron.vite.config.mjs');
  await writeFile(configPath, 'export default ' + JSON.stringify(config));
  await build({ configFile: configPath });
  const electron = require('electron');
  const run = spawnSync(electron, [join(out, 'index.js')], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.notEqual(run.status, 0);
  const frames = [...run.stderr.matchAll(/index\.jsc:(\d+):(\d+)/g)];
  assert.ok(frames.length >= 3, run.stderr);
  const code = await readFile(join(out, '_index.js'), 'utf8');
  assert.ok(
    code.includes('🐈'),
    'Probe must exercise an emitted non-BMP UTF-16 pair',
  );
  const raw = JSON.parse(await readFile(join(out, 'index.js.map'), 'utf8'));
  const converted = flattenBytecodeMap(code, raw);
  const trace = new TraceMap(converted);
  const positions = frames.slice(0, 3).map((frame) =>
    originalPositionFor(trace, {
      line: Number(frame[1]),
      column: Number(frame[2]) - 1,
    }),
  );
  assert.deepEqual(
    positions.map((position) => position.line),
    [3, 6, 8],
  );
  for (const position of positions)
    assert.ok(position.source.endsWith('/probe.ts'), position.source);
  // The unconverted map must not silently report plausible but wrong source lines.
  assert.notDeepEqual(
    frames.slice(0, 3).map(
      (frame) =>
        originalPositionFor(new TraceMap(raw), {
          line: Number(frame[1]),
          column: Number(frame[2]) - 1,
        }).line,
    ),
    [3, 6, 8],
  );
  const fallback = spawnSync(electron, [join(out, '_index.js')], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const fallbackFrames = [
    ...fallback.stderr.matchAll(/_index\.js:(\d+):(\d+)/g),
  ];
  assert.ok(fallbackFrames.length >= 3, fallback.stderr);
  assert.deepEqual(
    fallbackFrames.slice(0, 3).map(
      (frame) =>
        originalPositionFor(new TraceMap(raw), {
          line: Number(frame[1]),
          column: Number(frame[2]) - 1,
        }).line,
    ),
    [3, 6, 8],
  );
  const bytecodeId = '11111111-1111-4111-8111-111111111111';
  const fallbackId = '22222222-2222-4222-8222-222222222222';
  await writeFile(
    join(out, 'index.js.map'),
    JSON.stringify({
      ...raw,
      chunk_id: fallbackId,
      x_canopy_bytecode_chunk_id: bytecodeId,
    }),
  );
  const upload = join(root, 'upload');
  assert.equal(prepareMainSourcemaps(out, upload), 2);
  assert.equal(
    JSON.parse(await readFile(join(upload, 'index.jsc.js.map'), 'utf8'))
      .chunk_id,
    bytecodeId,
  );
  assert.equal(
    JSON.parse(await readFile(join(upload, '_index.js.map'), 'utf8')).chunk_id,
    fallbackId,
  );
  await writeFile(join(upload, 'unrelated.txt'), 'not an upload artifact');
  removeMainUploadFiles(upload);
  assert.deepEqual(await readdir(upload), ['unrelated.txt']);
});
