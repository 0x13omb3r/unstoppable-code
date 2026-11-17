/**
 * Chat routing ids shared by the desktop, the portable CanopyClient adapter
 * and the web clients, so none of them keeps its own copy.
 */

/**
 * Synthetic project id that namespaces standalone chat IPC requests (chats
 * outside any workspace).
 */
export const STANDALONE_CHAT_PROJECT_ID = 'standalone-chat';

/**
 * LEGACY worktreeId slot for cowork workspaces from before Work Entries.
 * Cowork chats now key as (projectId = workspaceId, worktreeId = workEntryId)
 * — each Work Entry is a worktree-like multi-chat container — so chat tabs,
 * worktree-data, cleanup, and observability reuse the code workspace
 * (projectId, worktreeId) plumbing unchanged. `'home'` survives only as the
 * pre-entry data location (migration source, legacy `chat-archives/home.json`
 * reads, sentinel-branch fallback) and as the keying for the shared cowork
 * attachment bucket (cowork attachments physically live in the workspace's
 * managed dir regardless of entry). Do not write new per-entry data under it.
 */
export const COWORK_HOME_WORKTREE_ID = 'home';

/**
 * Synthetic project id of the Orchestrator (App Advisor): its Work Entries and
 * chats key as (projectId = this, worktreeId = workEntryId).
 */
export const APP_ADVISOR_PROJECT_ID = 'app-advisor';

/** Public bot ID of the Orchestrator, the default Bot. */
export const APP_ADVISOR_BOT_ID = 'app_advisor';

/**
 * Public, opaque Bot ID: the default Bot's {@link APP_ADVISOR_BOT_ID} or
 * `bot_<lowercase ULID>`. Its internal project ID is derived (see
 * {@link projectIdForBotId}) and never stored or exposed.
 */
export type BotId = typeof APP_ADVISOR_BOT_ID | `bot_${string}`;

/**
 * Prefix of every non-default Bot's internal project ID
 * (`bot--<lowercase ULID>`). The double dash keeps Bot project IDs apart from
 * every saved project ID: project IDs are name slugs, and slug allocation
 * collapses separator runs, so it never writes `--` after a leading word
 * (a name "Bot helper" is `bot-helper`), yet `--` passes the lowercase
 * project ID validation like `app-advisor` does.
 */
export const BOT_PROJECT_ID_PREFIX = 'bot--';

const BOT_ID_PREFIX = 'bot_';

/**
 * A ULID in lowercase Crockford base32: exactly 26 of `[0-9a-hjkmnp-tv-z]`.
 * Lowercase, so a Bot project ID passes the same lowercase ID validation as
 * every saved project ID. Matching is case-sensitive: never case-fold an ID
 * before testing it. Project ID allocation and project creation also refuse
 * the exact shape (`allocateSafeWorkspaceId`, `reserveWorkspaceCreation`).
 */
const BOT_SUFFIX = /^[0-9a-hjkmnp-tv-z]{26}$/;
const BOT_SUFFIX_LENGTH = 26;

/** `prefix` followed by a lowercase ULID; the length check skips the regex for most IDs. */
function hasBotSuffix(value: string, prefix: string): boolean {
  return (
    value.length === prefix.length + BOT_SUFFIX_LENGTH &&
    value.startsWith(prefix) &&
    BOT_SUFFIX.test(value.slice(prefix.length))
  );
}

/**
 * Whether `projectId` is any Bot's internal project ID: the default Bot's
 * `app-advisor` or a non-default Bot's `bot--<lowercase ULID>`. Use this where a code
 * path means "any Bot"; compare with `APP_ADVISOR_PROJECT_ID` only where it
 * means the default Bot specifically.
 */
export function isBotProjectId(projectId: string): boolean {
  return (
    projectId === APP_ADVISOR_PROJECT_ID ||
    hasBotSuffix(projectId, BOT_PROJECT_ID_PREFIX)
  );
}

/** Whether `value` is a well-formed {@link BotId}. */
export function isBotId(value: string): value is BotId {
  return value === APP_ADVISOR_BOT_ID || hasBotSuffix(value, BOT_ID_PREFIX);
}

/** The Bot ID behind a Bot project ID, or `null` for any other project ID. */
export function botIdForProjectId(projectId: string): BotId | null {
  if (projectId === APP_ADVISOR_PROJECT_ID) return APP_ADVISOR_BOT_ID;
  if (!hasBotSuffix(projectId, BOT_PROJECT_ID_PREFIX)) return null;
  const botId: BotId = `bot_${projectId.slice(BOT_PROJECT_ID_PREFIX.length)}`;
  return botId;
}

/**
 * The internal project ID of a Bot. Throws for a malformed ID (a value typed
 * `bot_${string}` that {@link isBotId} rejects), so no caller can mint a
 * project ID that {@link isBotProjectId} would not recognize.
 */
export function projectIdForBotId(botId: BotId): string {
  if (botId === APP_ADVISOR_BOT_ID) return APP_ADVISOR_PROJECT_ID;
  if (!isBotId(botId)) throw new Error('Malformed Bot ID');
  return `${BOT_PROJECT_ID_PREFIX}${botId.slice(BOT_ID_PREFIX.length)}`;
}
