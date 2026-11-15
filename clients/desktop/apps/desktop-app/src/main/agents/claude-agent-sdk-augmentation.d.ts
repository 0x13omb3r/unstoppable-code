import '@anthropic-ai/claude-agent-sdk';

declare module '@anthropic-ai/claude-agent-sdk' {
  interface Query {
    applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
    /** A raw control request, such as a Mod surface `ui_*` request. */
    request(request: Record<string, unknown>): Promise<unknown>;
    /**
     * Answers the CLI's `ui_*` requests to a client that named them in
     * `ui_attach.answers`; `undefined` removes the host. Each method gets the
     * request without its `subtype`, and its result is the response.
     */
    setUiHost(
      host:
        | Partial<
            Record<
              | 'copy'
              | 'promptRead'
              | 'promptFill'
              | 'promptPaint'
              | 'promptSuggest'
              | 'readSelection',
              (
                request: Record<string, unknown>,
                options: { readonly signal: AbortSignal },
              ) => Promise<Record<string, unknown>>
            >
          >
        | undefined,
    ): void;
  }
}
