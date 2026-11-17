/** The largest process ID any supported host assigns (2^31 - 1). */
const MAX_PROCESS_ID = 2147483647;

/**
 * Whether `pid` is in the range of a real, ordinary process ID: an integer
 * in 2..MAX_PROCESS_ID. PID 0, PID 1 and negative values (process groups or
 * broadcast) are not.
 */
export function isProcessId(pid) {
  return Number.isSafeInteger(pid) && pid >= 2 && pid <= MAX_PROCESS_ID;
}

/**
 * Whether `pid` may be the target of a signal or a probe: a process ID
 * (see isProcessId) that is not this process.
 */
export function isSignalablePid(pid, selfPid = process.pid) {
  return isProcessId(pid) && pid !== selfPid;
}

/** Whether `value` is a process-table PPID or PGID field: 0..MAX_PROCESS_ID. */
export function isProcessTableId(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROCESS_ID;
}
