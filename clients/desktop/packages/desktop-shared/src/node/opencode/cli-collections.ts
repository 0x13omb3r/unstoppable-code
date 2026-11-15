import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND } from '@canopy/brand/current';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isRecord } from '@canopy/execution-engine/node/lib/type-guards';
import {
  decideResourceContext,
  isInstallReceipt,
} from '@canopy/execution-engine/lib/resource-context-policy';
import type { ChatTabPluginSelections } from '../../types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { unionPluginSelections } from '../../lib/effective-plugin-selections';
import type { CliOpenCodeAccount } from './cli-account';

const collectionSchema = z.object({
  version: z.literal(2),
  collection: z.object({
    id: z.string(),
    skills: z.array(
      z.object({ sourceId: z.string().min(1), skillName: z.string().min(1) }),
    ),
    plugins: z.array(
      z.object({
        marketplaceId: z.string().min(1),
        pluginName: z.string().min(1),
      }),
    ),
    mcpServers: z
      .array(
        z.object({ serverId: z.string().min(1), configId: z.string().min(1) }),
      )
      .default([]),
    sharedSource: z.unknown().optional(),
  }),
});

/** Read provenance without repairing it or taking over the desktop writer. */
async function authorizeCollection(
  id: string,
  shared: boolean,
  owner: WorkOwner,
  account: CliOpenCodeAccount | undefined,
  signal: AbortSignal,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(
        join(getCanopyDataDir(), 'resource-install-receipts.json'),
        'utf8',
      ),
    );
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    raw = { version: 1, byAccount: {} };
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.byAccount))
    throw new Error('Collection provenance is unreadable.');
  const matches = [];
  for (const [accountId, rows] of Object.entries(raw.byAccount)) {
    if (!Array.isArray(rows) || !rows.every(isInstallReceipt))
      throw new Error('Collection provenance is unreadable.');
    for (const receipt of rows) {
      if (
        receipt.family === 'collections' &&
        receipt.localResourceIds?.includes(id)
      )
        matches.push({ accountId, receipt });
    }
  }
  if (matches.length > 1 || (shared && matches.length !== 1))
    throw new Error('Collection provenance is unavailable or ambiguous.');
  const binding = matches[0];
  if (!binding) {
    if (
      !decideResourceContext({
        resource: { owner: { type: 'user', id: 'local', name: null } },
        invocation: { mode: 'background', context: owner },
      }).allow
    )
      throw new Error(
        'This Collection is unavailable in the workflow context.',
      );
    return;
  }
  if (!account)
    throw new Error('This Collection requires an authenticated CLI account.');
  const snapshot = await account.snapshot(signal);
  const { receipt } = binding;
  if (
    receipt.uninstalledLocalResourceIds?.includes(id) ||
    (receipt.sourceKind !== 'public-share' &&
      binding.accountId !== snapshot.account.id)
  )
    throw new Error('This Collection is unavailable to the CLI account.');
  const path =
    receipt.sourceKind === 'public-share'
      ? `/api/v1/${BRAND.web.apiNamespace}/public-shares/collections/${encodeURIComponent(receipt.remoteId)}`
      : `/api/v1/${BRAND.web.apiNamespace}/collections/${encodeURIComponent(receipt.remoteId)}`;
  const response = await account.request(path, signal);
  if (!isRecord(response))
    throw new Error('The Collection authority returned an invalid response.');
  const detail = response;
  if (
    (receipt.sourceKind === 'public-share' ? detail.externalId : detail.id) !==
    receipt.remoteId
  )
    throw new Error('The shared Collection identity changed.');
  if (
    !decideResourceContext(
      {
        resource: {
          owner:
            receipt.sourceKind === 'public-share'
              ? { type: 'user', id: 'public', name: null }
              : detail.owner,
          provenance: receipt,
        },
        invocation: { mode: 'background', context: owner },
      },
      { personalOrganizationId: snapshot.personalOrganizationId ?? null },
    ).allow
  )
    throw new Error('This Collection is unavailable in the workflow context.');
}

export async function expandCliOpenCodeCollections(
  selections: ChatTabPluginSelections,
  owner: WorkOwner,
  account: CliOpenCodeAccount | undefined,
  signal: AbortSignal,
): Promise<ChatTabPluginSelections> {
  const ids = [
    ...new Set([...selections.collectionIds, ...(selections.bundleIds ?? [])]),
  ];
  let expanded = { ...selections, collectionIds: ids, bundleIds: undefined };
  for (const id of ids) {
    signal.throwIfAborted();
    if (!/^[a-f0-9-]+$/.test(id)) throw new Error('Invalid Collection id.');
    const raw: unknown = JSON.parse(
      await readFile(
        join(getCanopyDataDir(), 'collections', `collection-${id}.json`),
        'utf8',
      ),
    );
    const { collection } = collectionSchema.parse(raw);
    if (collection.id !== id)
      throw new Error('The Collection identity changed.');
    await authorizeCollection(
      id,
      collection.sharedSource !== undefined,
      owner,
      account,
      signal,
    );
    expanded = {
      ...unionPluginSelections(expanded, {
        collectionIds: [],
        skillRefs: collection.skills,
        pluginRefs: collection.plugins,
        mcpServerRefs: collection.mcpServers,
      }),
      bundleIds: undefined,
    };
  }
  signal.throwIfAborted();
  return expanded;
}
