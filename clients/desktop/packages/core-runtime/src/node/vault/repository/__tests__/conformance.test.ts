import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFakeSecretProtection } from '../../../../platform/testing/fake-secret-protection';
import { openVaultReadRepository } from '../read-repository';
import { VAULT_STORE_FILE } from '../store';
import { storeFolder } from './store-fixtures';
import { createDaemonVault } from '../../daemon-vault';
import { runVaultRepositoryConformance } from '../../../../vault/testing';
import { createDurableVaultSubject } from './durable-subject';

// The shared V0 kit, unchanged, on the durable store (CAN-5448).
runVaultRepositoryConformance({ describe, it }, createDurableVaultSubject);

// Startup refuses incompatible stores before any slot admission, without reset.
describe('native startup durable refusal', () => {
  it.each(['older', 'newer', 'same-version-modified'] as const)(
    'preserves schema and header semantics after %s schema refusal',
    async (damage) => {
      const dir = storeFolder();
      const kit = createFakeSecretProtection({ backend: 'macos_keychain' });
      try {
        const store = await dir.opened();
        const opened = await openVaultReadRepository({
          store,
          slots: kit.port,
          signal: new AbortController().signal,
        });
        if (opened.kind !== 'opened') throw new Error('Initialization refused');
        opened.vault.dispose();
        store.close();
        const path = join(dir.folder, VAULT_STORE_FILE);
        const db = new DatabaseSync(path);
        if (damage === 'same-version-modified')
          db.exec('ALTER TABLE vault_entries ADD COLUMN foreign_column TEXT');
        else
          db.prepare(
            "UPDATE vault_meta SET value = ? WHERE key = 'schema_version'",
          ).run(damage === 'older' ? '0' : '2');
        const before = {
          schema: db
            .prepare(
              'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
            )
            .all(),
          meta: db.prepare('SELECT * FROM vault_meta ORDER BY key').all(),
          header: db.prepare('SELECT * FROM vault_header').all(),
        };
        db.close();
        const write = jest.spyOn(kit.port, 'writeKeySlot');
        expect(await dir.open()).toEqual({
          kind: 'store_unavailable',
          step: 'schema',
        });
        const status = jest.spyOn(kit.port, 'status');
        const vault = createDaemonVault({
          secureDataRoot: dir.root,
          platform: { os: 'darwin', secureFiles: dir.secureFiles },
          slots: kit.port,
        });
        await vault.service.start?.(new AbortController().signal);
        expect(vault.status().protection.state).toBe('unavailable');
        expect(write).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        await vault.dispose();
        const after = new DatabaseSync(path);
        try {
          expect({
            schema: after
              .prepare(
                'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
              )
              .all(),
            meta: after.prepare('SELECT * FROM vault_meta ORDER BY key').all(),
            header: after.prepare('SELECT * FROM vault_header').all(),
          }).toEqual(before);
        } finally {
          after.close();
        }
      } finally {
        dir.remove();
      }
    },
  );

  it('a copied foreign vault refuses key use without creating a replacement slot', async () => {
    const source = storeFolder();
    const target = storeFolder();
    const sourceKit = createFakeSecretProtection({ backend: 'macos_keychain' });
    const targetKit = createFakeSecretProtection({ backend: 'macos_keychain' });
    try {
      const store = await source.opened();
      const opened = await openVaultReadRepository({
        store,
        slots: sourceKit.port,
        signal: new AbortController().signal,
      });
      if (opened.kind !== 'opened') throw new Error('Initialization refused');
      const header = store.header;
      opened.vault.dispose();
      store.close();
      mkdirSync(target.folder, { mode: 0o700 });
      copyFileSync(
        join(source.folder, VAULT_STORE_FILE),
        join(target.folder, VAULT_STORE_FILE),
      );
      const copied = await target.opened();
      const write = jest.spyOn(targetKit.port, 'writeKeySlot');
      try {
        const read = await openVaultReadRepository({
          store: copied,
          slots: targetKit.port,
          signal: new AbortController().signal,
        });
        if (read.kind !== 'opened') throw new Error('Metadata open refused');
        expect(read.vault.repository.status().protection.state).toBe(
          'key_missing',
        );
        expect(copied.header).toEqual(header);
        expect(write).not.toHaveBeenCalled();
        read.vault.dispose();
      } finally {
        copied.close();
      }
    } finally {
      source.remove();
      target.remove();
    }
  });
});
