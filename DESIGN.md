# AgentChat Design System

## 1. Atmosphere & Identity

AgentChat is a quiet dispatch desk for supervising many agents: compact, legible, and calm under activity. The signature is the **signal seam**, a jade line that connects the selected rail mode to its working view. Everything else stays restrained so status and conversation carry the emphasis.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---|---|
| Canvas | `--color-canvas` | `#17181d` | Window backdrop |
| Rail | `--color-rail` | `#202127` | Primary navigation |
| List | `--color-list` | `#f0f1f4` | Context list |
| View | `--color-view` | `#fafafa` | Work surface |
| Raised | `--color-raised` | `#ffffff` | Empty-state panel |
| Ink | `--color-ink` | `#22242b` | Primary text |
| Muted | `--color-muted` | `#63666f` | Secondary text |
| Rail ink | `--color-rail-ink` | `#c8cad2` | Rail labels |
| Hairline | `--color-hairline` | `#dfe1e7` | Dividers |
| Jade | `--color-jade` | `#19a974` | Selection, focus, own bubbles |
| Jade soft | `--color-jade-soft` | `#dff5ec` | Selected list item |
| Error | `--color-error` | `#b83b4b` | Error state |

Only jade indicates selection or positive action. No decorative gradients. Body contrast meets WCAG AA.

## 3. Typography

- UI stack: `"Aptos", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif`.
- Utility stack: `"Cascadia Mono", "Microsoft YaHei UI", monospace`.
- `--text-title`: 24px / 1.25 / 650; page title.
- `--text-heading`: 16px / 1.4 / 650; list and state headings.
- `--text-body`: 14px / 1.6 / 400; body copy.
- `--text-label`: 12px / 1.4 / 600; rail labels and metadata.

## 4. Spacing & Layout

Base unit: 4px. Tokens are `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-5` 20px, `--space-6` 24px, `--space-8` 32px, `--space-10` 40px, `--space-12` 48px.

Desktop grid: 76px rail, 300px list, flexible view. Tablet narrows the list to 248px. Below 720px the rail becomes a bottom bar and the list becomes a compact top strip while retaining three semantic regions.

## 5. Components

### Mode rail item
- **Structure:** button with compact glyph and Chinese label.
- **Spacing:** `--space-2`/`--space-3`; 44px minimum target.
- **States:** muted default, raised hover, jade active seam, jade focus outline.
- **Accessibility:** native button, `aria-pressed`, visible focus.
- **Motion:** opacity/transform only, standard timing.

### State panel
- **Structure:** utility marker, heading, one-sentence guidance.
- **Variants:** loading, empty, error.
- **Spacing:** `--space-6` and `--space-8`.
- **Accessibility:** status semantics for loading/error; plain region for empty.

## 6. Motion & Interaction

- `--duration-micro`: 120ms; press feedback.
- `--duration-standard`: 220ms; selection changes.
- `--ease-standard`: cubic-bezier(0.2, 0.8, 0.2, 1).
- Animate only opacity and transform. Under `prefers-reduced-motion: reduce`, transitions are removed.

## 7. Depth & Surface

**Borders-only.** The three work zones are separated by hairlines and tonal changes. No box shadows. Radius tokens: `--radius-small` 6px, `--radius-medium` 10px, `--radius-large` 18px, used by target size rather than decoration.
