/**
 * "{A}" / "{A} and {B}" / "{A}, {B} and {C}" — an organization-name list for
 * callers that supply their own surrounding sentence.
 *
 * Use it instead of `names.join(', ')`, which reads correctly for one org and
 * then silently degrades: a bare join dropped into singular phrasing renders
 * "Acme, Initech does not have an active plan". Callers still own their own
 * verb agreement — see `names.length === 1` at each call site. Pure display,
 * no data access, per the `@canopy/ui-shared` boundary.
 */
export function formatOrgNameList(names: readonly string[]): string {
  if (names.length === 0) {
    return '';
  }
  if (names.length === 1) {
    return `${names[0]}`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
