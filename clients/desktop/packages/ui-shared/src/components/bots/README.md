# Bot identity display

`BotGlyph` renders a portable `BotGlyph` from `@canopy/protocol/bot-glyph`.
Use its dedicated `@canopy/ui-shared/components/BotGlyph` entry when only the
identity tile is needed; the picker and emoji data can be tree-shaken away.
`BotGlyphControl` is the settings avatar and its anchored picker. Hosts own the
value, saving, and recent emoji history. On the default orbit, color choices
remain pending locally until an icon or emoji is explicitly selected. `BotGlyphPicker` is the same picker
body for other host-owned overlays. No surface is mounted in the product yet.

Use `deriveBotColors(color, theme)` for tile, ink, bubble, and swatch colors.
`theme` contains resolved sRGB semantic surface/foreground/categorical tokens,
not a fixed light/dark palette. The components resolve their owning document's
tokens and remeasure on theme changes. Custom hex is user data, normalized to
six digits and never interpolated into CSS. Invalid data falls back to the
neutral token. The helper solves 4.5:1 ink against the hosting surface, tile,
and bubble, and chooses a contrasting selected-swatch check. The stored custom
color remains unchanged. Emoji tiles are neutral while their color remains
available to future bubble consumers.

The bounded emoji and custom-color exceptions are specified in the
[Bot UX plan](../../../../../docs/planning/2026-11-12-user-defined-bots/02-product-and-ux.md#glyph-picker).
Controls and status icons remain manifest Lucide icons. Icon artwork sizes use
DESIGN.md's scale rather than the mock's off-scale 11/13/26px sizes. The native
color-area slider changes saturation with Left/Right and brightness with
Up/Down; Shift takes larger steps. Hue uses the shared Slider.

## Bundled emoji data

`emoji-data.json` contains the fully-qualified identity entries and English
CLDR short names from Unicode Emoji 16.0's
[emoji-test.txt](https://unicode.org/Public/emoji/16.0/emoji-test.txt), grouped
by its standard categories, excluding standalone Components. The Unicode
license is beside it in `UNICODE-LICENSE.txt`. It contains no images or font
assets. Native platform emoji fonts render the text, with no runtime fetch or
new CSP origin. The picker renders 120 entries at a time, with Show more emoji;
search always covers the entire bundled set. Frequently used is shown only
when the host supplies actual history. Host history is neither stored nor
invented by this package.
