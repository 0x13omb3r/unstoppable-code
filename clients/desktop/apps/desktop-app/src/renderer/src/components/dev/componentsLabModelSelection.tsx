import type { JSX } from 'react';
import {
  ModelSelectionNotice,
  type ModelSelectionFailure,
} from '@canopy/ui-shared/components';
import { SpecimenCell, SpecimenPanel } from './componentsLabParts';

const cases: readonly {
  label: string;
  failure: ModelSelectionFailure | undefined;
}[] = [
  { label: 'Hidden: no failure', failure: undefined },
  {
    label: 'Desktop refusal: preserve the answer from an older desktop',
    failure: { reported: true, message: 'model must be a known model id.' },
  },
  {
    label: 'Not confirmed: a timeout or lost reply is not a refusal',
    failure: {
      reported: false,
      message: 'Check the selection before trying again.',
    },
  },
  {
    label: 'Desktop refusal: long explanation at narrow width',
    failure: {
      reported: true,
      message:
        'This Agent cannot run on the selected model on your computer. Choose another model or update the desktop app before selecting this combination again.',
    },
  },
  {
    label: 'Not confirmed: long explanation at narrow width',
    failure: {
      reported: false,
      message:
        'The connection to your computer closed before it confirmed the change. The selection may still have been saved. Check the selection before trying again.',
    },
  },
  {
    label: 'Desktop refusal: no explanation',
    failure: { reported: true, message: '' },
  },
  {
    label: 'Not confirmed: no explanation',
    failure: { reported: false, message: '' },
  },
];

export function ModelSelectionSpecimen(): JSX.Element {
  return (
    <SpecimenPanel title="ModelSelectionNotice: refused and unconfirmed changes">
      {cases.map(({ label, failure }) => (
        <SpecimenCell key={label} label={label} wide>
          <div className="w-full max-w-xs">
            <ModelSelectionNotice failure={failure} />
          </div>
        </SpecimenCell>
      ))}
    </SpecimenPanel>
  );
}
