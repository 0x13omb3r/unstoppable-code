'use client';

import { useRef, useState, type JSX } from 'react';
import {
  Button,
  ChoiceField,
  Count,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuRowStyleProvider,
  FloatingMenu,
  PickerMenuSectionLabel,
  PickerTrigger,
  PickerTriggerChevron,
  Popover,
  QUIET_MENU_ROW_STYLE,
  RailIconButton,
  SegmentedControl,
  SettingsSelect,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  FilterIcon,
  PlusIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS,
  CUSTOMIZE_DISCOVERY_STATUS_OPTIONS,
  customizeDiscoveryFilterCount,
  type CustomizeDiscoveryFilters,
  type CustomizeDiscoveryHarness,
} from '@canopy/ui-shared/lib';
import {
  useCustomizeDiscoveryFilters,
  useCustomizeDiscoverySourceOptions,
} from './CustomizeDiscoveryProvider';

export interface CustomizeDiscoveryFilterMenuProps {
  /** Runs after any filter changes, such as to drop a focused section. */
  readonly onFiltersChanged?: () => void;
  /** Opens the host's harness setup; omitted where the host has none. */
  readonly onAddHarness?: () => void;
  /** Opens the Marketplaces view; omitted where the host has none. */
  readonly onManageMarketplaces?: () => void;
}

const ANY_SOURCE = '';
const TEST_ID = 'customize-discovery-filter';

function harnessLabel(harnesses: readonly CustomizeDiscoveryHarness[]): string {
  if (harnesses.length === 0) return 'Any harness';
  const labels = CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.filter((option) =>
    harnesses.includes(option.value),
  ).map((option) => option.label);
  return labels.length <= 2
    ? labels.join(', ')
    : `${String(labels.length)} harnesses`;
}

/** Works with: a multi-select field that starts at Any harness. */
function HarnessSelect({
  value,
  onChange,
  onAddHarness,
}: {
  readonly value: readonly CustomizeDiscoveryHarness[];
  readonly onChange: (value: readonly CustomizeDiscoveryHarness[]) => void;
  readonly onAddHarness?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = harnessLabel(value);
  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        variant="field"
        className="w-full"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Works with: ${label}`}
        data-testid={`${TEST_ID}-harness`}
        onClick={(): void => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        closeOnSelect={false}
        className="min-w-56"
        aria-label="Works with"
        data-testid={`${TEST_ID}-harness-menu`}
      >
        <DropdownMenuRowStyleProvider value={QUIET_MENU_ROW_STYLE}>
          <DropdownMenuItem
            role="menuitemradio"
            aria-checked={value.length === 0}
            data-testid={`${TEST_ID}-harness-any`}
            onClick={(): void => onChange([])}
          >
            <DropdownMenuItemIcon>
              {value.length === 0 ? <CheckIcon size="sm" aria-hidden /> : null}
            </DropdownMenuItemIcon>
            <span className="truncate">Any harness</span>
          </DropdownMenuItem>
          {CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map((option) => {
            const checked = value.includes(option.value);
            return (
              <DropdownMenuItem
                key={option.value}
                role="menuitemcheckbox"
                aria-checked={checked}
                data-testid={`${TEST_ID}-harness-option-${option.value}`}
                onClick={(): void =>
                  onChange(
                    checked
                      ? value.filter((harness) => harness !== option.value)
                      : CUSTOMIZE_DISCOVERY_HARNESS_OPTIONS.map(
                          (candidate) => candidate.value,
                        ).filter(
                          (harness) =>
                            harness === option.value || value.includes(harness),
                        ),
                  )
                }
              >
                <DropdownMenuItemIcon>
                  {checked ? <CheckIcon size="sm" aria-hidden /> : null}
                </DropdownMenuItemIcon>
                <span className="truncate">{option.label}</span>
              </DropdownMenuItem>
            );
          })}
          {onAddHarness ? (
            <>
              <DropdownMenuDivider />
              <DropdownMenuItem
                data-testid={`${TEST_ID}-add-harness`}
                onClick={(): void => {
                  setOpen(false);
                  onAddHarness();
                }}
              >
                <DropdownMenuItemIcon>
                  <PlusIcon size="sm" aria-hidden />
                </DropdownMenuItemIcon>
                <span className="truncate">Add harness</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuRowStyleProvider>
      </FloatingMenu>
    </>
  );
}

/**
 * New Customize's filter button after the search (CAN-6809): an icon button
 * with a count while filters are on, opening one menu with Status, Also show,
 * Source, Works with and Manage marketplaces. Shared by desktop and Portal;
 * the host owns the filters.
 *
 * Deliberate deviation from docs/design/search.md (more than three filters go
 * behind a `Filter · n` dropdown of submenus): the CAN-6809 design draws one
 * panel with every filter visible, so this composes the shared Popover,
 * SegmentedControl, ChoiceField and SettingsSelect instead.
 */
export function CustomizeDiscoveryFilterMenu({
  onFiltersChanged,
  onAddHarness,
  onManageMarketplaces,
}: CustomizeDiscoveryFilterMenuProps): JSX.Element {
  const { filters, setFilters } = useCustomizeDiscoveryFilters();
  const sourceOptions = useCustomizeDiscoverySourceOptions();
  const onFiltersChange = (next: CustomizeDiscoveryFilters): void => {
    setFilters(next);
    onFiltersChanged?.();
  };
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeCount = customizeDiscoveryFilterCount(filters);
  const name =
    activeCount > 0 ? `Filters: ${String(activeCount)} on` : 'Filter';
  // A source the entries no longer carry still shows as picked, so it can be
  // cleared.
  const sources =
    filters.source !== null && !sourceOptions.includes(filters.source)
      ? [...sourceOptions, filters.source]
      : sourceOptions;
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        size="row"
        tone={activeCount > 0 ? 'secondary' : 'neutral'}
        aria-label={name}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Filter"
        data-testid={TEST_ID}
        data-active={activeCount > 0 ? 'true' : 'false'}
        onClick={(): void => setOpen((current) => !current)}
      />
      {activeCount > 0 && (
        <Count
          value={activeCount}
          placement="icon"
          tone="unread"
          aria-hidden
          data-testid={`${TEST_ID}-count`}
          className="pointer-events-none absolute -right-1 -top-1"
        />
      )}
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        width="lg"
        aria-label="Filter"
        data-testid={`${TEST_ID}-menu`}
      >
        <div className="flex flex-col gap-3">
          <section className="flex flex-col gap-1">
            <PickerMenuSectionLabel>Status</PickerMenuSectionLabel>
            <SegmentedControl
              label="Status"
              value={filters.status}
              width="fill"
              options={CUSTOMIZE_DISCOVERY_STATUS_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
                dataTestId: `${TEST_ID}-status-${option.value}`,
              }))}
              onChange={(status): void =>
                onFiltersChange({ ...filters, status })
              }
              dataTestId={`${TEST_ID}-status`}
            />
          </section>
          <section className="flex flex-col gap-1">
            <PickerMenuSectionLabel>Also show</PickerMenuSectionLabel>
            <ChoiceField
              layout="row"
              label="Collections"
              checked={filters.collections}
              data-testid={`${TEST_ID}-collections`}
              onChange={(event): void =>
                onFiltersChange({
                  ...filters,
                  collections: event.currentTarget.checked,
                })
              }
            />
            <ChoiceField
              layout="row"
              label="Agents"
              checked={filters.agents}
              data-testid={`${TEST_ID}-agents`}
              onChange={(event): void =>
                onFiltersChange({
                  ...filters,
                  agents: event.currentTarget.checked,
                })
              }
            />
          </section>
          <section className="flex flex-col gap-1">
            <PickerMenuSectionLabel>Source</PickerMenuSectionLabel>
            <SettingsSelect<string>
              width="fill"
              aria-label="Source"
              data-testid={`${TEST_ID}-source`}
              value={filters.source ?? ANY_SOURCE}
              options={[
                { value: ANY_SOURCE, label: 'Any marketplace' },
                ...sources.map((source) => ({ value: source, label: source })),
              ]}
              onValueChange={(source): void =>
                onFiltersChange({
                  ...filters,
                  source: source === ANY_SOURCE ? null : source,
                })
              }
            />
          </section>
          <section className="flex flex-col gap-1">
            <PickerMenuSectionLabel>Works with</PickerMenuSectionLabel>
            <HarnessSelect
              value={filters.harnesses}
              onChange={(harnesses): void =>
                onFiltersChange({ ...filters, harnesses })
              }
              onAddHarness={
                onAddHarness
                  ? (): void => {
                      setOpen(false);
                      onAddHarness();
                    }
                  : undefined
              }
            />
          </section>
          {onManageMarketplaces ? (
            <Button
              variant="link"
              className="self-start"
              data-testid={`${TEST_ID}-manage-marketplaces`}
              onClick={(): void => {
                setOpen(false);
                onManageMarketplaces();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <SettingsIcon size="sm" aria-hidden />
                Manage marketplaces…
              </span>
            </Button>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}
