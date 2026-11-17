import { availableParallelism } from 'node:os';
import {
  getAvailableMemoryMb,
  isCiEnvironment,
  readPositiveIntegerSetting,
} from './dev-script-safety.mjs';

export const LOCAL_JEST_MAX_WORKERS_ENV = 'CANOPY_DEV_JEST_MAX_WORKERS';
export const DEFAULT_LOCAL_JEST_MAX_WORKERS = 6;
// Budget half of available host memory, allowing 1 GiB per Jest worker.
const AVAILABLE_MB_PER_WORKER = 2048;

/** Leave CI's existing worker selection unchanged. */
export function getLocalJestMaxWorkers({
  env = process.env,
  cores = availableParallelism,
  availableMemoryMb = getAvailableMemoryMb,
} = {}) {
  if (isCiEnvironment(env)) return undefined;
  const ceiling = readPositiveIntegerSetting(
    env,
    LOCAL_JEST_MAX_WORKERS_ENV,
    DEFAULT_LOCAL_JEST_MAX_WORKERS,
  );
  if (ceiling > DEFAULT_LOCAL_JEST_MAX_WORKERS) {
    throw new Error(`${LOCAL_JEST_MAX_WORKERS_ENV} must be at most 6.`);
  }
  const memoryMb = availableMemoryMb();
  const coreCount = cores();
  if (!Number.isFinite(memoryMb) || memoryMb < 0) {
    throw new Error('Unable to determine available memory for Jest workers.');
  }
  if (!Number.isSafeInteger(coreCount) || coreCount < 1) {
    throw new Error('Unable to determine available cores for Jest workers.');
  }
  return Math.max(
    1,
    Math.min(
      ceiling,
      Math.floor(memoryMb / AVAILABLE_MB_PER_WORKER),
      coreCount - 1,
    ),
  );
}

/** Explicit CLI caps also bound Jest's listTests haste-map pool. */
export function withLocalJestWorkerCap(args, options) {
  const limit = getLocalJestMaxWorkers(options);
  if (limit === undefined) return [...args];
  const result = [];
  let requestedLimit = limit;
  let runInBand = null;
  let serialFlag = '--runInBand';
  const executionOptions = () =>
    runInBand === true
      ? [serialFlag]
      : [
          ...(runInBand === false ? ['--runInBand=false'] : []),
          `--maxWorkers=${requestedLimit}`,
        ];
  const lowerRequestedLimit = (value) => {
    const numeric = /^\d+%?$/.test(value)
      ? Number(value.replace(/%$/, ''))
      : NaN;
    if (!Number.isSafeInteger(numeric) || numeric < 1) {
      // Jest accepts parseInt prefixes and some short/dashed spellings can
      // defeat a later CLI cap. Reject malformed values before launching it.
      throw new Error(
        'Jest maxWorkers must be a positive integer or percentage.',
      );
    }
    if (value.endsWith('%')) {
      const coreCount = (options?.cores ?? availableParallelism)();
      requestedLimit = Math.min(
        requestedLimit,
        Math.max(1, Math.floor((coreCount * numeric) / 100)),
      );
    } else requestedLimit = Math.min(requestedLimit, numeric);
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const optionName = argument.split('=', 1)[0];
    if (argument === '--') {
      return [...result, ...executionOptions(), ...args.slice(index)];
    }
    const serial = argument.match(
      /^(--runInBand|--run-in-band|--i|-i)(?:=(.*))?$/,
    );
    if (serial) {
      let value = serial[2];
      if (
        value === undefined &&
        (args[index + 1] === 'true' || args[index + 1] === 'false')
      ) {
        value = args[++index];
      }
      if (value !== undefined && value !== 'true' && value !== 'false')
        throw new Error('Jest runInBand must be a boolean.');
      runInBand = value !== 'false';
      serialFlag = serial[1];
      continue;
    }
    if (
      argument === '--no-runInBand' ||
      argument === '--no-run-in-band' ||
      argument === '--no-i'
    ) {
      runInBand = false;
      continue;
    }
    if (
      argument === '--maxWorkers' ||
      argument === '--max-workers' ||
      argument === '--w' ||
      argument === '-w'
    ) {
      lowerRequestedLimit(args[index + 1] ?? '');
      index += 1;
    } else if (/^(?:--maxWorkers|--max-workers|--w|-w)=/.test(argument)) {
      lowerRequestedLimit(argument.slice(argument.indexOf('=') + 1));
    } else if (/^--no-(?:w|maxWorkers|max-workers)(?:=|$)/i.test(argument)) {
      lowerRequestedLimit('');
    } else if (/^-w.+/.test(argument)) {
      lowerRequestedLimit(argument.slice(2));
    } else if (/^-[^-].+/.test(optionName) && /[wi]/i.test(optionName)) {
      // Yargs expands groups such as -uw32 before resolving worker options;
      // its alias precedence can defeat a later long-form cap.
      throw new Error(
        'Grouped Jest short options containing w or i are unsupported. Use separate --maxWorkers and --runInBand options.',
      );
    } else {
      result.push(argument);
    }
  }
  return [...result, ...executionOptions()];
}
