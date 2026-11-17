import type * as Fs from 'node:fs';
import type * as Inspection from '../main/lib/linux-writer-inspection';
import type * as ProcessCleanup from '../main/lib/worktree-process-cleanup';

// The app runs the Linux writer inspection on its bundled worker (CAN-6899).
// Jest runs sources, where that bundle does not exist, so Linux removals in
// tests inspect in-process with the same walk over the host's /proc. Tests
// of the worker itself set its entry, which takes precedence.
jest.mock('../main/lib/worktree-process-cleanup', () => {
  const cleanup = jest.requireActual<typeof ProcessCleanup>(
    '../main/lib/worktree-process-cleanup',
  );
  const { inspectLinuxWritersSync } = jest.requireActual<typeof Inspection>(
    '../main/lib/linux-writer-inspection',
  );
  const fs = jest.requireActual<typeof Fs>('node:fs');
  cleanup.__setLinuxWriterInspectorForTests((input) =>
    Promise.resolve(
      inspectLinuxWritersSync(input, {
        readFile: (path) => fs.readFileSync(path, 'utf8'),
        readlink: (path) => fs.readlinkSync(path),
        readdir: (path) => fs.readdirSync(path),
      }),
    ),
  );
  return cleanup;
});
