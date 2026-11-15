import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { OWNED_CHILD_FILE } from '../../supervision/owned-child';

const root = path.resolve(__dirname, '../../../../..');

export async function loadOwnedChildProbe(): Promise<object> {
  let file = process.env.CANOPY_OWNED_CHILD_PROBE;
  if (!file) {
    if (process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1')
      throw new Error(
        'Owned-child acceptance requires CANOPY_OWNED_CHILD_PROBE',
      );
    // Loaded addons stay mapped on Windows; keep local builds private to this run.
    const scratch = await mkdtemp(path.join(tmpdir(), 'owned-child-probe-'));
    file = path.join(scratch, 'owned-child-probe.node');
    await promisify(execFile)(
      process.execPath,
      [
        path.join(root, 'scripts/build-owned-child.mjs'),
        '--out',
        path.join(scratch, OWNED_CHILD_FILE),
        '--probe-out',
        file,
      ],
      { cwd: root, windowsHide: true, timeout: 540_000, maxBuffer: 1 << 24 },
    );
  }
  const loaded = { exports: {} };
  process.dlopen(loaded, path.resolve(root, file));
  return loaded.exports;
}
