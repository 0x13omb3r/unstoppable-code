import { BrowserProfileRepository } from '../../repository';

const [root, action, operationId, checkpoint] = process.argv.slice(2);
const repository = new BrowserProfileRepository(root, {
  checkpoint: async (stage): Promise<void> => {
    if (stage !== checkpoint) return;
    await new Promise<void>((resolve) => {
      process.once('message', () => resolve());
      process.send?.({ checkpoint: stage });
    });
  },
});

async function run(): Promise<unknown> {
  if (action === 'task')
    return repository.ensureTask(
      { kind: 'worktree', projectId: 'project', worktreeId: 'topic' },
      '2026-01-01',
      operationId,
    );
  if (action === 'read') return repository.list();
  return repository.createNamed(operationId, { displayName: operationId });
}

void run().then(
  (result) => {
    process.send?.({ result }, () => process.disconnect());
  },
  (error: unknown) => {
    process.send?.(
      {
        error:
          error instanceof Error && 'code' in error
            ? error.code
            : String(error),
      },
      () => process.disconnect(),
    );
  },
);
