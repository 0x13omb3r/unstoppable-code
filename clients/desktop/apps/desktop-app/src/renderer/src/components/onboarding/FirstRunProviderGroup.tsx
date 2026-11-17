import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { AiGatewayPresetId } from '@canopy/protocol/model-gateway/presets';
import { SettingsGroup } from '@/components/settings/SettingsLayout';
import {
  AiGatewaySetupLink,
  ConfiguredAiGatewayRow,
  DesktopAiGatewayDialog,
  useDesktopAiGatewayEntry,
} from '@/components/aiGateway/DesktopAiGatewayEntry';

/**
 * First run's provider rows plus its quiet way to use an AI gateway
 * (`useDesktopAiGatewayEntry`). Nothing extra shows until the account is
 * read. Before a gateway is set up, a link and the preset marks sit below
 * the box; then a row in the box shows its name, model count, and whether
 * this computer has its key. The provider-choice dialog offers the same.
 */
export function FirstRunProviderGroup({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const gateway = useDesktopAiGatewayEntry();
  const [open, setOpen] = useState<{
    readonly presetId?: AiGatewayPresetId;
  } | null>(null);
  const dialogKey = gateway?.dialogKey;

  useEffect(() => {
    setOpen(null);
  }, [dialogKey]);

  if (gateway === null) {
    return <SettingsGroup>{children}</SettingsGroup>;
  }
  const { summary } = gateway;

  return (
    <>
      <SettingsGroup>
        {children}
        {summary ? (
          <ConfiguredAiGatewayRow
            summary={summary}
            onEdit={() => setOpen({})}
            testIdPrefix="first-run-ai-gateway"
          />
        ) : null}
      </SettingsGroup>
      {summary ? null : (
        <AiGatewaySetupLink
          testId="first-run-ai-gateway-link"
          onOpen={(presetId) => setOpen(presetId ? { presetId } : {})}
        />
      )}
      {open ? (
        <DesktopAiGatewayDialog
          key={gateway.dialogKey}
          client={gateway.client}
          organizationId={gateway.organizationId}
          {...(open.presetId ? { initialPresetId: open.presetId } : {})}
          onClose={() => setOpen(null)}
          onSaved={(config) => {
            gateway.onSaved(config);
            setOpen(null);
          }}
          testIdPrefix="first-run-ai-gateway"
        />
      ) : null}
    </>
  );
}
