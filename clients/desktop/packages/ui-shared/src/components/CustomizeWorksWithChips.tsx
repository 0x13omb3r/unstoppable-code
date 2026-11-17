import type { JSX } from 'react';
import { BADGE_ICON_BY_SIZE, badgeClassName } from '../lib/badge';
import {
  CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS,
  customizeWorksWithChipLabel,
  customizeWorksWithChips,
  type CustomizeDiscoveryHarness,
} from '../lib/customize-discovery';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { GitHubIcon } from '../icons/AppIcons';
import { ClaudeLogo } from '../icons/ClaudeLogo';
import { CodexLogo } from '../icons/CodexLogo';
import { CursorLogo } from '../icons/CursorLogo';
import { OpenCodeLogo } from '../icons/OpenCodeLogo';
import { Tooltip } from './Tooltip';

/**
 * Names show once the row's subtitle (the `customize-row-subtitle` container
 * in `CustomizeInstalledRow`) is wide enough for three named chips.
 */
const CHIP_LABEL_CLASS = 'hidden @[26rem]/customize-row-subtitle:inline';

/** A chip's short harness name; the Works with filter keeps the full names. */
const CHIP_NAMES: Readonly<Record<CustomizeDiscoveryHarness, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

function harnessFullName(harness: CustomizeDiscoveryHarness): string {
  return (
    CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.find(
      (option) => option.value === harness,
    )?.label ?? CHIP_NAMES[harness]
  );
}

/** "Claude Code, Codex and Cursor". */
function nameList(harnesses: readonly CustomizeDiscoveryHarness[]): string {
  const names = harnesses.map(harnessFullName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function HarnessMark({
  harness,
}: {
  readonly harness: CustomizeDiscoveryHarness;
}): JSX.Element {
  const { className, px } = BADGE_ICON_BY_SIZE.regular;
  switch (harness) {
    case 'claude':
      return <ClaudeLogo width={px} height={px} className={className} />;
    case 'codex':
      return <CodexLogo width={px} height={px} className={className} />;
    case 'cursor':
      return <CursorLogo width={px} height={px} className={className} />;
    case 'copilot':
      // GitHub retired Copilot's own icon and mascot head; the approved
      // product lockup is the Invertocat beside "Copilot"
      // (https://brand.github.com/brand-identity/copilot).
      return <GitHubIcon size={px} exactSize className={className} />;
    case 'opencode':
      return <OpenCodeLogo width={px} height={px} className={className} />;
  }
}

/**
 * A Customize row's "Works with" chips (CAN-6813): up to three harness marks
 * with their names, then "+N more". Reads the CAN-6807 compatibility through
 * `customizeWorksWithChips`, which falls back to the published harness.
 */
export function CustomizeWorksWithChips({
  entry,
}: {
  readonly entry: Pick<
    UnifiedPluginEntry,
    | 'id'
    | 'providerSupport'
    | 'harnessCompatibility'
    | 'marketplaceListings'
    | 'chatGptAppStandIn'
  >;
}): JSX.Element | null {
  const { shown, more } = customizeWorksWithChips(entry);
  if (shown.length === 0) return null;
  const chip = badgeClassName('neutral');
  return (
    <span
      data-testid={`customize-row-works-with-${entry.id}`}
      className="pointer-events-auto flex shrink-0 items-center gap-1"
    >
      <span className="sr-only">
        {`Works with the ${nameList([...shown, ...more])} ${shown.length + more.length === 1 ? 'harness' : 'harnesses'}`}
      </span>
      {shown.map((harness) => (
        <Tooltip
          key={harness}
          label={customizeWorksWithChipLabel(
            entry,
            harness,
            harnessFullName(harness),
          )}
        >
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entry.id}-${harness}`}
            className={chip}
          >
            <HarnessMark harness={harness} />
            {/* A narrow row keeps the marks and drops the names, so the
                publisher stays readable; the tooltip still names it. */}
            <span className={CHIP_LABEL_CLASS}>{CHIP_NAMES[harness]}</span>
          </span>
        </Tooltip>
      ))}
      {more.length > 0 && (
        <Tooltip label={`Also works with ${nameList(more)}`}>
          <span
            aria-hidden="true"
            data-testid={`customize-row-works-with-${entry.id}-more`}
            className={chip}
          >
            {`+${more.length}`}
            <span className={CHIP_LABEL_CLASS}> more</span>
          </span>
        </Tooltip>
      )}
    </span>
  );
}
