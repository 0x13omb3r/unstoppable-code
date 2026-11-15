import { Surface } from '@canopy/ui-shared/components';
import type { JSX } from 'react';
import { DialogModal } from './DialogModal';
import { Button } from './Button';
import type { VoiceErrorGuidance } from '../../lib/voice/voice-error';

interface VoiceErrorModalProps {
  guidance: VoiceErrorGuidance;
  onClose: () => void;
  onOpenSettings?: () => void;
}

export function VoiceErrorModal({
  guidance,
  onClose,
  onOpenSettings,
}: VoiceErrorModalProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={guidance.title}
      subtitle="Voice dictation can't start until this is fixed."
      maxWidth="md"
      dataTestId="voice-error-modal"
    >
      <div className="flex flex-col gap-4">
        <ol className="flex flex-col gap-2 text-s fg-primary">
          {guidance.steps.map((step, index) => (
            <li key={index} className="flex gap-3">
              <Surface as="span" variant="guidance-step" aria-hidden>
                {index + 1}
              </Surface>
              <span className="leading-5">{step}</span>
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            variant="secondary"
            size="compact"
            onClick={onClose}
            data-testid="voice-error-modal-close"
          >
            Close
          </Button>
          {guidance.settingsUrl && guidance.settingsLabel && onOpenSettings && (
            <Button
              variant="primary"
              size="compact"
              onClick={onOpenSettings}
              data-testid="voice-error-modal-settings"
              autoFocus
            >
              {guidance.settingsLabel}
            </Button>
          )}
        </div>
      </div>
    </DialogModal>
  );
}
