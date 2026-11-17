import {
  W5CommitLog,
  type W5CommitResult,
} from '@canopy/core-runtime/node/w5/commit-log';

// Match the grouped initial row, not a later lifecycle or receipt decision.
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
      result.status === 'committed' &&
      request.files.some(
        ({ path, contents }) =>
          path.endsWith('/project/worktrees.json') &&
          contents?.includes('"phase": "reserved"'),
      )
    )
      process.exit(73);
    return result;
  };
  return log;
};
