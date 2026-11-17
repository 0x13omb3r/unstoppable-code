import {
  isChatAttachmentPromptKind,
  type AttachmentMeta,
  type FileReference,
} from '@canopy/desktop-shared/types';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { isWebCoreScope, webCoreLocalId } from '@/lib/chat-authority';
import { readWebCoreSendReceipt } from '@/stores/chat/web-core';
import {
  useHomeComposerStore,
  type HomeCloudDestination,
  type HomeComposerMode,
  type HomeKeptDraft,
  type HomeOutboxCard,
  type HomeOutboxEntry,
} from '@/stores/homeComposerStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { getHomeScope } from './homeScope';

/*
 * New task across reloads and quits (CAN-6798). The signed-in account's
 * record, under its own key, holds two things with opposite rules:
 *
 * - The draft: only what was never dispatched. It follows the editor and is
 *   rewritten as it changes.
 * - The outbox: each message that may have reached its chat, written just
 *   before it is dispatched, keyed by its command id, and never edited. Its
 *   send removes it once over: taken, or handed to its chat's composer.
 *
 * At start the draft comes straight back. Each entry an earlier run left is
 * settled on its own: one its chat took goes, one never applied comes back
 * into New task's draft, and one that hasn't arrived and may still is shown
 * in its own project, never sent again without the person's choice. A
 * dispatched message never goes back into the editor by itself.
 *
 * Files held for a cloud draft are kept by name only: their bytes stay with
 * the person, who attaches them again.
 */

const KEY_PREFIX = 'canopy:home-draft:v1:';

/** Each account's record has its own key, so another's never overwrites it. */
function keyFor(recordOwner: string): string {
  return `${KEY_PREFIX}${recordOwner}`;
}
const WRITE_DELAY_MS = 500;
/** How long an entry that couldn't be checked waits before asking again. */
const RETRY_DELAY_MS = 30_000;

interface DraftSnapshot {
  readonly workspaceId: string | null;
  readonly mode: HomeComposerMode;
  readonly text: string;
  readonly fileReferences: readonly FileReference[];
  readonly attachments: readonly AttachmentMeta[];
  readonly cloudFileNames: readonly string[];
}

interface HomeDraftRecord {
  readonly version: 1;
  readonly owner: string;
  readonly draft?: DraftSnapshot;
  readonly outbox?: readonly HomeOutboxEntry[];
  /** Drafts an earlier run left for another project, kept apart. */
  readonly kept?: readonly HomeKeptDraft[];
}

/** The cloud message a send dispatches. */
interface HomeSentDraft {
  readonly workspaceId: string;
  readonly text: string;
  readonly fileReferences: readonly FileReference[];
  /** The names of the files it carries, whose bytes aren't kept. */
  readonly cloudFileNames: readonly string[];
}

/** The account records are written for; null until known or unreadable. */
let owner: string | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let installed: (() => void) | null = null;
/** This run's sends, by message id, until each is over. */
const live = new Map<string, HomeOutboxEntry>();
/** Earlier runs' entries being checked now. */
const checking = new Set<string>();
/**
 * This run's sends that ended without word, by entry id: each is asked about
 * quietly a few times, and goes once taken. One still unanswered after that
 * waits for the next start.
 */
const unsettled = new Map<string, number>();
/**
 * This run's sends that ended without word before the account was known:
 * held until `restoreEarlierRun` writes them, as nothing is written while the
 * account is unknown. A send's entry is never dropped before it is written
 * or settled.
 */
const awaitingOwner = new Map<string, HomeOutboxEntry>();
/** This run's sends asked about quietly, by entry id, should one be refused late. */
const quiet = new Map<string, HomeOutboxEntry>();
const UNSETTLED_CHECK_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 120_000];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function destinationOf(value: unknown): HomeCloudDestination | undefined {
  if (!isRecord(value)) return undefined;
  const { projectId, worktreeId, chatId } = value;
  return typeof projectId === 'string' &&
    typeof worktreeId === 'string' &&
    typeof chatId === 'string'
    ? { projectId, worktreeId, chatId }
    : undefined;
}

function fileReferencesOf(value: unknown): FileReference[] | null {
  if (!Array.isArray(value)) return null;
  const references: FileReference[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { displayPath, absolutePath, repoName, kind, textStart } = item;
    if (typeof displayPath !== 'string' || typeof absolutePath !== 'string')
      return null;
    references.push({
      displayPath,
      absolutePath,
      ...(typeof repoName === 'string' ? { repoName } : {}),
      ...(typeof kind === 'string' ? { kind } : {}),
      // Where the mention sits, so the restore expands that one and not an
      // earlier copy of its text.
      ...(typeof textStart === 'number' && Number.isInteger(textStart)
        ? { textStart }
        : {}),
    });
  }
  return references;
}

function attachmentsOf(value: unknown): AttachmentMeta[] | null {
  if (!Array.isArray(value)) return null;
  const attachments: AttachmentMeta[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { filename, absolutePath, sizeBytes, promptKind } = item;
    if (typeof filename !== 'string' || typeof absolutePath !== 'string')
      return null;
    attachments.push({
      filename,
      absolutePath,
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
      // A Linear ticket or browser resource keeps the context it sends with.
      ...(isChatAttachmentPromptKind(promptKind) ? { promptKind } : {}),
    });
  }
  return attachments;
}

function snapshotOf(value: unknown): DraftSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { workspaceId, mode, text, cloudFileNames } = value;
  const fileReferences = fileReferencesOf(value.fileReferences);
  const attachments = attachmentsOf(value.attachments);
  if (
    (workspaceId !== null && typeof workspaceId !== 'string') ||
    (mode !== 'chat' && mode !== 'pipeline') ||
    typeof text !== 'string' ||
    !strings(cloudFileNames) ||
    fileReferences === null ||
    attachments === null
  )
    return undefined;
  return {
    workspaceId,
    mode,
    text,
    fileReferences,
    attachments,
    cloudFileNames,
  };
}

function entryOf(value: unknown): HomeOutboxEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { id, userMessageId, workspaceId, text } = value;
  const destination = destinationOf(value.destination);
  const fileReferences = fileReferencesOf(value.fileReferences);
  // The outbox holds cloud messages only.
  if (
    typeof id !== 'string' ||
    typeof userMessageId !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof text !== 'string' ||
    destination === undefined ||
    !isWebCoreScope(destination.projectId) ||
    fileReferences === null
  )
    return undefined;
  return {
    id,
    userMessageId,
    workspaceId,
    destination,
    text,
    fileReferences,
    cloudFileNames: strings(value.cloudFileNames) ? value.cloudFileNames : [],
  };
}

function readRecord(recordOwner: string): HomeDraftRecord | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(keyFor(recordOwner));
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  if (typeof parsed.owner !== 'string') return null;
  const draft = snapshotOf(parsed.draft);
  const outbox = Array.isArray(parsed.outbox)
    ? parsed.outbox.flatMap((each) => {
        const entry = entryOf(each);
        return entry === undefined ? [] : [entry];
      })
    : [];
  const kept = Array.isArray(parsed.kept)
    ? parsed.kept.flatMap((each): HomeKeptDraft[] => {
        const snapshot = snapshotOf(each);
        const id: unknown = isRecord(each) ? each.id : undefined;
        return snapshot === undefined || typeof id !== 'string'
          ? []
          : [{ id, ...snapshot }];
      })
    : [];
  return recordOf(parsed.owner, { draft, outbox, kept });
}

/** This account's record, or null for another account's or none. */
function ownRecord(): HomeDraftRecord | null {
  if (owner === null) return null;
  const record = readRecord(owner);
  return record?.owner === owner ? record : null;
}

/** A record with exactly these parts. */
function recordOf(
  recordOwner: string,
  parts: {
    readonly draft?: DraftSnapshot | undefined;
    readonly outbox?: readonly HomeOutboxEntry[] | undefined;
    readonly kept?: readonly HomeKeptDraft[] | undefined;
  },
): HomeDraftRecord {
  return {
    version: 1,
    owner: recordOwner,
    ...(parts.draft === undefined ? {} : { draft: parts.draft }),
    ...(parts.outbox === undefined || parts.outbox.length === 0
      ? {}
      : { outbox: parts.outbox }),
    ...(parts.kept === undefined || parts.kept.length === 0
      ? {}
      : { kept: parts.kept }),
  };
}

function writeRecord(record: HomeDraftRecord): void {
  try {
    const key = keyFor(record.owner);
    if (
      record.draft === undefined &&
      record.outbox === undefined &&
      record.kept === undefined
    )
      window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(record));
  } catch (error) {
    reportClientAppError(error);
  }
}

function updateRecord(
  change: (record: HomeDraftRecord) => HomeDraftRecord,
): void {
  if (owner === null) return;
  writeRecord(change(ownRecord() ?? { version: 1, owner }));
}

/**
 * Deletes every other account's record, its draft and its outbox. This
 * computer keeps one signed-in account, so an account other than the one
 * signed in has signed out, or was signed out by another sign-in, whether
 * this window saw it go or the app quit first.
 */
function dropOtherAccounts(signedIn: string): void {
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith(KEY_PREFIX) && key !== keyFor(signedIn))
        window.localStorage.removeItem(key);
  } catch (error) {
    reportClientAppError(error);
  }
}

function hasContent(snapshot: DraftSnapshot): boolean {
  return (
    snapshot.text.trim().length > 0 ||
    snapshot.fileReferences.length > 0 ||
    snapshot.attachments.length > 0 ||
    snapshot.cloudFileNames.length > 0
  );
}

function currentSnapshot(): DraftSnapshot {
  const state = useHomeComposerStore.getState();
  const held = state.cloudFiles.map(({ file }) => file.name);
  // Files a restore asked for again stay named until attached or dismissed.
  const toAttach = (state.restoreNotice?.fileNames ?? []).filter(
    (name) => !held.includes(name),
  );
  return {
    workspaceId: state.workspaceId,
    mode: state.mode,
    text: state.text,
    fileReferences: state.fileReferences,
    attachments: state.attachments,
    cloudFileNames: [...held, ...toAttach],
  };
}

/** Writes the draft being typed now, replacing any write still waiting. */
function flushHomeDraftWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = null;
  // Whatever New task holds is the draft: a sent message left it as it went.
  const snapshot = currentSnapshot();
  const draft = hasContent(snapshot) ? snapshot : undefined;
  updateRecord((record) => recordOf(record.owner, { ...record, draft }));
}

function scheduleDraftWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushHomeDraftWrite, WRITE_DELAY_MS);
}

function writeEntry(entry: HomeOutboxEntry): void {
  updateRecord((record) =>
    recordOf(record.owner, {
      ...record,
      outbox: [
        ...(record.outbox ?? []).filter((each) => each.id !== entry.id),
        entry,
      ],
    }),
  );
}

function removeEntry(id: string): void {
  updateRecord((record) =>
    recordOf(record.owner, {
      ...record,
      outbox: (record.outbox ?? []).filter((each) => each.id !== id),
    }),
  );
}

/**
 * A New task message goes to its chat. In one step it moves into the outbox,
 * under the command id it posts as (a cloud message) or its message id, and
 * `leaveNewTask` takes it out of New task: from then on, whatever New task
 * holds is a new draft, never compared with the message. `replaces` names an
 * earlier entry this one sends again. Until the send is over New task shows
 * it as a read-only sending card.
 */
export function noteHomeSendDispatched(send: {
  readonly userMessageId: string;
  readonly destination: HomeCloudDestination;
  readonly message: HomeSentDraft;
  /**
   * The account epoch the send was pressed under. A send whose account has
   * changed since writes nothing: the record now belongs to another account.
   */
  readonly accountEpoch: number;
  readonly commandId?: string;
  readonly replaces?: string;
  readonly leaveNewTask?: () => void;
}): void {
  if (useWorkspaceContextStore.getState().accountEpoch !== send.accountEpoch)
    return;
  const entry: HomeOutboxEntry = {
    id: send.commandId ?? send.userMessageId,
    userMessageId: send.userMessageId,
    workspaceId: send.message.workspaceId,
    destination: send.destination,
    text: send.message.text,
    fileReferences: send.message.fileReferences,
    cloudFileNames: send.message.cloudFileNames,
  };
  live.set(send.userMessageId, entry);
  writeEntry(entry);
  send.leaveNewTask?.();
  flushHomeDraftWrite();
  if (send.replaces !== undefined) dropHomeOutboxEntry(send.replaces);
  show({ entry, state: 'sending' });
}

/** The send is over: its chat took the message, or its composer holds it. */
export function clearHomeSend(userMessageId: string): void {
  const entry = live.get(userMessageId);
  live.delete(userMessageId);
  if (entry === undefined) return;
  removeEntry(entry.id);
  useHomeComposerStore.getState().removeOutboxCard(entry.id);
}

/**
 * The send ended without word that its chat took the message or its
 * composer holds it, as when the web core didn't answer: its entry stays,
 * for the next start to settle by its receipt. A send again's is shown now
 * as one that may still arrive.
 */
export function keepHomeSendPending(
  userMessageId: string,
  options?: { readonly show?: boolean },
): void {
  const entry = live.get(userMessageId);
  live.delete(userMessageId);
  if (entry === undefined) return;
  // Not written yet: it waits for the account, then is asked about.
  if (owner === null) awaitingOwner.set(entry.id, entry);
  if (options?.show === true) {
    show({ entry, state: 'missing' });
    return;
  }
  quiet.set(entry.id, entry);
  useHomeComposerStore.getState().removeOutboxCard(entry.id);
  if (owner !== null) checkUnsettledLater(entry, 0);
}

/**
 * A send its chat refused after it ended without word, as a running task's
 * queue can: no longer asked about, it shows now as one that may still
 * arrive, to send again or copy.
 */
export function showHomeSendPending(id: string): void {
  const entry = quiet.get(id);
  if (entry === undefined) return;
  quiet.delete(id);
  unsettled.delete(id);
  show({ entry, state: 'missing' });
}

function checkUnsettledLater(entry: HomeOutboxEntry, attempt: number): void {
  const delay = UNSETTLED_CHECK_DELAYS_MS[attempt];
  if (delay === undefined) {
    unsettled.delete(entry.id);
    quiet.delete(entry.id);
    return;
  }
  unsettled.set(entry.id, attempt);
  setTimeout(() => {
    void checkUnsettled(entry, attempt);
  }, delay);
}

async function checkUnsettled(
  entry: HomeOutboxEntry,
  attempt: number,
): Promise<void> {
  // Superseded, let go, or another account's window since.
  if (unsettled.get(entry.id) !== attempt) return;
  const epoch = useWorkspaceContextStore.getState().accountEpoch;
  const outcome = await outcomeOf(entry);
  if (
    unsettled.get(entry.id) !== attempt ||
    useWorkspaceContextStore.getState().accountEpoch !== epoch
  )
    return;
  if (outcome === 'taken') {
    unsettled.delete(entry.id);
    quiet.delete(entry.id);
    removeEntry(entry.id);
    return;
  }
  checkUnsettledLater(entry, attempt + 1);
}

/**
 * A local first message that left New task as it was dispatched and then
 * failed comes back as a draft (CAN-6798): into an empty New task, or else
 * kept as its own card, never merged (rule 2). Local sends keep no outbox
 * entry; this keeps them no worse than when the message stayed in the
 * editor.
 */
export function returnHomeDraft(draft: {
  readonly workspaceId: string;
  readonly mode: HomeComposerMode;
  readonly text: string;
  readonly fileReferences: readonly FileReference[];
  readonly attachments: readonly AttachmentMeta[];
}): void {
  const piece: DraftSnapshot = { ...draft, cloudFileNames: [] };
  if (!hasContent(piece)) return;
  if (
    !hasContent(currentSnapshot()) &&
    scopeKnown() &&
    entersNewTaskHere(piece.workspaceId)
  ) {
    bringIntoNewTask(piece);
    flushHomeDraftWrite();
    return;
  }
  setKept([
    ...useHomeComposerStore.getState().keptDrafts,
    { id: crypto.randomUUID(), ...piece },
  ]);
}

/** The person let an earlier message go, or sent it again. */
export function dropHomeOutboxEntry(id: string): void {
  unsettled.delete(id);
  quiet.delete(id);
  awaitingOwner.delete(id);
  removeEntry(id);
  useHomeComposerStore.getState().removeOutboxCard(id);
}

/** Whether the cloud lists this task, so it can still take a message. */
function cloudTaskListed(destination: HomeCloudDestination): boolean {
  const worktreeId = webCoreLocalId(destination.worktreeId);
  if (worktreeId === null) return false;
  // Listed under the project's key, which is its New task id.
  return (
    cloudCoworkStore
      .getState()
      .tasksByProject[
        destination.projectId
      ]?.some((task) => task.worktreeId === worktreeId && task.deleted !== true && task.creation !== 'failed') ===
    true
  );
}

/**
 * Where an earlier run's cloud message stands. `refused`: the web core
 * answered that it never applied it. `not_taken`: it hasn't arrived and may
 * still. `gone`: its task is gone.
 */
type EntryOutcome = 'taken' | 'refused' | 'not_taken' | 'gone' | 'unknown';

async function outcomeOf(entry: HomeOutboxEntry): Promise<EntryOutcome> {
  const { destination } = entry;
  if (cloudCoworkStore.getState().status !== 'online') return 'unknown';
  if (!cloudTaskListed(destination)) return 'gone';
  return readWebCoreSendReceipt(destination, entry.id);
}

/** Puts a draft into an empty New task: two drafts are never merged. */
function bringIntoNewTask(piece: DraftSnapshot): void {
  useHomeComposerStore.getState().restoreDraft({
    workspaceId: piece.workspaceId,
    mode: piece.mode,
    text: piece.text,
    fileReferences: piece.fileReferences,
    attachments: piece.attachments,
    notice:
      piece.cloudFileNames.length > 0
        ? { fileNames: piece.cloudFileNames }
        : null,
  });
}

/** An entry's message as a draft: its files kept by name. */
function draftOfEntry(entry: HomeOutboxEntry): DraftSnapshot {
  return {
    workspaceId: entry.workspaceId,
    mode: 'chat',
    text: entry.text,
    fileReferences: entry.fileReferences,
    attachments: [],
    cloudFileNames: entry.cloudFileNames,
  };
}

/**
 * Whether a draft for this project belongs in New task in the context the
 * person is in. One for another organization's project stays a kept card:
 * brought in, Home would move it to another project and drop its files.
 */
function entersNewTaskHere(workspaceId: string | null): boolean {
  return workspaceId === null || !getHomeScope().isOutOfScope(workspaceId);
}

/** Whether the projects and the person's context are known. */
function scopeKnown(): boolean {
  return (
    useWorkspaceContextStore.getState().hydrated &&
    useProjectsStore.getState().hasHydratedProjects
  );
}

/**
 * Whether New task can take a draft back by itself now: as the person can,
 * and once the projects and context are known, so one met before then is
 * kept until they are. The person can still move it in themselves.
 */
function comesBackHere(workspaceId: string | null): boolean {
  return scopeKnown() && canMoveIntoNewTask(workspaceId);
}

/**
 * Whether a draft for this project can come back into New task now: nothing
 * is sending, New task is empty, and the project is in the person's context.
 * Two drafts are never merged: one that meets another is kept as a card
 * until the person moves it back.
 */
export function canMoveIntoNewTask(workspaceId: string | null): boolean {
  const state = useHomeComposerStore.getState();
  return (
    !state.isSending &&
    !hasContent(currentSnapshot()) &&
    entersNewTaskHere(workspaceId)
  );
}

function setKept(kept: readonly HomeKeptDraft[]): void {
  updateRecord((record) => recordOf(record.owner, { ...record, kept }));
  useHomeComposerStore.setState({ keptDrafts: kept });
}

/**
 * Keeps what New task holds as a card before Home clears it for another
 * context (rule 2), so it is never thrown away. Answers whether there was
 * anything to keep.
 */
export function keepHomeDraftApart(): boolean {
  const piece = currentSnapshot();
  if (!hasContent(piece)) return false;
  setKept([
    ...useHomeComposerStore.getState().keptDrafts,
    { id: crypto.randomUUID(), ...piece },
  ]);
  // Its files to attach again go with it.
  useHomeComposerStore.getState().setRestoreNotice(null);
  return true;
}

/** Brings a draft kept for another project back into New task. */
export function moveKeptDraftIntoNewTask(id: string): boolean {
  const kept = useHomeComposerStore.getState().keptDrafts;
  const draft = kept.find((each) => each.id === id);
  if (draft === undefined || !canMoveIntoNewTask(draft.workspaceId))
    return false;
  bringIntoNewTask(draft);
  // The draft holds it before the kept list lets it go.
  flushHomeDraftWrite();
  setKept(kept.filter((each) => each.id !== id));
  return true;
}

/** The person let a kept draft go. */
export function dropKeptDraft(id: string): void {
  setKept(
    useHomeComposerStore.getState().keptDrafts.filter((each) => each.id !== id),
  );
}

/** Brings a never-applied message back into New task's draft, as an edit. */
export function moveHomeOutboxEntryIntoNewTask(id: string): boolean {
  const card = useHomeComposerStore
    .getState()
    .outboxCards.find(
      (each) => each.entry.id === id && each.state === 'returned',
    );
  if (card === undefined || !canMoveIntoNewTask(card.entry.workspaceId))
    return false;
  bringIntoNewTask(draftOfEntry(card.entry));
  // The draft holds it before the outbox lets it go.
  flushHomeDraftWrite();
  removeEntry(id);
  useHomeComposerStore
    .getState()
    .setOutboxCard({ entry: card.entry, state: 'restored' });
  return true;
}

/** Whether a card shows in the project New task is on now. */
export function outboxCardShowsIn(
  card: HomeOutboxCard,
  workspaceId: string | null,
): boolean {
  // A message that may still arrive shows only in its own project; one that
  // is settled, or waits to come back into New task, shows in any.
  return card.state === 'missing' || card.state === 'checking'
    ? card.entry.workspaceId === workspaceId
    : true;
}

function show(card: HomeOutboxCard): void {
  useHomeComposerStore.getState().setOutboxCard(card);
}

function scheduleRetry(): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    checkEarlierSends();
  }, RETRY_DELAY_MS);
}

/**
 * Settles one entry an earlier run left, on its own, and answers where it
 * stands, or null when it was let go or another account's.
 */
async function settleEntry(
  entry: HomeOutboxEntry,
): Promise<EntryOutcome | null> {
  if (checking.has(entry.id)) return null;
  checking.add(entry.id);
  const epoch = useWorkspaceContextStore.getState().accountEpoch;
  try {
    const outcome = await outcomeOf(entry);
    // Another account's window, or the person let it go meanwhile.
    if (
      useWorkspaceContextStore.getState().accountEpoch !== epoch ||
      !(ownRecord()?.outbox ?? []).some((each) => each.id === entry.id)
    )
      return null;
    switch (outcome) {
      case 'taken':
        removeEntry(entry.id);
        show({ entry, state: 'sent' });
        break;
      case 'refused':
        show({ entry, state: 'returned' });
        if (scopeKnown()) moveHomeOutboxEntryIntoNewTask(entry.id);
        break;
      case 'not_taken':
        show({ entry, state: 'missing' });
        break;
      case 'gone':
        show({ entry, state: 'missing', taskGone: true });
        break;
      case 'unknown':
        show({ entry, state: 'checking' });
        scheduleRetry();
        break;
    }
    return outcome;
  } finally {
    checking.delete(entry.id);
  }
}

/**
 * Asks once more about a message that may still arrive, just before the
 * person sends it again: answers whether it is still missing, so a send
 * again never follows one that arrived or was refused meanwhile.
 */
export async function stillMissingBeforeSendAgain(
  entry: HomeOutboxEntry,
): Promise<'missing' | 'gone' | 'settled' | 'unknown'> {
  const outcome = await settleEntry(entry);
  if (outcome === 'not_taken') return 'missing';
  if (outcome === 'gone') return 'gone';
  // Still unanswered, it stays as it was, for the person to try again.
  if (outcome === 'unknown' || outcome === null) {
    if (outcome === 'unknown') show({ entry, state: 'missing' });
    return 'unknown';
  }
  return 'settled';
}

/**
 * Asks about each message an earlier run left that New task can't place
 * yet: new ones, those that couldn't be checked before and, once the cloud
 * is back, those that may still arrive.
 */
function checkEarlierSends(options?: { readonly missing?: boolean }): void {
  const cards = useHomeComposerStore.getState().outboxCards;
  const liveIds = new Set([
    ...[...live.values()].map((entry) => entry.id),
    ...unsettled.keys(),
  ]);
  for (const entry of ownRecord()?.outbox ?? []) {
    if (liveIds.has(entry.id)) continue;
    const card = cards.find((each) => each.entry.id === entry.id);
    if (
      card === undefined ||
      card.state === 'checking' ||
      (options?.missing === true && card.state === 'missing')
    )
      void settleEntry(entry);
  }
}

/**
 * Brings the first kept draft that can come into an empty New task here
 * into it, as the start does for what an earlier run left.
 */
function bringKeptIntoNewTask(): void {
  const kept = useHomeComposerStore.getState().keptDrafts;
  const index = kept.findIndex((each) => comesBackHere(each.workspaceId));
  const piece = kept[index];
  if (piece === undefined) return;
  bringIntoNewTask(piece);
  // What came back is in the draft before the kept list lets it go.
  flushHomeDraftWrite();
  setKept(kept.filter((_, each) => each !== index));
}

/** Brings back the draft an earlier run left, then asks about its sends. */
function restoreEarlierRun(): void {
  const record = ownRecord();
  const draft = record?.draft;
  // A draft for another project than the one New task holds a draft for by
  // now never joins it: it is kept apart, as are any kept before, and any
  // this run kept before the account was known, which nothing could write
  // until now (rule 3).
  const saved = record?.kept ?? [];
  const savedIds = new Set(saved.map((each) => each.id));
  const kept: HomeKeptDraft[] = [
    ...saved,
    ...useHomeComposerStore
      .getState()
      .keptDrafts.filter((each) => !savedIds.has(each.id)),
  ];
  if (draft !== undefined && hasContent(draft)) {
    if (comesBackHere(draft.workspaceId)) bringIntoNewTask(draft);
    else kept.push({ id: crypto.randomUUID(), ...draft });
  }
  // What came back is in the draft before the kept list takes the rest.
  flushHomeDraftWrite();
  setKept(kept);
  bringKeptIntoNewTask();
  // This run's sends dispatched before the account was known, still under
  // way or ended without word.
  for (const entry of live.values()) writeEntry(entry);
  const waited = [...awaitingOwner.values()];
  awaitingOwner.clear();
  for (const entry of waited) {
    writeEntry(entry);
    const card = useHomeComposerStore
      .getState()
      .outboxCards.find((each) => each.entry.id === entry.id);
    if (card === undefined) checkUnsettledLater(entry, 0);
  }
  checkEarlierSends();
}

async function resolveOwner(): Promise<string | null> {
  const load = window.api?.loadCanopyCloudAccount;
  if (typeof load !== 'function') return null;
  try {
    const account = await load();
    if (account.read !== undefined && account.read !== 'ok') return null;
    return cloudAccountIdentityKey(account) ?? 'signed-out';
  } catch (error) {
    reportClientAppError(error);
    return null;
  }
}

/**
 * Keeps New task's draft and outbox across reloads and quits from now on,
 * and brings back what an earlier run left. Installed once per window;
 * returns its uninstall.
 */
export function installHomeDraftPersistence(): () => void {
  if (installed !== null) return installed;
  let active = true;
  const flushOnHide = (): void => {
    flushHomeDraftWrite();
  };
  window.addEventListener('pagehide', flushOnHide);
  window.addEventListener('beforeunload', flushOnHide);
  const stopDraft = useHomeComposerStore.subscribe((state, previous) => {
    if (
      state.text !== previous.text ||
      state.fileReferences !== previous.fileReferences ||
      state.attachments !== previous.attachments ||
      state.cloudFiles !== previous.cloudFiles ||
      state.workspaceId !== previous.workspaceId ||
      state.mode !== previous.mode ||
      state.restoreNotice !== previous.restoreNotice
    )
      scheduleDraftWrite();
  });
  const begin = (): void => {
    // A reply for an account the window has since left is dropped: its
    // draft and sends never reach the next account's New task.
    const epoch = useWorkspaceContextStore.getState().accountEpoch;
    void resolveOwner().then((resolved) => {
      if (!active || useWorkspaceContextStore.getState().accountEpoch !== epoch)
        return;
      // Only a definite answer decides who left; an unreadable one keeps all.
      if (resolved !== null) dropOtherAccounts(resolved);
      owner = resolved;
      if (owner !== null) restoreEarlierRun();
    });
  };
  // Another account never sees this one's draft or sends: they wait for the
  // next account's read, which removes them once that account is the one
  // signed in.
  const stopAccount = useWorkspaceContextStore.subscribe((state, previous) => {
    if (state.accountEpoch === previous.accountEpoch) return;
    if (writeTimer !== null) clearTimeout(writeTimer);
    writeTimer = null;
    owner = null;
    live.clear();
    unsettled.clear();
    quiet.clear();
    awaitingOwner.clear();
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    begin();
  });
  // A draft kept at the start only because the projects or context weren't
  // known yet comes into New task once they are.
  let waitingForScope = !scopeKnown();
  const onScope = (): void => {
    if (!waitingForScope || !scopeKnown()) return;
    waitingForScope = false;
    if (owner !== null) bringKeptIntoNewTask();
  };
  const stopProjects = useProjectsStore.subscribe(onScope);
  const stopContext = useWorkspaceContextStore.subscribe(onScope);
  // A cloud answer may only come once the cloud is online.
  const stopCloud = cloudCoworkStore.subscribe((state, previous) => {
    if (state.status === 'online' && previous.status !== 'online')
      checkEarlierSends({ missing: true });
  });
  begin();
  installed = (): void => {
    active = false;
    window.removeEventListener('pagehide', flushOnHide);
    window.removeEventListener('beforeunload', flushOnHide);
    stopDraft();
    stopAccount();
    stopProjects();
    stopContext();
    stopCloud();
    if (writeTimer !== null) clearTimeout(writeTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    writeTimer = null;
    retryTimer = null;
    owner = null;
    live.clear();
    unsettled.clear();
    quiet.clear();
    awaitingOwner.clear();
    checking.clear();
    installed = null;
  };
  return installed;
}
