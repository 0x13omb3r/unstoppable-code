import { useState, type JSX } from 'react';
import {
  CopyMcpServerDialog,
  McpServerManagementActions,
  mcpServerCopySlots,
} from '@canopy/ui-app/capability';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

/** A fixture HTTP server with two headers and a token, as references only. */
const SERVER = {
  definition: {
    type: 'http',
    headers: { 'X-Api-Key': { kind: 'stored-secret', ref: 'lab-1' } },
  },
  configs: [
    {
      id: 'default',
      extraHeaders: { 'X-Team': { kind: 'stored-secret', ref: 'lab-2' } },
      authToken: { kind: 'stored-secret', ref: 'lab-3' },
    },
  ],
};

const done = (): Promise<void> => Promise.resolve();

function Actions({ copy }: { readonly copy: boolean }): JSX.Element {
  const available = { available: true as const, run: done };
  return (
    <McpServerManagementActions
      targetKey="lab-tracker"
      serverName="Tracker"
      placement="device"
      {...(copy ? { copyToCloud: available } : {})}
      moveToCloud={available}
      deleteServer={available}
    />
  );
}

/**
 * Adding a desktop MCP server to the cloud account (CAN-6176 PR 4b),
 * rendered from fixtures: the server page's actions before and after Add to
 * cloud, and its consent dialog with every secret unticked.
 */
export function CopyMcpServerSpecimen(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <SpecimenPanel title="Add to cloud (fixture render)">
      <SpecimenCell label="Server actions before: Move to cloud only" wide>
        <div className="w-full" data-testid="lab-copy-before">
          <Actions copy={false} />
        </div>
      </SpecimenCell>
      <SpecimenCell
        label="Server actions after: Add to cloud beside Move to cloud"
        wide
      >
        <div className="w-full" data-testid="lab-copy-after">
          <Actions copy />
        </div>
      </SpecimenCell>
      {open && (
        <CopyMcpServerDialog
          serverName="Tracker"
          host="mcp.tracker.example"
          slots={mcpServerCopySlots(SERVER, 'default')}
          signsInOnCloud={false}
          onCopy={done}
          onClose={(): void => setOpen(false)}
        />
      )}
    </SpecimenPanel>
  );
}
