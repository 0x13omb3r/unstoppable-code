import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import {
  inspectLinuxWritersSync,
  type LinuxWriterInspectionInput,
  type LinuxWriterInspectionResult,
} from './linux-writer-inspection';

interface InspectionWorkerData {
  input: LinuxWriterInspectionInput;
  /** Where /proc is read from; tests point it at a fixture tree. */
  procRoot: string;
}

const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

function isOwnerEntry(
  value: unknown,
): value is LinuxWriterInspectionInput['owners'][number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const pid: unknown = value[0];
  const owner: unknown = value[1];
  return (
    isPid(pid) &&
    typeof owner === 'object' &&
    owner !== null &&
    'identity' in owner &&
    typeof owner.identity === 'string' &&
    'worktreeRelated' in owner &&
    typeof owner.worktreeRelated === 'boolean'
  );
}

function isInspectionWorkerData(value: unknown): value is InspectionWorkerData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('procRoot' in value) || typeof value.procRoot !== 'string')
    return false;
  if (!('input' in value)) return false;
  const { input } = value;
  return (
    typeof input === 'object' &&
    input !== null &&
    'rootPid' in input &&
    isPid(input.rootPid) &&
    'worktreePaths' in input &&
    Array.isArray(input.worktreePaths) &&
    input.worktreePaths.every((path) => typeof path === 'string') &&
    'owners' in input &&
    Array.isArray(input.owners) &&
    input.owners.every(isOwnerEntry) &&
    'budgetMs' in input &&
    typeof input.budgetMs === 'number'
  );
}

function inspect(data: unknown): LinuxWriterInspectionResult {
  // Unreadable input proves nothing: the removal is refused as incomplete.
  if (!isInspectionWorkerData(data))
    return {
      ok: false,
      reason: 'incomplete',
      message: 'App-owned writer inspection received unreadable input.',
    };
  const { input, procRoot } = data;
  const at = (path: string): string =>
    path.startsWith('/proc/')
      ? `${procRoot}${path.slice('/proc'.length)}`
      : path;
  return inspectLinuxWritersSync(input, {
    readFile: (path) => readFileSync(at(path), 'utf8'),
    readlink: (path) => readlinkSync(at(path)),
    readdir: (path) => readdirSync(at(path)),
  });
}

parentPort?.postMessage(inspect(workerData));
