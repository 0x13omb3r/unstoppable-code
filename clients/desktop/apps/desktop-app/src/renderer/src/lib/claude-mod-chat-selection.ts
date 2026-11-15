/**
 * The person's selection in the chat whose composer is `composer`, for a
 * Mod's `$.ui.selection`: only text that lies wholly in that chat's own
 * surface and outside the composer, whose draft a Mod reads another way.
 * `null` for none.
 */
export function readChatSelection(composer: HTMLElement | null): string | null {
  // The chat surface in either layout (a panel or the floating App
  // Advisor); a composer outside one falls back to its panel.
  const surface = composer?.closest('[data-chat-surface], [data-panel-id]');
  const selection = composer?.ownerDocument.getSelection();
  const anchor = selection?.anchorNode;
  const focus = selection?.focusNode;
  if (
    !composer ||
    !surface ||
    !selection ||
    selection.isCollapsed ||
    !anchor ||
    !focus ||
    !surface.contains(anchor) ||
    !surface.contains(focus) ||
    composer.contains(anchor) ||
    composer.contains(focus)
  ) {
    return null;
  }
  const text = selection.toString();
  return text === '' ? null : text;
}
