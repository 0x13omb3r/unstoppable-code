import {
  isOrgProjectRepository,
  hasCompleteOrgProjectRepositories,
  type OrgProjectRepository,
} from '@canopy/protocol/org-projects';
import { basename, isAbsolute, join, dirname, normalize } from 'node:path';
import {
  normalizeWorkspaceOwner,
  normalizeWorkspaceOwnershipTransfer,
} from '@canopy/execution-engine/lib/workspace-owner';
import type {
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';

export type SetupPhase =
  | 'claimed'
  | 'cloning'
  | 'validated'
  | 'promoted'
  | 'bound'
  | 'completing'
  /**
   * The claim lapsed before completion landed (CAN-3129). The journal's
   * operation and fence are the latest claim this device holds; the next step
   * asks the server to reclaim exactly that claim, re-binds under the answer
   * and completes. Never detached: the instance is still this checkout's.
   */
  | 'reclaiming'
  | 'done'
  | 'failed'
  | 'cancelled';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface SetupJournalV1 {
  version: 1;
  /**
   * The journal's own identity: its file name and its staging directory are
   * derived from it. A reclaim replaces `operationId`, so nothing local may be
   * keyed by the server's operation. Journals written before this field read
   * with `journalId === operationId`, which is how they were named.
   */
  journalId: string;
  projectId: string;
  organizationId: string;
  instanceId: string;
  operationId: string;
  idempotencyKey: string;
  /** The per-attempt nonce the idempotency key was derived from. */
  attemptNonce: string;
  fencingGeneration: number;
  localWorkspaceId: string;
  destinationRoot: string;
  finalPath: string;
  stagingPath: string;
  phase: SetupPhase;
  errorCode?: string;
  updatedAt: string;
  /**
   * Present when this attempt converts the existing workspace
   * `localWorkspaceId` in place (CAN-3415) instead of cloning a new one. Its
   * `finalPath` is that workspace's checkout and nothing is staged. An
   * attempt that does not finish is rolled back to Personal, restoring the
   * conversion record the workspace had before.
   */
  conversion?: { previousOwnershipTransfer?: WorkspaceOwnershipTransfer };
  /** Existing checkout adoption: nothing at `finalPath` was created by setup. */
  adoption?: { createdRepo?: true };
  /**
   * A new organization copy of a multi-repo share (CAN-4856). `finalPath` is
   * the root the fork staged, unindexed; the bind registers it as a bound
   * workspace with these repositories. The fork owns the staged root: only the
   * marker-proven sweep removal ever deletes it on this journal's behalf.
   */
  copy?: SetupJournalCopy;
}

/** A copy repository: `repository` is `null` for a snapshot (no holder). */
export interface SetupJournalCopyRepository {
  relativePath: string;
  name: string;
  repository: OrgProjectRepository | null;
}

/** A repository a bound copy registers (CAN-4856); the marker's own entry. */
export type BoundCopyRepository = SetupJournalCopyRepository;

export interface SetupJournalCopy {
  /** The 64-hex creation key; ties the journal to its staged root. */
  creationKey: string;
  name: string;
  repositories: SetupJournalCopyRepository[];
}

/**
 * A multi-repo root's child path, as `multiRepoSetupRelativePath` writes it.
 * Every reader validates against this one pattern.
 */
export const MULTI_REPO_CHILD_RELATIVE_PATH =
  /^repos\/r[0-9]{2}-[a-z0-9_-]{1,64}$/;

/** A malformed marker rejects the whole journal; it never reads as plain v1. */
function normalizeSetupJournalCopy(value: unknown): SetupJournalCopy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const { creationKey, name, repositories } = record;
  if (
    typeof creationKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(creationKey) ||
    typeof name !== 'string' ||
    !name.trim() ||
    !Array.isArray(repositories) ||
    repositories.length < 1 ||
    repositories.length > 32
  )
    return null;
  const entries: unknown[] = repositories;
  const paths = new Set<string>();
  const normalized: SetupJournalCopyRepository[] = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('relativePath' in entry) ||
      typeof entry.relativePath !== 'string' ||
      !MULTI_REPO_CHILD_RELATIVE_PATH.test(entry.relativePath) ||
      paths.has(entry.relativePath) ||
      !('name' in entry) ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      !('repository' in entry) ||
      // Identities need not be unique: two share repositories can resolve to
      // one holder project.
      (entry.repository !== null && !isOrgProjectRepository(entry.repository))
    )
      return null;
    paths.add(entry.relativePath);
    normalized.push({
      relativePath: entry.relativePath,
      name: entry.name,
      repository: entry.repository,
    });
  }
  return { creationKey, name, repositories: normalized };
}

export interface MultiRepoSetupRepository {
  repository: OrgProjectRepository;
  relativePath: string;
  validated: boolean;
}

/** Fresh setup only: a v2 journal cannot authorize adoption or conversion. */
export interface SetupJournalV2 extends Omit<
  SetupJournalV1,
  'version' | 'conversion' | 'adoption' | 'copy'
> {
  version: 2;
  accountId: string;
  deviceId: string;
  installationGeneration: number;
  definitionRevision: number;
  projectName: string;
  repositories: MultiRepoSetupRepository[];
  conversion?: never;
  adoption?: never;
  copy?: never;
}
export type SetupJournal = SetupJournalV1 | SetupJournalV2;

export function setupOwner(
  journal: Pick<
    SetupJournal,
    'organizationId' | 'projectId' | 'instanceId' | 'fencingGeneration'
  >,
): WorkspaceOwnerBinding {
  const owner = normalizeWorkspaceOwner({
    type: 'organization',
    organizationId: journal.organizationId,
    projectId: journal.projectId,
    instanceId: journal.instanceId,
    bindingGeneration: journal.fencingGeneration,
  });
  if (!owner) throw new Error('Invalid organization workspace binding');
  return owner;
}
export function isSetupPhase(value: unknown): value is SetupPhase {
  return [
    'claimed',
    'cloning',
    'validated',
    'promoted',
    'bound',
    'completing',
    'reclaiming',
    'done',
    'failed',
    'cancelled',
  ].some((phase) => phase === value);
}
/**
 * A new organization copy's journal (CAN-4856) is written as version 3 and
 * read back as a v1 journal carrying `copy`. A build without CAN-4856 accepts
 * only versions 1 and 2, so it keeps the file as unreadable instead of
 * dropping `copy` and resuming the copy as plain single-repo setup.
 */
const COPY_JOURNAL_FILE_VERSION = 3;

/** Corrupt journals never authorize filesystem mutations. */
export function normalizeSetupJournal(value: unknown): SetupJournal | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 2
  ) {
    if ('conversion' in value || 'adoption' in value || 'copy' in value)
      return null;
    const base = normalizeSetupJournalV1({ ...value, version: 1 }, false);
    if (
      !base ||
      !('accountId' in value) ||
      typeof value.accountId !== 'string' ||
      !value.accountId ||
      !('deviceId' in value) ||
      typeof value.deviceId !== 'string' ||
      !UUID.test(value.deviceId) ||
      !('installationGeneration' in value) ||
      typeof value.installationGeneration !== 'number' ||
      !Number.isSafeInteger(value.installationGeneration) ||
      value.installationGeneration < 0 ||
      !('definitionRevision' in value) ||
      typeof value.definitionRevision !== 'number' ||
      !Number.isSafeInteger(value.definitionRevision) ||
      value.definitionRevision < 1 ||
      !('projectName' in value) ||
      typeof value.projectName !== 'string' ||
      !value.projectName.trim() ||
      !('repositories' in value) ||
      !Array.isArray(value.repositories) ||
      value.repositories.length < 1 ||
      value.repositories.length > 32
    )
      return null;
    const repositories: MultiRepoSetupRepository[] = [];
    const paths = new Set<string>();
    const identities = new Set<string>();
    const entries: unknown[] = value.repositories;
    for (const entry of entries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('repository' in entry) ||
        !isOrgProjectRepository(entry.repository) ||
        !('relativePath' in entry) ||
        typeof entry.relativePath !== 'string' ||
        !MULTI_REPO_CHILD_RELATIVE_PATH.test(entry.relativePath) ||
        !('validated' in entry) ||
        typeof entry.validated !== 'boolean'
      )
        return null;
      const identity =
        `${entry.repository.host}/${entry.repository.providerRepoId ?? `${entry.repository.owner}/${entry.repository.name}`}`.toLowerCase();
      if (paths.has(entry.relativePath) || identities.has(identity))
        return null;
      paths.add(entry.relativePath);
      identities.add(identity);
      repositories.push({
        repository: entry.repository,
        relativePath: entry.relativePath,
        validated: entry.validated,
      });
    }
    if (
      !hasCompleteOrgProjectRepositories({
        repositories: repositories.map((entry) => entry.repository),
        repository: repositories[0]?.repository ?? null,
        repositoryCount: repositories.length,
        repositoriesComplete: true,
        materializationVersion: 1,
        revision: value.definitionRevision,
      })
    )
      return null;
    const { conversion, adoption, copy, ...freshBase } = base;
    if (conversion || adoption || copy) return null;
    return {
      ...freshBase,
      version: 2,
      accountId: value.accountId,
      deviceId: value.deviceId,
      installationGeneration: value.installationGeneration,
      definitionRevision: value.definitionRevision,
      projectName: value.projectName,
      repositories,
    };
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === COPY_JOURNAL_FILE_VERSION
  ) {
    const journal = normalizeSetupJournalV1({ ...value, version: 1 }, true);
    return journal?.copy === undefined ? null : journal;
  }
  return normalizeSetupJournalV1(value, false);
}

/** A journal as it is written to disk; see {@link COPY_JOURNAL_FILE_VERSION}. */
export function serializeSetupJournal(journal: SetupJournal): string {
  return JSON.stringify(
    journal.version === 1 && journal.copy !== undefined
      ? { ...journal, version: COPY_JOURNAL_FILE_VERSION }
      : journal,
  );
}

/** Whether `journal`, as written to disk, reads back as a valid journal. */
export function isPersistableSetupJournal(journal: SetupJournal): boolean {
  const written: unknown = JSON.parse(serializeSetupJournal(journal));
  return normalizeSetupJournal(written) !== null;
}

function normalizeSetupJournalV1(
  value: unknown,
  copyFile: boolean,
): SetupJournalV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const {
    journalId: recordedJournalId,
    projectId,
    organizationId,
    instanceId,
    operationId,
    idempotencyKey,
    attemptNonce,
    fencingGeneration,
    localWorkspaceId,
    destinationRoot,
    finalPath,
    stagingPath,
    phase,
    updatedAt,
    errorCode,
    conversion,
    adoption,
    copy,
  } = record;
  const copyMarker =
    copy === undefined ? undefined : normalizeSetupJournalCopy(copy);
  const conversionRecord: Record<string, unknown> | undefined =
    typeof conversion === 'object' &&
    conversion !== null &&
    !Array.isArray(conversion)
      ? Object.fromEntries(Object.entries(conversion))
      : undefined;
  const adoptionRecord: Record<string, unknown> | undefined =
    typeof adoption === 'object' &&
    adoption !== null &&
    !Array.isArray(adoption)
      ? Object.fromEntries(Object.entries(adoption))
      : undefined;
  const journalId =
    recordedJournalId === undefined ? operationId : recordedJournalId;
  if (
    record.version !== 1 ||
    typeof projectId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof instanceId !== 'string' ||
    typeof operationId !== 'string' ||
    !UUID.test(operationId) ||
    typeof journalId !== 'string' ||
    !UUID.test(journalId) ||
    typeof idempotencyKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(idempotencyKey) ||
    typeof attemptNonce !== 'string' ||
    !UUID.test(attemptNonce) ||
    typeof fencingGeneration !== 'number' ||
    !Number.isSafeInteger(fencingGeneration) ||
    fencingGeneration < 0 ||
    typeof localWorkspaceId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(localWorkspaceId) ||
    typeof destinationRoot !== 'string' ||
    !isAbsolute(destinationRoot) ||
    typeof finalPath !== 'string' ||
    // `dirname` answers lexically, so `<root>/..` looks like a child of the
    // root while the filesystem resolves it to the root's parent. The checkout
    // has to be a real name inside the destination, not a way back out of it.
    finalPath !== normalize(finalPath) ||
    dirname(finalPath) !== destinationRoot ||
    basename(finalPath) === '.' ||
    basename(finalPath) === '..' ||
    typeof stagingPath !== 'string' ||
    stagingPath !== join(destinationRoot, `.canopy-setup-${journalId}`) ||
    finalPath === stagingPath ||
    !isSetupPhase(phase) ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    (errorCode !== undefined && typeof errorCode !== 'string') ||
    (conversion !== undefined && conversionRecord === undefined) ||
    (adoption !== undefined && adoptionRecord === undefined) ||
    (conversionRecord !== undefined && adoptionRecord !== undefined) ||
    copyMarker === null ||
    // Only a copy file carries the marker, and it always does.
    (copyMarker !== undefined) !== copyFile ||
    (copyMarker !== undefined &&
      (conversionRecord !== undefined || adoptionRecord !== undefined)) ||
    (adoptionRecord?.createdRepo !== undefined &&
      adoptionRecord.createdRepo !== true)
  )
    return null;
  const previousOwnershipTransfer = normalizeWorkspaceOwnershipTransfer(
    conversionRecord?.previousOwnershipTransfer,
  );
  const journal: SetupJournalV1 = {
    version: 1,
    journalId,
    projectId,
    organizationId,
    instanceId,
    operationId,
    idempotencyKey,
    attemptNonce,
    fencingGeneration,
    localWorkspaceId,
    destinationRoot,
    finalPath,
    stagingPath,
    phase,
    updatedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(conversionRecord === undefined
      ? {}
      : {
          conversion:
            previousOwnershipTransfer === undefined
              ? {}
              : { previousOwnershipTransfer },
        }),
    ...(adoptionRecord === undefined
      ? {}
      : {
          adoption:
            adoptionRecord.createdRepo === true ? { createdRepo: true } : {},
        }),
    ...(copyMarker === undefined ? {} : { copy: copyMarker }),
  };
  try {
    setupOwner(journal);
  } catch {
    return null;
  }
  return journal;
}

/**
 * QA lever for interrupting a setup at a known point (CAN-3129):
 *
 *   CANOPY_DEV_ORG_PROJECT_SETUP_PAUSE=completing:120 npm run dev
 *
 * holds every setup for that many seconds right after its journal records
 * that phase, before the mutation the phase announces. Packaged builds never
 * read it. Anything malformed is ignored.
 */
export function parseOrgProjectSetupPause(
  value: string | undefined,
): { phase: SetupPhase; ms: number } | null {
  const match = /^([a-z]+):(\d{1,4})$/.exec(value?.trim() ?? '');
  if (!match || !isSetupPhase(match[1])) return null;
  return { phase: match[1], ms: Number(match[2]) * 1000 };
}
