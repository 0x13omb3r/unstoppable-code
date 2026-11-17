import { z } from 'zod';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PersonalProjectOperationSchema,
  type PersonalProjectOperation,
} from '@canopy/protocol/organizations';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException } from './type-guards';

const JournalOperationSchema = PersonalProjectOperationSchema.transform(
  (operation) => ({
    ...operation,
    projects: operation.projects.map((project) => {
      if (
        project.reason === undefined ||
        (project.outcome === 'repositories-not-in-team' && !project.reasonCode)
      )
        return project;
      // Only repository refusal names are needed for replay. Earlier builds
      // also stored arbitrary error messages, including repository excerpts.
      const safe = { ...project };
      delete safe.reason;
      return safe;
    }),
  }),
);
const JournalSchema = z.object({
  version: z.literal(1),
  operations: z.array(JournalOperationSchema),
});
export interface PersonalOrganizationUpgradeJournal {
  read(): Promise<PersonalProjectOperation[]>;
  update(operation: PersonalProjectOperation): Promise<void>;
  remove(
    key: Pick<PersonalProjectOperation, 'accountId' | 'operationId'>,
  ): Promise<void>;
}
const writesByPath = new Map<string, Promise<void>>();
export function createPersonalOrganizationUpgradeJournal(
  path: () => string,
): PersonalOrganizationUpgradeJournal {
  async function read(): Promise<PersonalProjectOperation[]> {
    try {
      const parsed = JournalSchema.safeParse(
        JSON.parse(await readFile(path(), 'utf8')),
      );
      if (!parsed.success) throw new Error('Upgrade journal is unreadable');
      return parsed.data.operations;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError)
        throw new Error('Upgrade journal is unreadable');
      throw error;
    }
  }
  function edit(
    key: Pick<PersonalProjectOperation, 'accountId' | 'operationId'>,
    replacement?: PersonalProjectOperation,
  ): Promise<void> {
    const filePath = path();
    const write = (writesByPath.get(filePath) ?? Promise.resolve()).then(
      async () => {
        const current = await read();
        const retained = current.filter(
          (entry) =>
            !(
              entry.accountId === key.accountId &&
              entry.operationId === key.operationId
            ),
        );
        // Keep every active/refused recovery record; prune only old completed work.
        const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
        const operations = replacement
          ? retained.filter(
              (entry) =>
                entry.terminalReason !== undefined ||
                entry.projects.some(
                  (project) =>
                    project.outcome === 'pending' ||
                    project.outcome === 'converted-private',
                ) ||
                Date.parse(entry.updatedAt) >= cutoff,
            )
          : retained;
        if (replacement)
          operations.push(JournalOperationSchema.parse(replacement));
        await mkdir(dirname(path()), { recursive: true });
        await writeFileAtomically(
          path(),
          JSON.stringify({ version: 1, operations }),
          { mode: 0o600 },
        );
      },
    );
    const settled = write.catch(() => {});
    writesByPath.set(filePath, settled);
    void settled.then(() => {
      if (writesByPath.get(filePath) === settled) writesByPath.delete(filePath);
    });
    return write;
  }
  return {
    async read(): Promise<PersonalProjectOperation[]> {
      await writesByPath.get(path());
      return read();
    },
    update: (operation) => edit(operation, operation),
    remove: (key) => edit(key),
  };
}
