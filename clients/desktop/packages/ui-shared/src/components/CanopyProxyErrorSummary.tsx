import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { CanopyProxyError } from '@canopy/protocol';
import { createCanopyProxyAppError } from '@canopy/protocol/app-errors';
import { CanopyProxyErrorPresentation } from './CanopyProxyErrorPresentation';
import { AiCreditsStopLine } from './AiCreditsStopLine';
import { NoticeButton } from './Notice';
import { recordSurfacedError } from '../lib/surfaced-error-port';

const AccountRecoveryContext = createContext<(() => void) | null>(null);

export interface CanopyProxyRetryRecovery {
  checkAvailability: (messageId: string) => Promise<boolean>;
  retry: (messageId: string) => Promise<void>;
}
const RetryRecoveryContext = createContext<CanopyProxyRetryRecovery | null>(
  null,
);

/** A host supplies authoritative availability and a guarded recovery port. */
export function CanopyProxyRetryRecoveryProvider({
  value,
  children,
}: {
  value: CanopyProxyRetryRecovery;
  children: ReactNode;
}): JSX.Element {
  return (
    <RetryRecoveryContext.Provider value={value}>
      {children}
    </RetryRecoveryContext.Provider>
  );
}

/** Hosts supply their existing account destination; read-only views omit it. */
export function CanopyProxyAccountRecoveryProvider({
  onOpenSettings,
  children,
}: {
  onOpenSettings: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <AccountRecoveryContext.Provider value={onOpenSettings}>
      {children}
    </AccountRecoveryContext.Provider>
  );
}

/** Same settings action for the desktop notice and Portal recovery. */
export function CanopyProxySettingsAction({
  onClick,
  dataTestId = 'chat-canopy-proxy-error-open-settings',
}: {
  onClick: () => void;
  dataTestId?: string;
}): JSX.Element {
  return (
    <NoticeButton variant="primary" data-testid={dataTestId} onClick={onClick}>
      Open settings
    </NoticeButton>
  );
}

export interface CanopyProxyErrorSummaryProps {
  error: CanopyProxyError;
  dataTestId?: string;
  messageId?: string;
}

/** One plain, catalog-owned refusal on desktop and every Portal transcript. */
export function CanopyProxyErrorSummary({
  error,
  dataTestId = 'canopy-proxy-error-summary',
  messageId,
}: CanopyProxyErrorSummaryProps): JSX.Element {
  const openSettings = useContext(AccountRecoveryContext);
  const recovery = useContext(RetryRecoveryContext);
  const [availability, setAvailability] = useState<{
    recovery: CanopyProxyRetryRecovery;
    messageId: string;
    allowed: boolean;
  } | null>(null);
  const available =
    availability?.recovery === recovery &&
    availability?.messageId === messageId &&
    availability?.allowed === true;
  const [retrying, setRetrying] = useState(false);
  const sending = useRef(false);
  const { code, correlationId } = error;
  useEffect(() => {
    let current = true;
    if (code === 'upstream_unavailable' && recovery && messageId) {
      void recovery.checkAvailability(messageId).then(
        (allowed) => {
          if (current) setAvailability({ recovery, messageId, allowed });
        },
        () => {
          if (current) setAvailability(null);
        },
      );
    }
    return (): void => {
      current = false;
    };
  }, [code, recovery, messageId]);
  const appError = useMemo(
    () => createCanopyProxyAppError({ code, correlationId, message: null }),
    [code, correlationId],
  );
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (recorded.current === appError.referenceId) return;
    recorded.current = appError.referenceId;
    recordSurfacedError({
      chokePoint: 'notice',
      identifier: 'chat-ai-credits-refusal',
      surface: 'inline',
      error: appError,
    });
  }, [appError]);
  if (code === 'no_billing_source')
    return <AiCreditsStopLine dataTestId={dataTestId} />;
  const summary = (
    <span data-testid={dataTestId} className="text-xs fg-tertiary text-pretty">
      {appError.copy.title}
      {appError.copy.description ? ` ${appError.copy.description}` : ''}
    </span>
  );
  if (code === 'upstream_unavailable' && recovery) {
    return (
      <CanopyProxyErrorPresentation
        state="unresolved"
        diagnostics="inline"
        announcement="live"
        correlationId={correlationId}
        dataTestId={`${dataTestId}-notice`}
        actions={
          available && messageId ? (
            <NoticeButton
              variant="primary"
              data-testid={`${dataTestId}-retry`}
              disabled={retrying}
              onClick={() => {
                if (sending.current) return;
                sending.current = true;
                setRetrying(true);
                void recovery
                  .retry(messageId)
                  .then(
                    () => setAvailability(null),
                    () => setAvailability(null),
                  )
                  .finally(() => {
                    sending.current = false;
                    setRetrying(false);
                  });
              }}
            >
              Try again
            </NoticeButton>
          ) : undefined
        }
      >
        {summary}
      </CanopyProxyErrorPresentation>
    );
  }
  return code === 'credentials_unavailable' && openSettings ? (
    <CanopyProxyErrorPresentation
      state="unresolved"
      diagnostics="inline"
      announcement="live"
      correlationId={correlationId}
      dataTestId={`${dataTestId}-notice`}
      actions={
        <CanopyProxySettingsAction
          onClick={openSettings}
          dataTestId={`${dataTestId}-open-settings`}
        />
      }
    >
      {summary}
    </CanopyProxyErrorPresentation>
  ) : (
    summary
  );
}
