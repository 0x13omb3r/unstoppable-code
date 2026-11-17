// Real worker body and host durability, faulted only after the grouped row's
// SQLite decision. Restart uses the unchanged production worker entry.
import { dirname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { worktreeListProcessLock } from '@canopy/core-platform/w5-process-file-lock';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import { createNodeW5Durability } from '@canopy/core-runtime/node/w5/commit-log/node-durability';
import { runW5CommitLogWorker } from '@canopy/core-runtime/node/w5/commit-log/worker';
import {
  W5CommitLog,
  type W5CommitResult,
} from '@canopy/core-runtime/node/w5/commit-log';
import { isDaemonW5CommitLogWorkerData } from '../../../../../../core-daemon/src/w5-commit-log-worker-data';

const port = parentPort;
const data: unknown = workerData;
if (!port || !isDaemonW5CommitLogWorkerData(data))
  throw new Error('Parent worker data required');
let targetPath: string | undefined;
const open = W5CommitLog.open.bind(W5CommitLog);
W5CommitLog.open = (
  ...args: Parameters<typeof W5CommitLog.open>
): W5CommitLog => {
  const log = open(...args);
  const commit = log.commit.bind(log);
  log.commit = (request): W5CommitResult => {
    const result = commit(request);
    if (
      request.operation === 'core.worktree.create' &&
      result.status === 'committed'
    ) {
      const file = request.files.find(
        ({ path, contents }) =>
          path === `${data.root}/project/worktrees.json` &&
          contents?.includes('"phase": "reserved"'),
      );
      if (file) {
        targetPath = file.path;
      }
    }
    return result;
  };
  return log;
};
const os = hostOperatingSystem();
const durability = createNodeW5Durability(os, {
  flushDirectory: (folder) => flushDirectory(folder, { os }),
});
void runW5CommitLogWorker(port, data, {
  os,
  processLock: worktreeListProcessLock(data.dataRoot ?? dirname(data.root)),
  confinedReader: windowsW5ConfinedFileReader(os, data.confinementAddon),
  durability: {
    ...durability,
    writeFileDurably: async (path, contents): Promise<void> => {
      if (path === targetPath) {
        targetPath = undefined;
        throw Object.assign(new Error('CAN4477 grouped application ENOSPC'), {
          code: 'ENOSPC',
        });
      }
      await durability.writeFileDurably(path, contents);
    },
  },
});
