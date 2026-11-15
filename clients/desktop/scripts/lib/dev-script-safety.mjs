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
const SUITE_CONFIG = {
  performance: {
    concurrencyEnv: 'CANOPY_DEV_PERF_SUITE_MAX_RUN_CONCURRENCY',
    defaultMaxConcurrency: 1,
    lockNamespace: 'desktop-runtime',
  },
  e2e: {
    concurrencyEnv: 'CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY',
    defaultMaxConcurrency: 1,
    lockNamespace: 'desktop-runtime',
  },
  unit: null,
  lint: null,
};

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
    throw new Error(
      `${name} must be a positive integer; received ${JSON.stringify(raw)}.`,
    );
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
    const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
    if (!Number.isFinite(pageSize)) return null;
    const pageLabels = [
      'Pages free',
      'Pages inactive',
      'Pages speculative',
      'Pages purgeable',
    ];
    let pages = 0;
    for (const label of pageLabels) {
      const count = Number(
        output.match(new RegExp(`^${label}:\\s+(\\d+)\\.$`, 'm'))?.[1] ?? 0,
      );
      pages += count;
    }
    return (pages * pageSize) / 1024 / 1024;
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
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
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
  return `  - pid=${holder.pid} parentPid=${holder.parentPid} cwd=${holder.cwd} command=${holder.command} startedAt=${holder.startedAt}`;
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
  mkdirSync(suitePath, { recursive: true });
  const mutationLease = await acquireMutationLease(suitePath);
  const token = randomUUID();
  const metadata = {
    token,
    suite,
    pid: holder.pid ?? process.pid,
    parentPid: holder.parentPid ?? process.ppid,
    cwd: holder.cwd ?? process.cwd(),
    command: holder.command ?? process.argv.join(' '),
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
          mkdirSync(slotPath);
          try {
            writeFileSync(
              holderFilePath(slotPath),
              `${JSON.stringify(metadata, null, 2)}\n`,
              'utf8',
            );
          } catch (error) {
            rmSync(slotPath, { recursive: true, force: true });
            throw error;
          }
          let released = false;
          return {
            metadata,
            slotPath,
            async release() {
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
} = {}) {
  const config = SUITE_CONFIG[suite];
  if (config === undefined) {
    throw new Error(`Unknown guarded suite ${JSON.stringify(suite)}.`);
  }
  if (forceCiBypass || isCiEnvironment(env)) {
    return { ciBypass: true, memory: { skipped: true }, lease: null };
  }

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

  let lease = null;
  if (config && !skipConcurrencySafetyLock) {
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
