import { ListRowFrame } from './ListRow';
import { ControlButton } from './Button';
import type { ComponentType, JSX, MouseEvent, ReactNode } from 'react';
import {
  sourceLabelProvider,
  type UnifiedEntryHarnessInstalls,
  type UnifiedEntryPlacement,
} from '../lib/unified-plugin-entry';
import { mcpPlacementLabel, mcpRowHealthModel } from '../lib/mcp-row-health';
import { formatDateOrEmpty } from '../lib/format-date';
import { ClaudeLogo, CodexLogo } from '../icons';
import { PersonIcon, RefreshIcon, SkillIcon } from '../icons/AppIcons';
import { curatedLogoKey } from '../lib/curated-logo-key';
import {
  customizeHarnessInstallWarning,
  customizeHarnessRetryLabel,
  customizeIntegrationInstalledLabel,
  customizeWorksWithHarnesses,
  type CustomizeSkillMatch,
} from '../lib/customize-discovery';
import { MCP_BRAND_LOGOS } from '../lib/mcp-brand-logos';
import { createdByViewer, pendingSignInLabel } from '../lib/customize-row-copy';
import { displayVersion } from '../lib/display-version';
import { INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL } from '../lib/installed-share-copy';
import { REPLAY_MASK_CLASS, REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import {
  CustomizeRowMenu,
  type CustomizeRowMenuItem,
} from './CustomizeRowMenu';
import { EntrySurfaceIcon } from './EntrySurfaceIcon';
import { McpRowAttention, McpRowHealth } from './McpRowHealth';
import { McpServerLogo, type McpServerLogoProps } from './McpServerLogo';
import {
  EntrySourceProviderMark,
  entrySourceTextWithoutProvider,
} from './EntrySourceLabel';
import { Tooltip } from './Tooltip';
import { MarketplaceTypeLabel } from './MarketplaceTypeLabel';
import { Badge } from './Badge';
import {
  CustomizeRowSplitButton,
  type CustomizeRowSplitAction,
} from './CustomizeRowSplitButton';
import { CustomizeWorksWithChips } from './CustomizeWorksWithChips';

/** Corporate suffixes a publisher name drops before matching a brand key. */
const PUBLISHER_SUFFIX = /-(inc|llc|ltd|corp|corporation|co|hq)$/;

/**
 * The bundled brand mark of an entry's publisher (CAN-6813), for a row whose
 * catalog supplies no logo: "Sentry" and "Sentry, Inc." both resolve the
 * `sentry` mark. Only the publisher is matched, never the item's own name,
 * so an unrelated item named after a brand keeps its letter.
 */
export function customizePublisherLogoKey(
  entry: Pick<UnifiedPluginEntry, 'authorName'>,
): string | undefined {
  const slug = entry.authorName
    ?.trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[\s_./]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return undefined;
  return [slug, slug.replace(PUBLISHER_SUFFIX, '')].find((key) =>
    Object.prototype.hasOwnProperty.call(MCP_BRAND_LOGOS, key),
  );
}

function compactMetadata(entry: UnifiedPluginEntry): {
  source: string | undefined;
  version: string | null;
  tooltip: string;
  visibleCounts: readonly (readonly [
    number | undefined,
    'plugin' | 'skill' | 'app' | 'agent',
    string,
  ])[];
  triggerSummary: string | undefined;
} {
  const version = displayVersion(entry.version);
  const own = createdByViewer(entry) && !entry.installedFrom;
  const owner = own
    ? 'You'
    : entry.sharedSource?.sharedBy?.trim() ||
      entry.installedFrom?.sharedByName?.trim() ||
      entry.installedFrom?.ownerName?.trim() ||
      entry.authorName?.trim();
  const catalog = entry.sourceLabel?.trim();
  const source = entry.installedVia
    ? `Installed via ${entry.installedVia.name}`
    : entry.builtIn === true || entry.origin === 'built-in'
      ? 'Built-in'
      : own
        ? 'You'
        : entry.sharedSource?.sharedBy?.trim() ||
          entry.installedFrom?.sharedByName?.trim() ||
          entry.installedFrom?.ownerName?.trim() ||
          owner ||
          entry.workflow?.sourceText?.replace(/^Shared by /, '') ||
          entry.ownershipLabel?.trim() ||
          (!entry.marketplaceProviders &&
          catalog &&
          !['Curated', 'Local', 'Shared', 'Project'].includes(catalog)
            ? catalog
            : undefined);
  const workflow = entry.workflow;
  const triggers = workflow?.triggers ?? [];
  const triggerSummary =
    workflow?.schedule?.label ||
    (triggers.length > 1
      ? `${triggers.length} triggers`
      : triggers[0]?.label) ||
    workflow?.triggerText;
  const scope = entry.sharedWith;
  const scopeLabel = scope
    ? scope.personal
      ? 'Personal'
      : scope.name || (scope.audience === 'team' ? 'Team' : 'Organization')
    : undefined;
  const receiptContextNames = entry.installedFrom
    ? [
        ...new Set([
          entry.installedFrom.teamName?.trim(),
          entry.installedFrom.ownerName?.trim(),
        ]),
      ].filter(
        (name): boolean =>
          Boolean(name) && name !== owner && name !== scopeLabel?.trim(),
      )
    : [];
  const edited = formatDateOrEmpty(entry.editedAt);
  const tooltip = [
    owner ? `Created by ${own ? 'you' : owner}` : undefined,
    scopeLabel ? `shared to ${scopeLabel}` : undefined,
    ...receiptContextNames,
    entry.publicShare ? 'Public link' : undefined,
    entry.workflow?.sourceText,
    entry.workflow?.triggerText,
    ...(entry.workflow?.triggers?.map(
      (trigger) => `${trigger.label}: ${trigger.explainer}`,
    ) ?? []),
    entry.workflow?.schedule?.tooltip,
    entry.workflow?.stepCount !== undefined
      ? `${entry.workflow.stepCount} steps`
      : undefined,
    edited ? `Edited ${edited}` : undefined,
    entry.workflow?.lastRun
      ? `Last run: ${entry.workflow.lastRun.state}${entry.workflow.lastRun.errorMessage ? `: ${entry.workflow.lastRun.errorMessage}` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const counts = [
    [entry.components.plugins, 'plugin', 'plugins'],
    [entry.components.skills, 'skill', 'skills'],
    [entry.components.mcpServers, 'app', 'MCP servers'],
    [entry.components.agents, 'agent', 'agents'],
  ] as const;
  const visibleCounts =
    entry.kind === 'collection'
      ? counts.filter(
          ([count]) =>
            count !== undefined && Number.isSafeInteger(count) && count > 0,
        )
      : [];
  return { source, version, tooltip, visibleCounts, triggerSummary };
}

function CompactMetadata({
  entry,
  metadata,
  health,
  attentionLabel,
  updateBadge = false,
  worksWith = false,
  harnessWarning,
}: {
  entry: UnifiedPluginEntry;
  metadata: ReturnType<typeof compactMetadata>;
  health?: ReactNode;
  attentionLabel?: string;
  updateBadge?: boolean;
  /** New Customize (CAN-6813): harness chips replace the installed marks. */
  worksWith?: boolean;
  /** New Customize (CAN-6815): harnesses one Add could not install for. */
  harnessWarning?: { readonly label: string; readonly instruction: string };
}): JSX.Element | null {
  const { version, tooltip, visibleCounts, triggerSummary } = metadata;
  const source = metadata.source
    ? entrySourceTextWithoutProvider(entry, metadata.source)
    : metadata.source;
  // An integration row's installed line names the harness instead (CAN-6811).
  const hasWorksWith =
    worksWith && customizeWorksWithHarnesses(entry).length > 0;
  const hasHarnessIcons =
    !worksWith &&
    entry.integrationCopies?.installed === undefined &&
    (entry.installedHarnesses?.claude === true ||
      entry.installedHarnesses?.codex === true);
  const hasSourceMark =
    !entry.marketplaceProviders &&
    entry.kind === 'plugin' &&
    (entry.origin === 'marketplace'
      ? Boolean(sourceLabelProvider(entry.sourceLabel))
      : entry.origin === 'shared' && Boolean(entry.sharedSourceProvider));
  const healthConnection = entry.connection ?? entry.aggregateConnection;
  const fallbackHealth =
    !health &&
    healthConnection &&
    (healthConnection.status !== 'unknown' ||
      healthConnection.signIn ||
      healthConnection.disabled)
      ? mcpRowHealthModel(healthConnection)
      : undefined;
  const hasSubtitle = Boolean(
    hasHarnessIcons ||
    hasWorksWith ||
    source ||
    version ||
    visibleCounts.length > 0 ||
    triggerSummary ||
    entry.bundledBy ||
    hasSourceMark ||
    entry.marketplaceProviders?.length ||
    (entry.shareUpdateAvailable && !updateBadge),
  );
  // An unreachable check and a pending sign-in can describe separate bindings.
  const hasIndependentSignIn =
    (entry.pendingSignIns ?? 0) > 0 &&
    healthConnection?.status === 'unreachable' &&
    !healthConnection.signIn &&
    !healthConnection.disabled;
  const warning =
    hasIndependentSignIn || (!health && !fallbackHealth)
      ? attentionLabel
      : undefined;
  const warningTestId =
    attentionLabel === undefined
      ? `plugins-connection-status-${entry.id}`
      : `customize-row-sign-in-${entry.id}`;
  if (
    !hasSubtitle &&
    !health &&
    !fallbackHealth &&
    warning === undefined &&
    harnessWarning === undefined
  )
    return null;
  return (
    <span
      data-testid={`customize-row-subtitle-${entry.id}`}
      className={`pointer-events-none relative z-10 mt-0.5 flex min-h-4 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs fg-tertiary ${worksWith ? '@container/customize-row-subtitle ' : ''}${entry.origin === 'shared' || entry.installedFrom || entry.sharedSource || entry.collectionProvenanceUnknown ? REPLAY_BLOCK_CLASS : entry.workflow?.sourceIsPerson ? REPLAY_MASK_CLASS : ''}`}
    >
      {health}
      {fallbackHealth && (
        <McpRowHealth
          name={entry.name}
          model={fallbackHealth}
          testId={
            fallbackHealth.tone === 'attention'
              ? warningTestId
              : `plugins-connection-status-${entry.id}`
          }
        />
      )}
      {fallbackHealth && healthConnection?.provider === true && (
        <span
          className="text-3xs fg-secondary"
          data-testid={`plugins-connection-provider-${entry.id}`}
        >
          Agent provider
        </span>
      )}
      {warning !== undefined && (
        <McpRowAttention
          name={entry.name}
          label={warning}
          action={(entry.pendingSignIns ?? 0) > 0 ? 'connect' : null}
          testId={warningTestId}
        />
      )}
      {harnessWarning !== undefined && (
        <McpRowAttention
          name={entry.name}
          label={harnessWarning.label}
          instruction={harnessWarning.instruction}
          action={null}
          testId={`customize-row-harness-install-failed-${entry.id}`}
        />
      )}
      {entry.marketplaceProviders?.map((provider) => (
        <Tooltip
          key={provider}
          label={`Available from the ${provider} marketplace`}
        >
          <Badge>{provider}</Badge>
        </Tooltip>
      ))}
      {/* The name line's Update badge already says so. */}
      {entry.shareUpdateAvailable === true && !updateBadge && (
        <Badge
          tone="info"
          icon={RefreshIcon}
          className="shrink-0"
          data-testid={`customize-row-update-available-${entry.id}`}
        >
          {INSTALLED_SHARE_UPDATE_AVAILABLE_LABEL}
        </Badge>
      )}
      {/* Where it's installed says more than the marketplace's mark, and one
          row of logos reads better than two. */}
      {hasHarnessIcons ? (
        <HarnessIcons entry={entry} />
      ) : (
        hasSourceMark &&
        entry.origin !== 'shared' && <EntrySourceProviderMark entry={entry} />
      )}
      {source && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip.includes(source)
                ? tooltip
                : [source, tooltip].filter(Boolean).join(' · ')}
            </span>
          }
          allowShrink
          className="pointer-events-auto"
        >
          <span
            data-testid={`customize-row-source-${entry.id}`}
            className="min-w-0 truncate"
          >
            {source}
          </span>
        </Tooltip>
      )}
      {!hasHarnessIcons && entry.origin === 'shared' && (
        <EntrySourceProviderMark entry={entry} />
      )}
      {source && version && <span>·</span>}
      {version && (
        <span
          data-testid={`customize-row-version-${entry.id}`}
          className="shrink-0"
        >
          {version}
        </span>
      )}
      {(source || version) && entry.bundledBy && <span>·</span>}
      {entry.bundledBy && (
        <span
          data-testid={`customize-row-from-plugin-${entry.id}`}
          className="truncate"
        >
          From {entry.bundledBy.name}
        </span>
      )}
      {(source || version || entry.bundledBy) && visibleCounts.length > 0 && (
        <span>·</span>
      )}
      {visibleCounts.length > 0 && (
        <span className="flex shrink-0 items-center gap-2">
          {visibleCounts.map(([count, kind, label]) => (
            <Tooltip
              key={kind}
              className="pointer-events-auto"
              label={`${count} ${count === 1 ? (label === 'MCP servers' ? 'MCP server' : label.slice(0, -1)) : label}`}
            >
              <span>
                <span aria-hidden="true">
                  <MarketplaceTypeLabel kind={kind} label={String(count)} />
                </span>
                <span className="sr-only">{`${count} ${count === 1 ? (label === 'MCP servers' ? 'MCP server' : label.slice(0, -1)) : label}`}</span>
              </span>
            </Tooltip>
          ))}
        </span>
      )}
      {(source || version || entry.bundledBy || visibleCounts.length > 0) &&
        triggerSummary && <span>·</span>}
      {triggerSummary && (
        <Tooltip
          label={
            <span className={REPLAY_BLOCK_CLASS}>
              {tooltip || triggerSummary}
            </span>
          }
          clamp={false}
          className="pointer-events-auto"
        >
          <span
            data-testid={`customize-row-trigger-${entry.id}`}
            className="min-w-0 truncate"
          >
            {triggerSummary}
          </span>
        </Tooltip>
      )}
      {hasWorksWith &&
        (source ||
          version ||
          entry.bundledBy ||
          visibleCounts.length > 0 ||
          triggerSummary) && <span>·</span>}
      {hasWorksWith && <CustomizeWorksWithChips entry={entry} />}
    </span>
  );
}

function CustomItemBadge({
  entry,
  selected,
}: {
  readonly entry: UnifiedPluginEntry;
  readonly selected: boolean;
}): JSX.Element {
  const creator = entry.authorName?.trim();
  const kind = entry.typeLabel?.toLowerCase() || entry.kind;
  const label = creator ? `Custom ${kind} by ${creator}` : `Custom ${kind}`;
  return (
    <span
      className={`pointer-events-auto absolute ${entry.kind === 'collection' ? '-bottom-1.5 -right-1.5' : '-bottom-1 -right-1'} z-10 inline-flex overflow-visible`}
    >
      <Tooltip
        label={
          <span className={creator ? REPLAY_BLOCK_CLASS : undefined}>
            {label}
          </span>
        }
      >
        <span
          data-testid={`customize-row-custom-${entry.id}`}
          role="img"
          aria-label={label}
          className={`inline-flex size-4 items-center justify-center rounded-full bg-fg-primary [color:var(--bg-primary)] ring-2 ${
            selected
              ? 'ring-selected'
              : 'ring-[var(--bg-primary)] group-hover/skill-row:ring-subtle'
          } ${creator ? REPLAY_BLOCK_CLASS : ''}`}
        >
          <PersonIcon size="xs" drawnStrokeWidth={1.4} aria-hidden="true" />
        </span>
      </Tooltip>
    </span>
  );
}

/** A DOM id unique per section, since one entry may appear in several. */
export function customizeRowDomId(sectionId: string, entryId: string): string {
  return `customize-${encodeURIComponent(sectionId)}-${encodeURIComponent(entryId)}`;
}

export interface CustomizeInstalledRowProps {
  readonly entry: UnifiedPluginEntry;
  /** Owning section; qualifies DOM ids and scopes test ids. */
  readonly sectionId: string;
  readonly primaryTestId?: string;
  readonly menuTestId?: string;
  readonly selected?: boolean;
  readonly showEntryType?: boolean;
  readonly onSelect: (entry: UnifiedPluginEntry) => void;
  /** Semantic link target; plain clicks still route through `onSelect`. */
  readonly href?: string;
  readonly menuItems?: readonly CustomizeRowMenuItem[];
  /** Extension slot for status controls supplied by a later surface. */
  readonly status?: ReactNode;
  readonly values?: ReactNode;
  /** Visible row actions such as Update. */
  readonly actions?: ReactNode;
  /** Replaces the attention chip and connection badge on an MCP row. */
  readonly health?: ReactNode;
  /** An attention action kept outside the primary row control. */
  readonly inlineAction?: ReactNode;
  /** Where an MCP row is saved; replaces the surface icon. */
  readonly placement?: UnifiedEntryPlacement;
  /**
   * Starts sign-in from the row's menu, beside the marker that says one is
   * pending. Omit when the row has nothing to connect.
   */
  readonly onConnect?: (entry: UnifiedPluginEntry) => void;
  /**
   * What the menu item connects, when that is not this row (a plugin row
   * signing in to a bundled server). Defaults to the row.
   */
  readonly connectName?: string;
  /**
   * A Disabled item (CAN-4838): the logo, name, inline badges, subtitle and
   * version text take 60% opacity; the harness icons, connection badge, focus
   * ring, status, actions and menu keep full ink.
   */
  readonly dimmed?: boolean;
  /**
   * New Customize (CAN-6810): an Update badge beside the name replaces the
   * Updates section, and the subtitle's share update badge.
   */
  readonly updateBadge?: boolean;
  /**
   * New Customize search (CAN-6812): a plugin row a search reached through
   * its skills names them on an "Includes" line.
   */
  readonly skillMatch?: CustomizeSkillMatch;
  /**
   * New Customize row polish (CAN-6813): Works with harness chips, and the
   * publisher's bundled mark for a row whose catalog supplies no logo.
   */
  readonly discovery?: boolean;
  /**
   * New Customize (CAN-6813): one split control replaces the status,
   * actions and ⋯ menu. Its caret lists the row's menu items.
   */
  readonly splitAction?: CustomizeRowSplitAction;
  /**
   * New Customize (CAN-6815): stages one harness that refused the server
   * again. Omit where the host cannot, and the row only says why.
   */
  readonly onRetryHarnessInstall?: (
    entry: UnifiedPluginEntry,
    failure: UnifiedEntryHarnessInstalls['failed'][number],
  ) => void;
  readonly McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
}

/** The "Includes" line of the Customize search design (CAN-6812). */
function SkillMatchLine({
  entryId,
  match,
}: {
  entryId: string;
  match: CustomizeSkillMatch;
}): JSX.Element {
  // Inline text, not flex items: in a narrow grid column the names wrap
  // like a sentence instead of each dropping onto its own line.
  return (
    <span
      data-testid={`customize-row-skill-match-${entryId}`}
      className="pointer-events-none relative z-10 block min-w-0 text-xs leading-5 fg-secondary"
    >
      <span className="inline-flex align-text-bottom">
        <SkillIcon size="xs" ariaHidden />
      </span>{' '}
      Includes
      {match.names.map((name) => (
        <span key={name}>
          {' '}
          <mark className="box-decoration-clone rounded bg-accent-subtle px-1 font-medium fg-primary">
            {name}
          </mark>
        </span>
      ))}
      {match.moreCount > 0 &&
        ` +${match.moreCount} more ${match.moreCount === 1 ? 'skill' : 'skills'}`}
    </span>
  );
}

/**
 * An integration row's installed state (CAN-6811): the harness its copy is
 * installed for, and how many other installed copies it stands for.
 */
function IntegrationInstalledLine({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const installed = customizeIntegrationInstalledLabel(entry);
  if (installed === undefined) return null;
  return (
    <span
      data-testid={`customize-row-installed-copies-${entry.id}`}
      className="pointer-events-none relative z-10 block min-w-0 truncate text-xs leading-5 fg-tertiary"
    >
      {installed.label}
      {installed.moreLabel !== undefined && ` · ${installed.moreLabel}`}
    </span>
  );
}

function HarnessIcons({
  entry,
}: {
  entry: UnifiedPluginEntry;
}): JSX.Element | null {
  const harnesses = entry.installedHarnesses;
  if (harnesses?.claude !== true && harnesses?.codex !== true) return null;
  return (
    <span
      data-testid={`customize-row-harnesses-${entry.id}`}
      className="flex shrink-0 items-center gap-1"
    >
      {harnesses.claude === true && (
        <Tooltip label="Installed for Claude">
          <ClaudeLogo
            width={12}
            height={12}
            role="img"
            aria-label="Installed for Claude"
            className="shrink-0 fg-secondary"
          />
        </Tooltip>
      )}
      {harnesses.codex === true && (
        <Tooltip label="Installed for Codex">
          <CodexLogo
            width={12}
            height={12}
            role="img"
            aria-label="Installed for Codex"
            className="shrink-0 fg-secondary"
          />
        </Tooltip>
      )}
    </span>
  );
}

/**
 * One Installed, Updates or Shared by me row. The primary control and the
 * trailing controls are siblings, so a secondary action never opens details.
 */
export function CustomizeInstalledRow({
  entry,
  sectionId,
  primaryTestId,
  menuTestId,
  selected = false,
  showEntryType = false,
  onSelect,
  href,
  menuItems = [],
  status,
  values,
  actions,
  health,
  inlineAction,
  placement,
  onConnect,
  connectName,
  dimmed = false,
  updateBadge = false,
  skillMatch,
  discovery = false,
  splitAction,
  onRetryHarnessInstall,
  McpServerLogoComponent = McpServerLogo,
}: CustomizeInstalledRowProps): JSX.Element {
  const domId = customizeRowDomId(sectionId, entry.id);
  const metadata = compactMetadata(entry);
  const compactMcp = health !== undefined || entry.installedVia !== undefined;
  // Only real pending sign-ins are counted (`pendingSignIns`, set by the
  // entry projection); any other problem keeps `Needs attention`. A plugin
  // counts the sign-ins its bundled servers wait for. The host decides what
  // the marker's menu item connects through `onConnect`.
  const signInCount = entry.pendingSignIns ?? 0;
  const attentionLabel =
    signInCount > 0
      ? pendingSignInLabel(signInCount)
      : entry.state === 'needs-auth'
        ? 'Needs attention'
        : undefined;
  const connectMenuItems =
    health === undefined &&
    attentionLabel !== undefined &&
    onConnect &&
    !menuItems?.some((item) => item.id === 'connect')
      ? [
          ...(menuItems ?? []),
          {
            id: 'connect',
            label:
              connectName && connectName !== entry.name
                ? `Connect ${connectName}`
                : 'Connect',
            onSelect: (): void => onConnect(entry),
          },
        ]
      : menuItems;
  // One Add for every harness (CAN-6815): New Customize only.
  const harnessFailures = discovery
    ? (entry.harnessInstalls?.failed ?? [])
    : [];
  const harnessWarning = customizeHarnessInstallWarning(
    harnessFailures,
    onRetryHarnessInstall !== undefined,
  );
  const rowMenuItems: readonly CustomizeRowMenuItem[] =
    onRetryHarnessInstall && harnessFailures.length > 0
      ? [
          ...connectMenuItems,
          ...harnessFailures.map(
            (failure): CustomizeRowMenuItem => ({
              id: `retry-harness-install-${failure.harness}`,
              label: customizeHarnessRetryLabel(failure.harness),
              onSelect: (): void => onRetryHarnessInstall(entry, failure),
            }),
          ),
        ]
      : connectMenuItems;
  const primaryProps = {
    id: domId,
    'aria-describedby': `${domId}-description`,
    'data-marketplace-entry': 'true',
    'data-testid': primaryTestId ?? `customize-row-${entry.id}`,
    'data-selected': selected ? 'true' : 'false',
  };
  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    onSelect(entry);
  };
  function onMetadataClick(event: MouseEvent<HTMLSpanElement>): void {
    const target = event.target;
    if (
      target instanceof Element &&
      !target.closest('a, button, [tabindex="0"], [role="tooltip"]') &&
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      onSelect(entry);
    }
  }
  // The native action stretches across the row while focusable warning
  // controls in the subtitle remain its siblings.
  const title = (
    <span
      data-testid={`customize-row-name-line-${entry.id}`}
      className="relative z-10 flex min-w-0 items-center gap-x-1.5 overflow-hidden"
    >
      {/* The line clips rather than spilling into the row's controls.
              The name truncates as space runs out;
              the kind and surface icon stay whole. */}
      <Tooltip
        label={
          entry.description
            ? `${entry.name} · ${entry.description}`
            : entry.name
        }
        clamp={Boolean(entry.description)}
        delay="long"
        allowShrink
        replayBlock
      >
        <span className="min-w-0 truncate text-s font-medium fg-primary">
          {entry.name}
        </span>
      </Tooltip>
      {updateBadge && (
        <Badge
          tone="info"
          className="shrink-0"
          data-testid={`customize-row-update-badge-${entry.id}`}
        >
          Update
        </Badge>
      )}
      {showEntryType && entry.typeLabel && (
        <MarketplaceTypeLabel
          kind={entry.kind}
          label={entry.typeLabel}
          dataTestId={`customize-row-type-${entry.id}`}
        />
      )}
      {placement !== undefined && placement !== 'account' && (
        <EntrySurfaceIcon
          surface="desktop"
          label={mcpPlacementLabel('desktop')}
          testId={`customize-row-placement-${entry.id}`}
        />
      )}
      {placement !== undefined && placement !== 'desktop' && (
        <EntrySurfaceIcon
          surface="cloud"
          label={mcpPlacementLabel('account')}
          testId={`customize-row-placement-cloud-${entry.id}`}
        />
      )}
      {placement === undefined && entry.surface && (
        <EntrySurfaceIcon
          surface={entry.surface}
          testId={`plugins-surface-${entry.id}`}
        />
      )}
    </span>
  );
  const metadataLine = (
    <CompactMetadata
      entry={entry}
      metadata={metadata}
      health={health}
      attentionLabel={attentionLabel}
      updateBadge={updateBadge}
      worksWith={discovery}
      harnessWarning={harnessWarning}
    />
  );
  const logoKey =
    curatedLogoKey(entry) ??
    (discovery &&
    !entry.logoUrl &&
    entry.bundledLogo === undefined &&
    entry.brandMark !== true
      ? customizePublisherLogoKey(entry)
      : undefined);
  // Opacity on the control itself would dim its focus ring, so the content
  // wrapper carries it.
  const content = (
    <span
      role="presentation"
      data-testid={`customize-row-content-${entry.id}`}
      className={`relative isolate flex flex-1 items-center gap-3 rounded-xl py-2.5 outline-offset-2 has-[[data-marketplace-entry]:focus-visible]:outline-2 has-[[data-marketplace-entry]:focus-visible]:outline-line-focus pointer-coarse:min-h-11 ${compactMcp ? 'min-w-0 pl-4 pr-0' : 'min-w-32 px-4'} ${selected ? 'bg-selected' : ''}`}
      onClick={onMetadataClick}
    >
      <span
        className={`pointer-events-none relative inline-flex shrink-0 overflow-visible${dimmed ? ' opacity-60' : ''}`}
      >
        <McpServerLogoComponent
          curatedKey={logoKey}
          logoUrl={entry.logoUrl}
          bundledLogo={entry.bundledLogo}
          brandMark={entry.brandMark}
          size={28}
          fallback="monogram"
          name={entry.name}
          shape="circle"
          fit="contain"
        />
        {createdByViewer(entry) && !entry.installedFrom && (
          <CustomItemBadge entry={entry} selected={selected} />
        )}
      </span>
      <span className={`min-w-0 flex-1${dimmed ? ' opacity-60' : ''}`}>
        {href !== undefined ? (
          <a
            {...primaryProps}
            className="block min-w-0 text-left outline-none after:absolute after:inset-0"
            href={href}
            onClick={onLinkClick}
          >
            {title}
          </a>
        ) : (
          <ControlButton
            presentation="customize-installed-primary"
            {...primaryProps}
            type="button"
            onClick={() => onSelect(entry)}
          >
            {title}
          </ControlButton>
        )}
        {skillMatch || entry.integrationCopies?.installed ? (
          <span className="flex min-w-0 flex-col gap-1">
            {metadataLine}
            {skillMatch && (
              <SkillMatchLine entryId={entry.id} match={skillMatch} />
            )}
            <IntegrationInstalledLine entry={entry} />
          </span>
        ) : (
          metadataLine
        )}
      </span>
    </span>
  );
  return (
    <ListRowFrame
      layout="customize-installed"
      as="li"
      state={compactMcp ? 'compact-control' : 'wrapping-control'}
      data-testid={`customize-${sectionId}-row-${entry.id}`}
      data-dimmed={dimmed ? 'true' : undefined}
    >
      {content}
      <span
        id={`${domId}-description`}
        className={`sr-only ${REPLAY_BLOCK_CLASS}`}
      >
        {metadata.tooltip}
      </span>
      <div
        data-testid={`customize-row-controls-${entry.id}`}
        className={`ml-auto flex min-w-min max-w-full items-center justify-end empty:hidden ${compactMcp ? 'shrink-0 flex-nowrap gap-2' : 'flex-wrap gap-2'}`}
      >
        {/* Health shows only once a check has a result; a server that was
          never checked shows nothing rather than a "Not checked" chip. An
          attention marker already says a sign-in is missing, so Auth
          required is not repeated beside it. */}
        {inlineAction}
        {values}
        {splitAction !== undefined && (
          <CustomizeRowSplitButton
            entryName={entry.name}
            idPrefix={domId}
            action={splitAction}
            items={rowMenuItems.filter(
              (item) => !splitAction.omitItemIds?.includes(item.id),
            )}
            testId={menuTestId ?? `customize-row-menu-${entry.id}`}
          />
        )}
        {splitAction === undefined && status}
        {splitAction === undefined && actions && (
          <span className="flex shrink-0 items-center justify-end">
            {actions}
          </span>
        )}
        {splitAction === undefined && rowMenuItems.length > 0 && (
          <span className="flex w-7 shrink-0 justify-end pointer-coarse:w-11">
            <CustomizeRowMenu
              entryName={entry.name}
              idPrefix={domId}
              items={rowMenuItems}
              testId={menuTestId ?? `customize-row-menu-${entry.id}`}
            />
          </span>
        )}
      </div>
    </ListRowFrame>
  );
}
