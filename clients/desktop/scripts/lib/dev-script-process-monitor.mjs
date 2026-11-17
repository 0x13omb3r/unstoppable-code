import { isProcessId, isProcessTableId } from './dev-script-pid.mjs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { freemem, totalmem } from 'node:os';

const execFileAsync = promisify(execFile);
const PROCESS_SNAPSHOT_TIMEOUT_MS = 5000;
const MAX_PROBE_RETRY_MS = 8000;
export const DEFAULT_MAX_DESCENDANT_PROCESSES = 256;

function probeRetryDelay(failures, intervalMs) {
  return Math.min(
    MAX_PROBE_RETRY_MS,
    intervalMs * 2 ** Math.min(failures - 1, 20),
  );
}

export class DevScriptProbeError extends Error {
  constructor(probe, cause) {
    super(`Unable to sample ${probe} safely.`, { cause });
    this.name = 'DevScriptProbeError';
    this.code = cause?.code;
  }
}
const WINDOWS_PROCESS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress',
];
const POSIX_PROCESS_ARGS = ['-ww', '-axo', 'pid=,ppid=,pgid=,lstart=,args='];
export function parseWindowsProcesses(output) {
  const rows = JSON.parse(output);
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    pid: row.ProcessId,
    ppid: row.ParentProcessId,
    pgid: 0,
    startedAt: row.CreationDate,
    command: row.Name,
  }));
}

function windowsCreationTime(value) {
  if (typeof value !== 'string') return null;
  // Windows PowerShell serializes DateTime as /Date(epoch milliseconds)/;
  // newer PowerShell emits ISO. The optional offset does not change the epoch.
  const powershell = value.match(
    /^\/Date\((-?\d+)(?:[+-](?:[01]\d|2[0-3])[0-5]\d)?\)\/$/,
  );
  if (powershell) {
    const milliseconds = Number(powershell[1]);
    return Number.isSafeInteger(milliseconds) &&
      Number.isFinite(new Date(milliseconds).getTime())
      ? BigInt(milliseconds) * 10000n
      : null;
  }
  const iso = value.match(
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,7}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  );
  const milliseconds = iso ? Date.parse(value) : NaN;
  if (
    !Number.isFinite(milliseconds) ||
    new Date(`${iso[1]}T00:00:00Z`).toISOString().slice(0, 10) !== iso[1]
  )
    return null;
  // Keep DateTime's sub-millisecond precision when comparing ISO timestamps.
  return (
    BigInt(milliseconds) * 10000n +
    BigInt((iso[2] ?? '').padEnd(7, '0').slice(3))
  );
}

function sameWindowsIdentity(left, right) {
  const startedAt = windowsCreationTime(left?.startedAt);
  return (
    startedAt !== null && startedAt === windowsCreationTime(right?.startedAt)
  );
}
function checkedPosixProcesses(output) {
  const rows = parseProcessTable(output);
  if (rows.length === 0 || rows.some((row) => row.startedAt === null)) {
    throw new Error('Unable to count descendant processes safely.');
  }
  return rows;
}

// Only recognizable tooling, existing repository scripts, and known switches
// are retained. Arbitrary argv values (including shell/eval payloads) never log.
export function summarizeDevScriptArgv(argv, repoRoot = process.cwd()) {
  const tools = new Set([
    'node',
    'node.exe',
    'pnpm',
    'pnpm.cjs',
    'pnpm.cmd',
    'jest',
    'sh',
    'bash',
    'cmd.exe',
    'powershell.exe',
  ]);
  const switches =
    /^(?:--(?:test|listTests|findRelatedTests|runInBand|forceExit|json|ci|serial|parallel)|--(?:maxWorkers|test-concurrency|test-timeout)=\d+)$/;
  return argv
    .slice(0, 16)
    .map((argument, index) => {
      if (index === 0)
        return tools.has(basename(argument)) ? basename(argument) : '<process>';
      if (switches.test(argument)) return argument;
      const projected = relative(repoRoot, resolve(repoRoot, argument));
      if (
        projected &&
        !projected.startsWith(`..${sep}`) &&
        projected !== '..' &&
        !isAbsolute(projected) &&
        /\.(?:mjs|cjs|js|ts)$/.test(projected) &&
        existsSync(resolve(repoRoot, projected))
      ) {
        return projected.replaceAll('\\', '/');
      }
      return '<redacted>';
    })
    .join(' ');
}

export function parseProcessTable(output) {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const [, pidText, ppidText, pgidText, rest] = match;
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const pgid = Number(pgidText);
    // A row can become a signal or probe target, so its PID must be an
    // integer in 2..2147483647 (never PID 0 or PID 1). The guard's own row
    // stays as data; signal and probe boundaries refuse the guard's PID.
    // PPID and PGID are data only, but must still be in range.
    if (!isProcessId(pid) || !isProcessTableId(ppid) || !isProcessTableId(pgid))
      return [];
    const dated = rest.match(
      /^([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/,
    );
    return [
      {
        pid,
        ppid,
        pgid,
        startedAt: dated?.[1] ?? null,
        command: dated?.[2] ?? rest,
      },
    ];
  });
}

export function readProcessTable() {
  const windows = process.platform === 'win32';
  const output = execFileSync(
    windows ? 'powershell.exe' : 'ps',
    windows ? WINDOWS_PROCESS_ARGS : POSIX_PROCESS_ARGS,
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return windows
    ? parseWindowsProcesses(output)
    : checkedPosixProcesses(output);
}

export async function readProcessTableAsync({ signal } = {}) {
  try {
    const windows = process.platform === 'win32';
    const { stdout } = await execFileAsync(
      windows ? 'powershell.exe' : 'ps',
      windows ? WINDOWS_PROCESS_ARGS : POSIX_PROCESS_ARGS,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 4 * 1024 * 1024,
        signal,
      },
    );
    return windows
      ? parseWindowsProcesses(stdout)
      : checkedPosixProcesses(stdout);
  } catch (error) {
    throw new DevScriptProbeError('process table', error);
  }
}

export function parseVmStatAvailableMb(output) {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize)) return null;
  let pages = 0;
  for (const label of [
    'Pages free',
    'Pages inactive',
    'Pages speculative',
    'Pages purgeable',
  ]) {
    const value = output.match(
      new RegExp(`^${label}:\\s+(\\d+)\\.$`, 'm'),
    )?.[1];
    if (value === undefined) return null;
    pages += Number(value);
  }
  return (pages * pageSize) / 1024 ** 2;
}

export function createHostMemorySampler({
  platform = process.platform,
  runCommand = execFileAsync,
  readMemoryInfo = readFile,
  totalMemory = totalmem,
  freeMemory = freemem,
  now = () => performance.now(),
} = {}) {
  let vmFailures = 0;
  let nextVmAttempt = 0;
  const sampleVm = async ({ signal }) => {
    if (now() < nextVmAttempt) return '';
    try {
      const { stdout } = await runCommand('vm_stat', [], {
        encoding: 'utf8',
        timeout: 2000,
        signal,
      });
      if (
        parseCompressorMb(stdout) === null ||
        parseVmStatAvailableMb(stdout) === null
      )
        throw new DevScriptProbeError('macOS VM statistics');
      vmFailures = 0;
      nextVmAttempt = 0;
      return stdout;
    } catch (error) {
      if (signal?.aborted) throw error;
      nextVmAttempt = now() + probeRetryDelay(++vmFailures, 500);
      return '';
    }
  };
  return async ({ signal } = {}) => {
    const totalMb = totalMemory() / 1024 ** 2;
    if (platform === 'darwin') {
      // Neither probe blocks the event loop or the independent process budget.
      const [pressure, vm] = await Promise.allSettled([
        runCommand('memory_pressure', ['-Q'], {
          encoding: 'utf8',
          timeout: 2000,
          signal,
        }),
        sampleVm({ signal }),
      ]);
      const pressureOutput =
        pressure.status === 'fulfilled' ? pressure.value.stdout : '';
      const vmOutput = vm.status === 'fulfilled' ? vm.value : '';
      const percent = Number(
        pressureOutput.match(/memory free percentage:\s*(\d+)%/)?.[1],
      );
      const bytes = Number(pressureOutput.match(/The system has (\d+) /)?.[1]);
      const pressureValid =
        Number.isFinite(percent) && percent >= 0 && percent <= 100;
      const availableMb = pressureValid
        ? ((Number.isFinite(bytes) ? bytes / 1024 ** 2 : totalMb) * percent) /
          100
        : (parseVmStatAvailableMb(vmOutput) ?? freeMemory() / 1024 ** 2);
      return {
        availableMb: Math.floor(availableMb),
        compressorMb: parseCompressorMb(vmOutput),
        totalMb,
        degradedProbes: [
          ...(!pressureValid ? ['memory pressure'] : []),
          ...(!vmOutput ? ['macOS VM statistics'] : []),
        ],
      };
    }
    let availableMb = freeMemory() / 1024 ** 2;
    if (platform === 'linux') {
      try {
        const output = await readMemoryInfo('/proc/meminfo', {
          encoding: 'utf8',
          signal,
        });
        const match = output.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
        if (match) availableMb = Number(match[1]) / 1024;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return {
      availableMb: Math.floor(availableMb),
      compressorMb: null,
      totalMb,
    };
  };
}

export const readHostMemorySnapshot = createHostMemorySampler();

// Independent loops ensure an unusually slow ps cannot defer a memory stop.
// Each loop has only one probe in flight and all probes are aborted on stop.
export function startDevScriptWatchdog({
  sampleProcesses,
  sampleMemory,
  onFailure,
  onProbeError = () => {},
  onProbeRecovery = () => {},
  intervalMs,
  skipMemory = false,
}) {
  const abort = new AbortController();
  const timers = new Set();
  const pending = new Set();
  let stopped = false;
  const startLoop = (sample, probe) => {
    let failures = 0;
    const tick = () => {
      if (stopped) return;
      let nextDelay = intervalMs;
      const operation = Promise.resolve()
        .then(() => sample({ signal: abort.signal }))
        .then(() => {
          if (failures && !stopped) onProbeRecovery(probe);
          failures = 0;
        })
        .catch((error) => {
          if (stopped) return;
          if (
            error instanceof DevScriptProbeError ||
            error?.code === 'ETIMEDOUT'
          ) {
            nextDelay = probeRetryDelay(++failures, intervalMs);
            onProbeError(error, probe, { failures, retryMs: nextDelay });
          } else onFailure(error, probe);
        })
        .finally(() => {
          pending.delete(operation);
          if (stopped) return;
          const timer = setTimeout(() => {
            timers.delete(timer);
            tick();
          }, nextDelay);
          timers.add(timer);
        });
      pending.add(operation);
    };
    tick();
  };
  startLoop(sampleProcesses, 'process table');
  if (!skipMemory) startLoop(sampleMemory, 'host memory');
  return {
    async stop() {
      stopped = true;
      abort.abort();
      for (const timer of timers) clearTimeout(timer);
      await Promise.allSettled([...pending]);
    },
  };
}

export function hasProcessAncestor(pid, ancestorPid, processes) {
  const parents = new Map(processes.map((row) => [row.pid, row.ppid]));
  const seen = new Set();
  while (pid > 1 && !seen.has(pid)) {
    if (pid === ancestorPid) return true;
    seen.add(pid);
    pid = parents.get(pid) ?? 0;
  }
  return false;
}

function readChildPids(parentPid, { timeoutMs }) {
  const windows = process.platform === 'win32';
  try {
    const output = execFileSync(
      windows ? 'powershell.exe' : 'pgrep',
      windows
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object -ExpandProperty ProcessId`,
          ]
        : // macOS otherwise omits pgrep's own ancestors, including our caller.
          // Linux's -a means argv output instead, so it must remain PID-only there.
          [
            ...(process.platform === 'darwin' ? ['-a'] : []),
            '-P',
            String(parentPid),
          ],
      {
        encoding: 'utf8',
        timeout: Math.max(1, Math.ceil(timeoutMs)),
        maxBuffer: 64 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return output
      .trim()
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value))
      .map(Number);
  } catch (error) {
    if (!windows && error.status === 1) return [];
    throw error;
  }
}

// An ancestry-only fallback avoids the argv-heavy global snapshot during a
// probe outage, without trusting an unrelated process's inherited marker.
export function hasProcessAncestorFallback(
  pid,
  ancestorPid,
  {
    readChildren = readChildPids,
    now = () => performance.now(),
    timeoutMs = 5000,
    maxProcesses = 64,
  } = {},
) {
  if (pid === ancestorPid) return true;
  if (
    ![pid, ancestorPid].every(
      (value) => Number.isSafeInteger(value) && value > 1,
    )
  )
    return false;
  const deadline = now() + timeoutMs;
  const queue = [ancestorPid];
  const seen = new Set();
  try {
    for (
      let index = 0;
      index < queue.length && seen.size < maxProcesses;
      index++
    ) {
      const parent = queue[index];
      if (seen.has(parent)) continue;
      seen.add(parent);
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return false;
      for (const child of readChildren(parent, { timeoutMs: remainingMs })) {
        if (!Number.isSafeInteger(child) || child < 2) continue;
        if (child === pid) return true;
        if (!seen.has(child)) queue.push(child);
      }
    }
  } catch {
    // If neither ancestry probe works, do not lend a live owner's lease.
  }
  return false;
}

export function ownedProcesses(
  processes,
  rootPid,
  {
    platform = process.platform,
    processGroup = true,
    knownProcesses = [],
    rootIdentity = null,
    rootExited = false,
  } = {},
) {
  const windows = platform === 'win32';
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const previous = new Map(knownProcesses.map((row) => [row.pid, row]));
  const originalRoot = rootIdentity ?? previous.get(rootPid);
  const currentRoot = processes.find((row) => row.pid === rootPid);
  const rootReused =
    currentRoot &&
    (originalRoot
      ? windows
        ? !sameWindowsIdentity(originalRoot, currentRoot)
        : originalRoot.startedAt !== currentRoot.startedAt
      : rootExited);
  const rootUnknown =
    windows && windowsCreationTime(currentRoot?.startedAt) === null;
  const owned = new Set(rootReused || rootUnknown ? [] : [rootPid]);
  const matchesPrevious = (row) =>
    previous.has(row.pid) &&
    (windows
      ? sameWindowsIdentity(previous.get(row.pid), row)
      : previous.get(row.pid).startedAt === row.startedAt);
  // The spawned group remains ours after its leader exits, even if that
  // happens before the first sample. A surviving group keeps its PGID reserved.
  const groupStillOwned = !rootReused;
  for (const row of processes) {
    if (
      (!windows && processGroup && groupStillOwned && row.pgid === rootPid) ||
      matchesPrevious(row)
    )
      owned.add(row.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        if (windows) {
          const parentTime = windowsCreationTime(
            byPid.get(row.ppid)?.startedAt,
          );
          const childTime = windowsCreationTime(row.startedAt);
          // Win32 retains stale parent PIDs: a recycled parent cannot have
          // created an older child, and unknown chronology proves nothing.
          if (
            parentTime === null ||
            childTime === null ||
            childTime < parentTime
          )
            continue;
        }
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return processes.filter((row) => owned.has(row.pid));
}

// Called with a fresh snapshot: only still-matching process identities are
// eligible, including survivors whose original leader has already exited.
export function windowsCleanupTargets(processes, knownProcesses) {
  const previous = new Map(knownProcesses.map((row) => [row.pid, row]));
  return processes
    .filter((row) => sameWindowsIdentity(previous.get(row.pid), row))
    .map((row) => row.pid);
}

export function parseCompressorMb(output) {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const pages = Number(
    output.match(/^Pages occupied by compressor:\s*(\d+)\./m)?.[1],
  );
  return Number.isFinite(pageSize) && Number.isFinite(pages)
    ? (pages * pageSize) / 1024 ** 2
    : null;
}

export function evaluateDevScriptWatchdog(
  {
    availableMb,
    compressorMb = null,
    totalMb = totalmem() / 1024 ** 2,
    descendantProcesses,
  },
  {
    memoryFloorMb = 2048,
    compressorLimitPercent = 35,
    maxDescendantProcesses = DEFAULT_MAX_DESCENDANT_PROCESSES,
    skipMemory = false,
  } = {},
) {
  if (!Number.isSafeInteger(descendantProcesses) || descendantProcesses < 0)
    return 'Unable to count descendant processes safely.';
  if (descendantProcesses > maxDescendantProcesses)
    return `Descendant process budget exceeded (${descendantProcesses} > ${maxDescendantProcesses}).`;
  if (skipMemory) return null;
  if (!Number.isFinite(availableMb) || availableMb < 0)
    return 'Unable to sample available host memory safely.';
  if (availableMb < memoryFloorMb)
    return `Available host memory collapsed (${Math.floor(availableMb)} MB < ${memoryFloorMb} MB).`;
  if (
    compressorMb !== null &&
    (!Number.isFinite(compressorMb) || compressorMb < 0)
  )
    return 'Unable to sample macOS compressor safely.';
  if (
    compressorMb !== null &&
    (compressorMb / totalMb) * 100 >= compressorLimitPercent
  )
    return `macOS compressor reached its safety limit (${Math.round((compressorMb / totalMb) * 100)}% >= ${compressorLimitPercent}%).`;
  return null;
}
