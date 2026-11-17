const PREVIEW_TIMEOUT_MS = 9_000;

class ProjectPreviewTimeout extends Error {}

async function whilePreviewActive<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let cancel = (): void => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = (): void => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Project preview was cancelled.'),
        );
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([read(), cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function withPersonalProjectPreviewDeadline<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = PREVIEW_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(
      new ProjectPreviewTimeout('Loading projects took too long. Try again.'),
    );
  }, timeoutMs);
  timer.unref();
  try {
    return await whilePreviewActive(() => read(signal), signal);
  } finally {
    clearTimeout(timer);
  }
}
