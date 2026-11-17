/**
 * Body-level "a menu is open" flag, reference-counted across every open menu
 * surface (FloatingMenu, bespoke dropdown portals). While set,
 * the app suppresses hover feedback on inert background surfaces (see the
 * `data-sidebar-menu-open` rules in the desktop globals.css). One shared
 * counter per document keeps overlapping menus from clearing each other's
 * flag.
 */
const countsByDocument = new WeakMap<Document, number>();

type DismissalClickGuard = (target: EventTarget | null) => boolean;
const clickGuardsByDocument = new WeakMap<Document, Set<DismissalClickGuard>>();

/** Open a replacement menu on pointerdown when its click will be consumed. */
export function menuDismissalSwallowsClick(
  doc: Document,
  target: EventTarget | null,
): boolean {
  const guards = clickGuardsByDocument.get(doc);
  return guards ? [...guards].some((guard) => guard(target)) : false;
}

export function registerMenuDismissalClickGuard(
  doc: Document,
  guard: DismissalClickGuard,
): () => void {
  let guards = clickGuardsByDocument.get(doc);
  if (!guards) {
    guards = new Set();
    clickGuardsByDocument.set(doc, guards);
  }
  const registered = guards;
  registered.add(guard);
  return (): void => {
    registered.delete(guard);
  };
}

export function pushMenuOpenBodyFlag(doc: Document): () => void {
  countsByDocument.set(doc, (countsByDocument.get(doc) ?? 0) + 1);
  doc.body.dataset.sidebarMenuOpen = 'true';
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    const next = Math.max(0, (countsByDocument.get(doc) ?? 1) - 1);
    countsByDocument.set(doc, next);
    if (next === 0) {
      delete doc.body.dataset.sidebarMenuOpen;
    }
  };
}
