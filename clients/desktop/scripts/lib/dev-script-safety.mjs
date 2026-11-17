import { isProcessId, isSignalablePid } from './dev-script-pid.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hasProcessAncestor,
  hasProcessAncestorFallback,
  parseVmStatAvailableMb,
  readProcessTable,
  summarizeDevScriptArgv,
} from './dev-script-process-monitor.mjs';

export const DEFAULT_MEMORY_PRESSURE_THRESHOLD_MB = 4096;
export const MEMORY_PRESSURE_THRESHOLD_ENV =
  'CANOPY_DEV_SCRIPT_MEMORY_PRESSURE_THRESHOLD_MB';
export const MEMORY_SKIP_FLAG = '--danger-skip-memory-pressure-safety-check';
export const CONCURRENCY_SKIP_FLAG = '--danger-skip-concurrency-safety-lock';
export const NO_GUARD_WAIT_FLAG = '--no-guard-wait';
export const GUARD_WAIT_DELAYS_MS = Object.freeze([
  30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000,
]);

export const CANOPY_DEV_STATE_ROOT = join(tmpdir(), 'canopy-dev');
export const DEV_SUITE_SAFETY_LOCK_ROOT = join(
  tmpdir(),
  'canopy-dev-suite-safety-locks',
);
const DEFAULT_LOCK_ROOT = DEV_SUITE_SAFETY_LOCK_ROOT;
const HOLDER_FILE = 'holder.json';
const INCOMPLETE_HOLDER_GRACE_MS = 30_000;
const MUTATION_LOCK_STALE_GRACE_MS = 1_000;
const MUTATION_LOCK_RETRY_MS = 10;
const MUTATION_LOCK_TIMEOUT_MS = 5_000;
export const DEV_SUITE_LEASE_ENV = 'CANOPY_DEV_SUITE_LEASE';
export const DEV_SUITE_CONCURRENCY_ENV = 'CANOPY_DEV_SUITE_MAX_RUN_CONCURRENCY';
const HEAVY_SUITE_CONFIG = {
  concurrencyEnv: DEV_SUITE_CONCURRENCY_ENV,
  defaultMaxConcurrency: 1,
  // Reuse the perf/E2E namespace so already-running older guards also exclude us.
  lockNamespace: 'desktop-runtime',
};
const SUITE_CONFIG = Object.fromEntries(
  ['performance', 'e2e', 'unit', 'lint'].map((suite) => [
    suite,
    HEAVY_SUITE_CONFIG,
  ]),
);

class DevScriptGuardBlockedError extends Error {
  constructor(message, guard) {
    super(message);
    this.guard = guard;
  }
}

function isTruthyEnvironmentValue(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && !['0', 'false', 'no', 'off'].includes(normalized);
}

export function isCiEnvironment(env = process.env) {
  return (
    isTruthyEnvironmentValue(env.CI) ||
    isTruthyEnvironmentValue(env.GITHUB_ACTIONS)
  );
}

export function readPositiveIntegerSetting(env, name, defaultValue) {
  const raw = env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readAvailableMemoryFromProc() {
  if (process.platform !== 'linux') return null;
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(
      /^MemAvailable:\s+(\d+)\s+kB$/m,
    );
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function readAvailableMemoryFromVmStat() {
  if (process.platform !== 'darwin') return null;
  try {
    const pressureOutput = execFileSync('memory_pressure', ['-Q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    const totalBytes = Number(
      pressureOutput.match(/The system has (\d+) /)?.[1],
    );
    const availablePercent = Number(
      pressureOutput.match(/memory free percentage:\s*(\d+)%/)?.[1],
    );
    if (Number.isFinite(totalBytes) && Number.isFinite(availablePercent)) {
      return (totalBytes * availablePercent) / 100 / 1024 / 1024;
    }
  } catch {
    // Fall through to vm_stat on older or restricted macOS hosts.
  }
  try {
    const output = execFileSync('vm_stat', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return parseVmStatAvailableMb(output);
  } catch {
    return null;
  }
}

export function getAvailableMemoryMb() {
  return Math.floor(
    readAvailableMemoryFromProc() ??
      readAvailableMemoryFromVmStat() ??
      freemem() / 1024 / 1024,
  );
}

function processIsAlive(pid) {
  // Holder metadata comes from a file. A value that is not an integer in
  // 2..2147483647 is malformed: it names no live process, so its lease is
  // stale. The guard never probes it.
  if (!isProcessId(pid)) return false;
  // This process is alive. Find it by its own PID, never by a signal probe.
  if (pid === process.pid) return true;
  if (!isSignalablePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function holderFilePath(slotPath) {
  return join(slotPath, HOLDER_FILE);
}

function readHolder(slotPath) {
  try {
    return JSON.parse(readFileSync(holderFilePath(slotPath), 'utf8'));
  } catch {
    return null;
  }
}

function removeStaleSlot(slotPath, isProcessAlive) {
  const holder = readHolder(slotPath);
  if (holder) {
    if (isProcessAlive(holder.pid)) return false;
    // The supervisor owns teardown. Its diagnostic child/survivor metadata
    // must not strand a machine-wide slot after that owner has died, even
    // when process-table probes are unavailable or a PID has been reused.
  } else {
    try {
      if (
        Date.now() - statSync(slotPath).mtimeMs <
        INCOMPLETE_HOLDER_GRACE_MS
      ) {
        return false;
      }
    } catch {
      return true;
    }
  }
  rmSync(slotPath, { recursive: true, force: true });
  return true;
}

function listActiveHolders(suitePath, isProcessAlive) {
  if (!existsSync(suitePath)) return [];
  const holders = [];
  for (const entry of readdirSync(suitePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('slot-')) continue;
    const slotPath = join(suitePath, entry.name);
    if (removeStaleSlot(slotPath, isProcessAlive)) continue;
    const holder = readHolder(slotPath);
    holders.push(
      holder ?? {
        slot: entry.name,
        status: 'initializing',
      },
    );
  }
  return holders;
}

function formatHolder(holder) {
  if (holder.status === 'initializing') {
    return `  - ${holder.slot}: holder metadata is still initializing`;
  }
  // Older worktrees wrote raw argv into this shared namespace.
  const command = summarizeDevScriptArgv(
    typeof holder.command === 'string' ? holder.command.split(/\s+/) : [],
  );
  return `  - pid=${holder.pid} parentPid=${holder.parentPid} command=${command} startedAt=${holder.startedAt}`;
}

function concurrencyLimitError(suite, maxConcurrency, holders) {
  const config = SUITE_CONFIG[suite];
  return new DevScriptGuardBlockedError(
    `Cannot start the ${suite} suite: host-global maximum concurrency ${maxConcurrency} is already in use.\n` +
      `${holders.map(formatHolder).join('\n')}\n` +
      `Set ${config.concurrencyEnv} to a larger positive integer only when the host can safely support it, or pass ${CONCURRENCY_SKIP_FLAG} to bypass this safeguard.`,
    'concurrency',
  );
}

async function acquireMutationLease(suitePath) {
  const mutationPath = join(suitePath, '.mutation-lock');
  const deadline = Date.now() + MUTATION_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(mutationPath);
      try {
        writeFileSync(
          holderFilePath(mutationPath),
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
          'utf8',
        );
      } catch (error) {
        rmSync(mutationPath, { recursive: true, force: true });
        throw error;
      }
      return {
        release() {
          rmSync(mutationPath, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const holder = readHolder(mutationPath);
      let oldEnoughToReclaim = false;
      try {
        oldEnoughToReclaim =
          Date.now() - statSync(mutationPath).mtimeMs >=
          MUTATION_LOCK_STALE_GRACE_MS;
      } catch {
        continue;
      }
      if (oldEnoughToReclaim && (!holder || !processIsAlive(holder.pid))) {
        rmSync(mutationPath, { recursive: true, force: true });
        continue;
      }
      await delay(MUTATION_LOCK_RETRY_MS);
    }
  }
  throw new Error(
    `Timed out while coordinating concurrency slots in ${suitePath}.`,
  );
}

export async function acquireSuiteConcurrencyLease({
  suite,
  maxConcurrency,
  lockRoot = DEFAULT_LOCK_ROOT,
  holder = {},
  isProcessAlive = processIsAlive,
}) {
  if (!SUITE_CONFIG[suite]?.concurrencyEnv) {
    throw new Error(
      `Suite ${JSON.stringify(suite)} does not use a concurrency lease.`,
    );
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('maxConcurrency must be a positive integer.');
  }

  const suitePath = join(lockRoot, SUITE_CONFIG[suite].lockNamespace ?? suite);
  mkdirSync(suitePath, { recursive: true, mode: 0o700 });
  const mutationLease = await acquireMutationLease(suitePath);
  const token = randomUUID();
  const metadata = {
    token,
    suite,
    pid: holder.pid ?? process.pid,
    parentPid: holder.parentPid ?? process.ppid,
    command: summarizeDevScriptArgv(holder.argv ?? process.argv),
    hostname: holder.hostname ?? hostname(),
    startedAt: holder.startedAt ?? new Date().toISOString(),
  };

  try {
    const activeHolders = listActiveHolders(suitePath, isProcessAlive);
    if (activeHolders.length >= maxConcurrency) {
      throw concurrencyLimitError(suite, maxConcurrency, activeHolders);
    }
    for (let index = 1; index <= maxConcurrency; index += 1) {
      const slotPath = join(suitePath, `slot-${index}`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          mkdirSync(slotPath, { mode: 0o700 });
          try {
            writeFileSync(
              holderFilePath(slotPath),
              `${JSON.stringify(metadata, null, 2)}\n`,
              { encoding: 'utf8', mode: 0o600 },
            );
          } catch (error) {
            rmSync(slotPath, { recursive: true, force: true });
            throw error;
          }
          let released = false;
          return {
            metadata,
            slotPath,
            recordChild(childPid, processGroupId) {
              metadata.childPid = childPid;
              metadata.processGroupId = processGroupId;
              if (readHolder(slotPath)?.token === token) {
                writeFileSync(
                  holderFilePath(slotPath),
                  `${JSON.stringify(metadata, null, 2)}\n`,
                  { mode: 0o600 },
                );
              }
            },
            retainSurvivors(survivors) {
              metadata.cleanupUnconfirmed = true;
              metadata.survivors = survivors.map(({ pid, startedAt }) => ({
                pid,
                startedAt,
              }));
              if (readHolder(slotPath)?.token === token) {
                writeFileSync(
                  holderFilePath(slotPath),
                  `${JSON.stringify(metadata, null, 2)}\n`,
                  { mode: 0o600 },
                );
              }
            },
            async release() {
              if (metadata.cleanupUnconfirmed) return;
              if (released) return;
              released = true;
              if (readHolder(slotPath)?.token === token) {
                rmSync(slotPath, { recursive: true, force: true });
              }
            },
          };
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          if (!removeStaleSlot(slotPath, isProcessAlive)) break;
        }
      }
    }

    throw new DevScriptGuardBlockedError(
      `Cannot start the ${suite} suite: no free concurrency slot was found despite ${activeHolders.length} active holder(s) and a limit of ${maxConcurrency}.`,
      'concurrency',
    );
  } finally {
    mutationLease.release();
  }
}

export function inheritedSuiteLease({
  env = process.env,
  lockRoot = DEFAULT_LOCK_ROOT,
  isProcessAlive = processIsAlive,
  processTable = readProcessTable,
  ancestorFallback = hasProcessAncestorFallback,
} = {}) {
  // A nested wrapper shares only a live ancestor's lease. An inherited env
  // marker alone must never disable machine-wide exclusion.

  if (env[DEV_SUITE_LEASE_ENV]) {
    try {
      const marker = JSON.parse(env[DEV_SUITE_LEASE_ENV]);
      if (/^slot-[1-9]\d*$/.test(marker.slot)) {
        const slotPath = join(
          lockRoot,
          HEAVY_SUITE_CONFIG.lockNamespace,
          marker.slot,
        );
        const metadata = readHolder(slotPath);
        if (
          metadata?.token === marker.token &&
          metadata?.pid === marker.pid &&
          (isProcessAlive ?? processIsAlive)(marker.pid)
        ) {
          let related;
          try {
            related = hasProcessAncestor(
              process.pid,
              marker.pid,
              processTable(),
            );
          } catch {
            related = ancestorFallback(process.pid, marker.pid);
          }
          if (related)
            return { metadata, slotPath, inherited: true, async release() {} };
        }
      }
    } catch {
      // A missing, stale or malformed marker falls back to normal acquisition.
    }
  }

  return null;
}

export async function applyDevScriptSafety({
  suite,
  env = process.env,
  forceCiBypass = false,
  skipConcurrencySafetyLock = false,
  skipMemoryPressureSafetyCheck = false,
  availableMemoryMb = getAvailableMemoryMb,
  lockRoot = DEFAULT_LOCK_ROOT,
  holder,
  isProcessAlive,
  processTable = readProcessTable,
} = {}) {
  const config = SUITE_CONFIG[suite];
  if (config === undefined) {
    throw new Error(`Unknown guarded suite ${JSON.stringify(suite)}.`);
  }
  if (forceCiBypass || isCiEnvironment(env)) {
    return { ciBypass: true, memory: { skipped: true }, lease: null };
  }

  const inheritedLease = inheritedSuiteLease({
    env,
    lockRoot,
    isProcessAlive,
    processTable,
  });

  let memory;
  if (skipMemoryPressureSafetyCheck) {
    memory = { skipped: true };
  } else {
    const thresholdMb = readPositiveIntegerSetting(
      env,
      MEMORY_PRESSURE_THRESHOLD_ENV,
      DEFAULT_MEMORY_PRESSURE_THRESHOLD_MB,
    );
    const availableMb = Math.floor(await availableMemoryMb());
    if (!Number.isFinite(availableMb) || availableMb < 0) {
      throw new Error('Unable to determine available host memory safely.');
    }
    if (availableMb < thresholdMb) {
      throw new DevScriptGuardBlockedError(
        `Cannot start the ${suite} suite: only ${availableMb} MB of host memory is available; ${thresholdMb} MB is required. ` +
          `Adjust ${MEMORY_PRESSURE_THRESHOLD_ENV} only for an intentionally different host threshold, or pass ${MEMORY_SKIP_FLAG} to bypass this safeguard.`,
        'memory-pressure',
      );
    }
    memory = { skipped: false, availableMb, thresholdMb };
  }

  let lease = inheritedLease;
  if (config && !lease && !skipConcurrencySafetyLock) {
    const maxConcurrency = readPositiveIntegerSetting(
      env,
      config.concurrencyEnv,
      config.defaultMaxConcurrency,
    );
    lease = await acquireSuiteConcurrencyLease({
      suite,
      maxConcurrency,
      lockRoot,
      holder,
      ...(isProcessAlive ? { isProcessAlive } : {}),
    });
  }
  return { ciBypass: false, memory, lease };
}

function formatGuardWaitDuration(milliseconds) {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = milliseconds / 1_000;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function defaultGuardWaitLogger(message) {
  process.stderr.write(`[dev-script-safety] ${message}\n`);
}

export async function applyDevScriptSafetyWithWait({
  noGuardWait = false,
  guardWaitDelaysMs = GUARD_WAIT_DELAYS_MS,
  sleep = delay,
  logGuardWait = defaultGuardWaitLogger,
  signal,
  ...safetyOptions
} = {}) {
  let completedPolls = 0;

  while (true) {
    signal?.throwIfAborted();
    try {
      return await applyDevScriptSafety(safetyOptions);
    } catch (error) {
      if (noGuardWait || !(error instanceof DevScriptGuardBlockedError)) {
        throw error;
      }

      const nextDelayMs = guardWaitDelaysMs[completedPolls];
      if (completedPolls === 0 && nextDelayMs !== undefined) {
        logGuardWait(
          `The ${error.guard} guard blocked this run. Entering the guard polling loop. Pass ${NO_GUARD_WAIT_FLAG} to fail immediately instead. ` +
            `Next check in ${formatGuardWaitDuration(nextDelayMs)}.\n${error.message}`,
        );
      } else if (nextDelayMs !== undefined) {
        logGuardWait(
          `Guard poll ${completedPolls} was unsuccessful. Next check in ${formatGuardWaitDuration(nextDelayMs)}.\n${error.message}`,
        );
      } else {
        logGuardWait(
          `Guard poll ${completedPolls} was unsuccessful. No further checks will run; failing now.\n${error.message}`,
        );
        throw error;
      }

      completedPolls += 1;
      await sleep(nextDelayMs, undefined, { signal });
    }
  }
}

export function parseGuardedCommandArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator === -1) {
    throw new Error('Expected `--` before the guarded command.');
  }
  const wrapperArgs = argv.slice(0, separator);
  const rawCommand = argv.slice(separator + 1);
  const suiteIndex = wrapperArgs.indexOf('--suite');
  const suite = suiteIndex === -1 ? null : wrapperArgs[suiteIndex + 1];
  if (!suite || SUITE_CONFIG[suite] === undefined) {
    throw new Error('--suite must be one of: performance, e2e, unit, lint.');
  }
  const skipConcurrencySafetyLock = rawCommand.includes(CONCURRENCY_SKIP_FLAG);
  const skipMemoryPressureSafetyCheck = rawCommand.includes(MEMORY_SKIP_FLAG);
  const noGuardWait = rawCommand.includes(NO_GUARD_WAIT_FLAG);
  if (
    wrapperArgs.includes('--reject-safety-flags') &&
    (skipConcurrencySafetyLock || skipMemoryPressureSafetyCheck || noGuardWait)
  ) {
    throw new Error(
      'This guarded command does not support safety bypass or no-wait flags. Use the individual guarded check entrypoints instead.',
    );
  }
  const commandParts = rawCommand.filter(
    (argument) =>
      argument !== CONCURRENCY_SKIP_FLAG &&
      argument !== MEMORY_SKIP_FLAG &&
      argument !== NO_GUARD_WAIT_FLAG,
  );
  if (commandParts.length === 0) throw new Error('Missing guarded command.');
  // pnpm appends `--test-shard=<i>/<n>` after `node --test`'s file list, where
  // Node silently ignores it; move it right after `--test`.
  const isShard = (argument) => argument.startsWith('--test-shard=');
  const rest = commandParts.filter((argument) => !isShard(argument));
  const afterTest = rest.indexOf('--test') + 1;
  const command =
    afterTest > 0
      ? [
          ...rest.slice(0, afterTest),
          ...commandParts.filter(isShard),
          ...rest.slice(afterTest),
        ]
      : commandParts;
  return {
    suite,
    command: command[0],
    commandArgs: command.slice(1),
    noGuardWait,
    skipConcurrencySafetyLock,
    skipMemoryPressureSafetyCheck,
  };
}
