interface ChatLearningFlagSource {
  isEnabled(): boolean;
  subscribe(listener: () => void): () => void;
}

let source: ChatLearningFlagSource | null = null;

/** The startup composition supplies the host; generic consumers never load it. */
export function installChatLearningFlagSource(
  next: ChatLearningFlagSource,
): void {
  source = next;
}

export function isChatLearningFlagEnabled(): boolean {
  try {
    return source?.isEnabled() ?? false;
  } catch {
    return false;
  }
}

export function onChatLearningFlagChanged(listener: () => void): () => void {
  return source?.subscribe(listener) ?? ((): void => {});
}
