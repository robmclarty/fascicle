# Design Styleguide — "Command Center" Neo-Brutalist Dashboard

A reusable reference distilled from the *Superpowers OS Command Center* dashboard
(`web-production-51dbf.up.railway.app`). Captures the visual language, tokens,
components, charts, motion, and information architecture so you can rebuild a
similar UI from scratch without copying the original.

> **What this is:** a design system you can re-implement. Everything below is
> derived from the live app's compiled CSS and rendered screens. The original is
> a Next.js app; the styling is plain CSS custom properties + Recharts for data
> viz. None of it is framework-locked — the tokens and component recipes drop
> into any stack (vanilla CSS, Tailwind `@theme`, CSS-in-JS, etc).

Companion files in this folder:
- `app.css` / `app.pretty.css` — the original compiled stylesheet (reference only)
- `screens/` — annotated screenshots of every view and key interaction

---

## 1. Design philosophy / the "feeling"

**Neo-brutalist / soft-brutalist, warmed up.** The aesthetic is the modern
"flat brutalism" look (hard 2px black borders, solid offset drop-shadows, no
gradients on chrome) but softened into something friendly and editorial:

- **Warm paper canvas**, not cold white. Everything sits on a cream `#faf3e3`
  background with a faint printed-graph-paper grid.
- **Hard black ink.** A single near-black `#020309` does all the heavy lifting:
  text, borders, shadows, chart bars. High contrast, confident.
- **Chunky offset shadows.** Cards and buttons cast a solid (non-blurred) black
  shadow offset down-right — the "sticker on paper" / risograph look. Shadows
  *move* on interaction rather than fade.
- **Pastel accent fills.** Mint, butter-yellow, blush-pink, and pale-blue fills
  signal meaning (good / highlight / alert / neutral) without ever introducing a
  saturated UI color. The saturation lives only in the charts.
- **Editorial typography.** A geometric grotesk for headings (tight, loud,
  uppercase eyebrows), humanist sans for body, monospace for every number.
- **Numbers are the hero.** KPI values are huge tabular-figure monospace. The
  product is a dashboard; the data is the design.

Adjectives to aim for: *confident, tactile, editorial, warm, analog-digital,
high-contrast, calm-but-loud.* Think "indie SaaS meets printed zine."

It avoids: blur/glassmorphism, soft drop-shadows, gradients on surfaces, thin
1px hairline borders, rounded-everything, generic Inter-on-white.

---

## 2. Design tokens

The entire system runs on ~30 CSS custom properties. Copy this block as your
foundation:

```css
:root {
  /* ---- Core ink + surfaces ---- */
  --dark:       #020309;   /* near-black: text, borders, shadows, chart bars */
  --canvas:     #faf3e3;   /* warm cream page background */
  --surface:    #fdfaf1;   /* slightly lighter card surface */
  --neutral:    #e5f5f9;   /* pale blue (neutral tags / "blue" buttons) */
  --primary:    #d2ecd0;   /* mint green (good / active / highlight) */
  --accent:     #fdeec4;   /* butter yellow (secondary highlight / code) */
  --alert:      #f3c1c0;   /* blush red (alert / churn / errors) */
  --text-muted: #4a4a52;   /* muted body text */
  --muted:      rgba(2,3,9,.06);  /* faint fill */
  --line:       rgba(2,3,9,.1);   /* table row dividers */

  /* ---- Solid offset shadows (no blur) ---- */
  --shadow-sm:    4px 4px 0 var(--dark);
  --shadow:       8px 8px 0 var(--dark);
  --shadow-hover: 6px 6px 0 var(--dark);
  --shadow-lg:    12px 12px 0 var(--dark);

  /* ---- Radii ---- */
  --r:    14px;   /* cards */
  --r-sm: 10px;   /* buttons, nav items, small cards */
  --radius-sm:   4px;   /* dots, chips inner */
  --radius-base: 6px;   /* tags, deltas, chips */
  --radius-md:   8px;
  --radius-lg:  12px;

  /* ---- Border ---- */
  --bd: 2px solid var(--dark);   /* THE border. Used everywhere. */

  /* ---- Type families ---- */
  --heading:   "Space Grotesk", system-ui, sans-serif;
  --body:      "Montserrat", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  /* ---- Motion ---- */
  --motion-fast: 120ms;
  --motion-base: 240ms;
  --motion-slow: 480ms;
  --ease-out:    cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Token usage rules of thumb
- **Border is always `2px solid #020309`.** Never hairline. A few inner details
  step down to `1.5px` (deltas, chip-on-chip) or `1px` (table dividers).
- **Shadow is always solid black, offset down-right.** Default `4px 4px`; large
  hero cards `12px 12px`; hover *reduces* offset to `6px 6px` while the element
  translates toward the shadow (see motion).
- **Fills are semantic, not decorative:** mint = positive/active, yellow =
  highlight/code, pink = alert, pale-blue = neutral/info.

---

## 3. Color system

### Palette swatches

| Role | Hex | Use |
|---|---|---|
| Ink / dark | `#020309` | Text, all borders, all shadows, neutral chart bars |
| Canvas | `#faf3e3` | Page background, topbar, card headers, "inset" wells |
| Surface | `#fdfaf1` | Card bodies, default buttons |
| Primary (mint) | `#d2ecd0` | Active nav, primary buttons, "good" KPI cards, positive deltas |
| Accent (butter) | `#fdeec4` | Secondary buttons, focus cards, inline code, accent chips |
| Alert (blush) | `#f3c1c0` | Alert KPI cards, negative deltas, error chips |
| Neutral (sky) | `#e5f5f9` | Info tags, "blue" buttons |
| Text muted | `#4a4a52` | De-emphasized copy |

All four pastels are tints of the same low-saturation family — they read as a
set. Borders/text on every pastel stay pure `#020309` for contrast.

### Data-viz palette (saturated, charts only)

Charts use a separate **earthy modernist** palette (the classic terracotta /
sage / dusty-navy / mustard set). This is where color saturation is allowed:

| Hex | Name | Semantic use |
|---|---|---|
| `#3D5A80` | Dusty navy | Primary series / "P1 high" / neutral category |
| `#7FBE7C` | Sage green | Positive / "likes" / "P2 normal" / underloaded |
| `#E07A5F` | Terracotta | Negative / high severity / "P0" / overloaded / "comments" |
| `#E8B04B` | Mustard / amber | Medium severity / "P1" |
| `#7B5EA7` | Muted purple | Extra category |
| `#020309` | Ink | Default/neutral bars, "P0 critical" segment |

Severity convention used throughout: **red `#E07A5F` = p0/high, amber
`#E8B04B` = p1/med, blue `#3D5A80` = p2/low.** Diverging bars use **sage for
positive, terracotta for negative** around a zero baseline.

---

## 4. Typography

Three Google Fonts: **Space Grotesk** (headings/UI), **Montserrat** (body),
**JetBrains Mono** (numbers/code).

```
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=Montserrat:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap");
```

### Type roles

| Element | Family | Size | Weight | Tracking | Transform |
|---|---|---|---|---|---|
| Page title (`.cc-title`) | Space Grotesk | 34px | 800 | `-0.02em` | none |
| Eyebrow (`.cc-eyebrow`) | Space Grotesk | 11px | 700 | `0.18em` | UPPERCASE |
| Card heading (`h3`) | Space Grotesk | 14px | 800 | `0.06em` | UPPERCASE |
| Nav section label | Space Grotesk | 10px | 800 | `0.14em` | UPPERCASE |
| Nav item | Space Grotesk | 13.5px | 600 (800 active) | `-0.005em` | none |
| KPI label | Space Grotesk | 11px | 800 | `0.12em` | UPPERCASE |
| **KPI value** | **JetBrains Mono** | **40px** | **700** | `-0.03em` | tabular-nums |
| KPI footnote | Montserrat | 11px | 500 | `0.08em` | UPPERCASE |
| Body / list copy | Montserrat | 14px | 400 | normal | none |
| Table header | Space Grotesk | 11px | 800 | `0.1em` | UPPERCASE |
| Table cell | Montserrat/system | 13px | 400 | normal | tabular-nums |
| Date chip | JetBrains Mono | 11px | 600 | normal | tabular-nums |
| Inline code | mono | 12px | — | — | — |

### Typographic principles
- **Eyebrow + title pairing.** Every screen header is a tiny wide-tracked
  uppercase eyebrow ("SUPERPOWERS OS COMMAND CENTER") stacked above a big tight
  bold title ("Team Dashboard"). This pattern repeats at card level too.
- **Uppercase + wide tracking for all labels/metadata** (`0.06em`–`0.18em`).
  Lowercase is reserved for body prose and prose-y card subtitles.
- **All numbers are monospace with tabular figures** (`font-variant-numeric:
  tabular-nums; font-feature-settings: "tnum";`) so digits align in columns and
  don't jitter when values update.
- **Negative letter-spacing on big headings** (`-0.02em` / `-0.03em`) for a
  tight, modern, condensed feel; positive tracking on small caps labels.

---

## 5. Elevation & borders (the signature look)

Two ingredients create the entire "tactile sticker" feel:

1. **`--bd: 2px solid #020309`** on every surface, button, chip, avatar, dot.
2. **Solid offset shadow** `Npx Npx 0 #020309` (note the `0` blur).

Shadow scale by importance:
- Buttons, KPI cards, nav-active, chips on surfaces → `--shadow-sm` (4/4)
- Big "hero" cards → `--shadow-lg` (12/12) + `--radius-lg`
- Hover (lifted) → `--shadow-hover` (6/6)
- Active/pressed → `2px 2px 0` (shadow nearly collapses)

The trick: **on hover the element translates `-2px,-2px` (up-left, toward its
light source) and the shadow grows to 6/6 — it appears to lift off the page.**
On press it translates `+2px,+2px` and the shadow shrinks to 2/2 — it presses
*into* the page. The shadow offset + translate always sum to a constant, so the
shadow's far corner stays put while the surface moves. This is the core
interaction motif; apply it to anything clickable.

---

## 6. Layout & structure

```
┌─────────────┬──────────────────────────────────────────────┐
│             │  TOPBAR  (eyebrow + title | actions)          │
│  SIDEBAR    ├──────────────────────────────────────────────┤
│  240px      │  MAIN (graph-paper bg, 28–36px padding)       │
│  sticky     │   ┌── KPI row (4-up grid) ──┐                 │
│  surface    │   ├── content grid (2fr/1fr, 3-up, etc) ──┐   │
│  border-r   │   └── wide cards / tables / charts ──┘        │
└─────────────┴──────────────────────────────────────────────┘
```

- **App shell:** `display:flex; min-height:100vh`. Sidebar is `flex: 0 0 240px`,
  `position: sticky; top:0; height:100vh; overflow-y:auto`. Main is `flex: 1 1`.
- **Sidebar** (`--surface` bg, 2px right border): brand block → section label →
  nav buttons → spacer → footer links. Collapses to a 64px icon-rail under
  900px (labels `display:none`).
- **Topbar** (`--canvas` bg, 2px bottom border): left = eyebrow + H1 title;
  right = action buttons. Has a signature animated mint underline (see motion).
- **Main canvas** carries the **graph-paper grid background**:
  ```css
  .cc-main {
    background-image:
      linear-gradient(rgba(2,3,9,.035) 1px, transparent 0),
      linear-gradient(90deg, rgba(2,3,9,.035) 1px, transparent 0);
    background-size: 32px 32px;
    background-position: -1px -1px;
  }
  ```
  A 32px faint grid — the "engineering pad" texture that ties the whole thing to
  the paper metaphor.

### Grid system for content
- **KPI strip:** `grid-template-columns: repeat(4, 1fr); gap: 18px`.
- **Content rows:** a `.cc-grid` set with named ratios:
  - `.cc-grid` → `2fr 1fr` (main + sidebar-ish)
  - `.cc-grid-3` → `1.2fr 1fr 1fr`
  - `.cc-grid-3-1` → `2fr 1fr`
  - `.cc-grid-2` → `1fr 1fr`
  - `.cc-card-wide` → `grid-column: 1 / -1` (full-bleed row)
- Gaps: 18–22px. Section bottom margins: 22–28px.

---

## 7. Component library

Every component is the same recipe: **2px black border + radius + offset shadow
+ semantic pastel fill.** Below are the building blocks with their essential CSS.

### 7.1 Brand mark
Square (38px) with mint fill, 2px border, `--r-sm` radius, small shadow, holds a
single glyph or letter in Space Grotesk 800. Paired with stacked name + wide
uppercase subtitle ("AGENTIC OS" / "SYSTEM LAYER").

### 7.2 Sidebar nav button (`.cc-nav-btn`)
```css
.cc-nav-btn {
  display:flex; align-items:center; gap:12px;
  width:100%; height:42px; padding:0 12px;
  background:transparent; border:2px solid transparent; border-radius:var(--r-sm);
  font-family:var(--heading); font-weight:600; font-size:13.5px; text-align:left;
  transition: background .1s, border-color .1s, transform 80ms, box-shadow 80ms;
}
.cc-nav-btn:hover  { background:var(--canvas); border-color:rgba(2,3,9,.18); }
.cc-nav-btn:active { transform:translate(1px,1px); background:var(--accent); }
.cc-nav-btn.active { background:var(--primary); font-weight:800;
                     border-color:var(--dark); box-shadow:var(--shadow-sm); }
```
Active item = mint fill + full black border + shadow (it becomes a "sticker").
Leading 18px glyph icon + label. A 1px divider + a "back" button variant
(`.cc-nav-back`: canvas fill, bordered, shadowed) for drilling between layers.

### 7.3 Buttons (`.cc-btn`)
```css
.cc-btn {
  display:inline-flex; align-items:center; gap:10px;
  background:var(--surface); color:var(--dark);
  border:var(--bd); border-radius:var(--r-sm); box-shadow:var(--shadow-sm);
  font-family:var(--heading); font-weight:700; font-size:14px; padding:12px 18px;
  transition: transform 80ms, box-shadow 80ms, background 80ms, color 80ms;
  letter-spacing:-.01em;
}
.cc-btn:hover  { background:var(--dark); color:var(--canvas);   /* INK INVERSION */
                 transform:translate(-2px,-2px); box-shadow:var(--shadow-hover); }
.cc-btn:active { transform:translate(2px,2px); box-shadow:2px 2px 0 var(--dark); }
```
Variants by fill: `.cc-btn-primary` (mint), `.cc-btn-accent` (yellow),
`.cc-btn-blue` (sky). The **hover inverts to solid black with cream text** — the
single most recognizable interaction (see `screens/11-button-hover.png`).
`.cc-btn-block` = full-width, big (22px padding, 20px icon, left-aligned) for the
Actions list.

### 7.4 KPI card (`.cc-kpi`)
```css
.cc-kpi {
  background:var(--surface); border:var(--bd); border-radius:var(--r);
  box-shadow:var(--shadow-sm); padding:18px 20px;
  display:flex; flex-direction:column; gap:8px; min-height:170px;
}
.cc-kpi-primary { background:var(--primary); }   /* highlighted metric */
.cc-kpi-alert   { background:var(--alert); }      /* bad metric */
```
Anatomy (top→bottom): **head row** = uppercase label (left) + optional delta
badge (right); **value** = 40px mono tabular number, optional 18px muted unit
suffix (e.g. `7.4 /10`); **foot** = uppercase muted caption pinned to bottom
(`margin-top:auto`). See `screens/01-overview-full.png`, `03-workload.png`.

### 7.5 Delta badge (`.cc-delta`)
Tiny bordered pill (`1.5px` border, `--radius-base`), Space Grotesk 800 11px,
tabular. `▲`/`▼` glyph + percentage. `.cc-delta-pos` = mint fill,
`.cc-delta-neg` = blush fill.

### 7.6 Content card (`.cc-card`)
```css
.cc-card { background:var(--surface); border:var(--bd); border-radius:var(--r);
           box-shadow:var(--shadow-sm); display:flex; flex-direction:column;
           overflow:hidden; }
.cc-card-lg { box-shadow:var(--shadow-lg); border-radius:var(--radius-lg); }
.cc-card-head {                         /* canvas-filled header strip */
  display:flex; align-items:center; justify-content:space-between;
  padding:16px 20px; border-bottom:var(--bd); background:var(--canvas);
}
.cc-card-head h3 { font:800 14px var(--heading); text-transform:uppercase;
                   letter-spacing:.06em; }
.cc-card-body { padding:18px 20px; }
```
A card is a bordered box with a **canvas-tinted header bar** (title left, a
`.cc-tag` or count pill right) and a surface body. The header's contrasting fill
+ bottom border is what makes cards read as "panels."

### 7.7 Tags, chips & badges
- **`.cc-tag`** — header meta pill, sky-blue fill, 2px border, mono-ish caption
  ("7 videos · from youtube snapshot", "red = high severity").
- **`.cc-chip`** — bordered pill; variants `-primary` (mint), `-accent`
  (yellow), `-alert` (pink). Used for stats on person cards & statuses.
- **`.cc-chip-date`** — monospace date pill, lighter `1px rgba` border, no fill
  — for `2026-06-02` style dates in tables.
- **count pill** — small bordered square-ish badge holding a number in card
  headers (e.g. `6`, `11`).

### 7.8 Table (`.cc-table`)
```css
.cc-table { width:100%; border-collapse:collapse; font-size:13px; }
.cc-table th { font:800 11px var(--heading); text-transform:uppercase;
               letter-spacing:.1em; text-align:left; padding:10px 14px;
               background:var(--canvas); border-bottom:var(--bd); }
.cc-table td { padding:10px 14px; border-bottom:1px solid var(--line);
               font-variant-numeric:tabular-nums; }
.cc-table tr:last-child td { border-bottom:none; }
.cc-table tr:hover td      { background:var(--canvas); }   /* row hover */
```
Uppercase wide-tracked headers on a canvas strip with a 2px underline; rows
divided by faint 1px lines; whole row highlights to canvas on hover. Cells mix
mono date chips, accent code chips, and pink status chips. See
`screens/07-tasks.png`, `10b-vault-architecture.png`.

### 7.9 Person card (`.cc-person-card`)
Canvas-filled bordered card: **circular avatar** (48px, mint fill, 2px border) +
name (Space Grotesk 800 17px) & uppercase meta, a focus sentence, then a wrap
row of stat chips (energy/mint, wins/yellow, comments/pink). Hover = lift
(`translate(-2px,-2px)` + `--shadow-hover`). Grid:
`repeat(auto-fill, minmax(280px, 1fr))`. See `screens/06-team.png`.

### 7.10 Action block (`.cc-btn-block`)
Full-width mint block button: emoji/glyph icon (20px) + bold title + muted
description line, left-aligned, big padding. Stacked vertically into an action
list. See `screens/09-actions.png`.

### 7.11 Inline code / ASCII block (`.cc-code`)
Monospace, butter-yellow fill, `1.5px` border, `4px` radius, `1px 6px` padding —
for inline tokens. Also used at block scale for the **ASCII system-architecture
diagram** (monospace art inside a bordered surface well). See
`screens/10-vault-overview.png`.

### 7.12 Smaller patterns
- **`.cc-folder-bar`** — labeled horizontal progress bar: a bordered track
  (`14px` high, canvas fill) with a mint fill that has a `1.5px` right divider,
  plus a mono count. Layout `120px 1fr 36px`.
- **`.cc-dot` / `.cc-kpi-dots`** — row of 14px bordered squares, filled
  (`.cc-dot-on` = ink) or empty, as a discrete sparkline/score.
- **`.cc-ring`** — 70px donut gauges in a 2-up grid of bordered tiles.
- **`.cc-agg-row`** — canvas-filled bordered row: uppercase label + big mono
  value, for aggregate stats.
- **`.cc-focus` card** — accent-yellow body, large 20px Space Grotesk statement
  + uppercase meta; the "today's focus" highlight panel.
- **`.cc-empty`** — centered, low-opacity placeholder in a canvas well.

---

## 8. Data visualization (charts/graphs)

Charts are built with **Recharts** but restyled to match the brutalist system.
The recipe matters more than the library — reproduce it with any SVG chart lib.

### Shared chart styling
- **Axis text:** Space Grotesk, 11px, fill `#020309`.
- **Grid lines:** `stroke: rgba(2,3,9,0.08)` (very faint), horizontal only on bar
  charts.
- **Axis lines / ticks:** ink `#020309`.
- **No rounded bar corners** (`radius: 0`) — bars are hard rectangles.
- **Bars sit inside the standard bordered card** with the canvas header strip; a
  `.cc-tag` legend lives in the card header ("red = high severity",
  "p0 red · p1 amber · p2 blue").
- Numbers/labels use tabular figures.

### Chart types observed (and when to use them)

| Chart | Where | Notes |
|---|---|---|
| **Horizontal bar** | rankings (power users, themes, signal sources) | Category labels on the left axis; flat ink bars for neutral, severity colors when ranking by risk. Most common chart. |
| **Diverging vertical bar** | performance vs. average | Bars grow up (sage `#7FBE7C`) or down (terracotta `#E07A5F`) from a zero reference line. Rotated x labels. |
| **Stacked vertical bar** | task load by owner | Segments e.g. terracotta "High priority" + ink "Normal"; legend swatches below. |
| **Area (gradient)** | reach/volume over time | Smooth `monotone` curve, fill = vertical gradient of the series color from `0.55`→`0.05` opacity, 2px colored stroke on top. |
| **Multi-series stacked area** | daily activity by source | Several overlapping translucent areas (green/terracotta/navy/amber/purple), each with a solid stroke. |
| **Donut / pie** | priority mix | Hollow center; segments ink / navy / sage; **external % labels colored to match their segment**; legend row of swatch+label below. |
| **Sparkline / dot-row** | inside KPI cards | Tiny inline trend (`.cc-spark`) or a row of filled/empty bordered squares. |

### Area gradient recipe (per series)
```html
<linearGradient id="grad-views" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0%"   stop-color="#3D5A80" stop-opacity="0.55"/>
  <stop offset="100%" stop-color="#3D5A80" stop-opacity="0.05"/>
</linearGradient>
```
Use the series color at 55% opacity up top fading to 5% at the baseline; stroke
the curve in the same color at full opacity.

### Legends
Inline row of small colored squares + label, all caps optional. Either below the
chart (donut, stacked bar) or expressed as a descriptive tag in the card header.

See `screens/02b-analytics-charts.png` (diverging bars + area),
`05-intelligence.png` (severity bars), `05b-intelligence-donut.png` (donut),
`03b-workload-heatmap.png` (horizontal + stacked), `08-daily-feed.png`
(multi-series area).

---

## 9. Motion & animation

Motion is **purposeful and physical** — things slide/draw in once, and react
crisply to pointer input. Tokens: `--motion-fast 120ms`, `--motion-base 240ms`,
`--motion-slow 480ms`, easing `--ease-out cubic-bezier(0.2,0.8,0.2,1)`.

### Keyframes
```css
@keyframes cc-spin    { to { transform: rotate(1turn); } }
@keyframes cc-fade-in { 0% { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
@keyframes cc-rise    { 0% { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@keyframes cc-draw    { 0% { transform:scaleX(0); } to { transform:scaleX(1); } }
```

### Where they're used
- **View enter:** the active view fades+rises in (`cc-fade-in`, 240ms). Then its
  direct children **stagger upward** (`cc-rise`) with increasing delays:
  `0 / 60 / 120 / 180 / 240ms` (children 5+ share 240ms). This is the cascade you
  see when switching nav tabs — cards rise into place in sequence.
  ```css
  .cc-view[data-active=true]            { animation: cc-fade-in var(--motion-base) var(--ease-out); }
  .cc-view[data-active=true] > *        { animation: cc-rise var(--motion-base) var(--ease-out) both; }
  .cc-view[data-active=true] > :nth-child(2){ animation-delay:60ms; }
  /* ...3→120ms, 4→180ms, 5+→240ms */
  ```
- **Topbar underline:** a 2px mint line under the topbar draws in left→right via
  `cc-draw` over `--motion-slow` (480ms) using `transform: scaleX()` with
  `transform-origin:left`. A small signature flourish on load.
- **Loader:** 56px ring spinner (`cc-spin`, 0.7s linear infinite) + wide-tracked
  uppercase "loading" label.
- **Hover/press micro-interactions:** 80ms transitions on `transform`,
  `box-shadow`, `background`, `color` — the lift/press + ink-inversion described
  in §5/§7.3. Nav uses 100ms on background/border.
- **Charts** animate their bars/areas in on mount (Recharts default growth).

### Reduced motion
Fully respected — kills animations/transitions and the staggered reveal:
```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after { animation-duration:.001ms!important;
    animation-iteration-count:1!important; transition-duration:.001ms!important; }
  .cc-view[data-active=true] > * { animation:none!important; }
}
```

**Motion principles to carry over:** (1) content *arrives* with a short rise+fade
and a stagger, never just pops; (2) interactive elements respond instantly
(≤120ms) with physical lift/press, not opacity fades; (3) one decorative
"draw-in" accent per screen (the underline) — restraint; (4) always provide the
reduced-motion escape hatch.

---

## 10. Iconography

Icons are **monochrome Unicode geometric glyphs**, not an icon font or SVG set —
rendered in 18px `.cc-icon` spans, inheriting ink color. This reinforces the
analog/terminal vibe and keeps the bundle tiny. Observed mapping:

| Glyph | Meaning | | Glyph | Meaning |
|---|---|---|---|---|
| `◎` | Overview | | `☉` | Daily feed |
| `≣` | Analytics | | `►` | Actions / run |
| `▣` | Workload | | `◈` | Vault / system |
| `❤` | Pulse | | `⚙` | Settings |
| `✦` | Intelligence | | `↻` | Refresh |
| `◍` | Team | | `←` | Back |
| `✓` | Tasks | | `◆ ✦ ⌖ ⊞` | system sub-nav |

Action blocks use **emoji** for warmth (🖥️ briefing, 📺 YouTube, 🗞️ digest,
🧭 review, 💼 CRM). Delta/trend use `▲ ▼`. For a clone, either reuse Unicode
geometric symbols or a thin-stroke geometric icon set (e.g. Lucide at ~1.5–2px)
to match the weight.

---

## 11. Responsive behavior

Three breakpoints, mobile-considerate:

```css
@media (max-width:1200px){
  .cc-kpis { grid-template-columns:repeat(2,1fr); }      /* 4-up → 2-up */
  .cc-grid, .cc-grid-2, .cc-grid-3, .cc-grid-3-1 { grid-template-columns:1fr; } /* stack */
}
@media (max-width:900px){
  .cc-sidebar { flex:0 0 64px; padding:18px 8px; }       /* icon rail */
  .cc-nav-btn { justify-content:center; padding:0; }
  .cc-brand-text, .cc-nav-label, .cc-nav-section { display:none; }
}
@media (max-width:720px){
  .cc-kpis { grid-template-columns:1fr; }                /* single column */
  .cc-main   { padding:20px 16px 60px; }
  .cc-topbar { padding:20px 16px; }
}
```
- ≥1200px: full 4-up KPIs + multi-column content.
- 900–1200px: 2-up KPIs, content columns stack.
- ≤900px: sidebar collapses to a **64px icon-only rail** (glyphs remain).
- ≤720px: everything single-column, tighter padding.

---

## 12. Information architecture & workflows

The product is a **two-layer "command center"**:

**Layer 1 — Team Dashboard** (`/`). Operational view, nav section "TEAM":
`Overview → Analytics → Workload → Pulse → Intelligence → Team → Tasks → Daily
feed → Actions`. It's a single-page app that **swaps `.cc-view` panels client-side**
(no route change) — each nav click toggles `data-active` and triggers the staggered
reveal. The footer links ("Vault overview", "Settings") cross into Layer 2.

**Layer 2 — Vault / System Layer** (`/overview`). Infra/meta view, nav section
"SYSTEM": `Overview → Skills → Operator → Atlas`, with a **"← Back to Home"**
button at the top of the sidebar and the brand subtitle switching to "SYSTEM
LAYER". Holds connectors/skills counts, an ASCII architecture diagram, and a run
history table.

### Page composition pattern (every view)
1. **KPI strip** (4 metric cards) — the headline numbers.
2. **Analytical grid** — 2–3 column rows mixing charts and lists (ratios via
   `.cc-grid-*`).
3. **Wide cards / tables** — full-bleed rows for tables (tasks, run history) or
   big charts.
4. List-style insight cards ("Opportunity briefs", "Churn signals") use bulleted
   `.cc-md-list` with a bold lead (Space Grotesk 800) + prose.

### Workflow feel
- **Refresh-driven:** a prominent "↻ Refresh all" primary button; data reads as
  periodically synced snapshots ("recent snapshot", "1h ago", "past 7d").
- **Run actions:** the Actions view turns workflows into big one-click block
  buttons ("Run morning briefing", "Run YouTube ideation").
- **Drill between layers** via the back/forward nav rather than deep routing.
- **Status as color:** errors/churn surface as pink chips/cards; positives as
  mint; the eye scans color before reading.

---

## 13. Copy-paste starter

A minimal foundation that reproduces the look. Drop in, then build components
from §7 recipes.

```css
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=Montserrat:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap");

:root{
  --dark:#020309; --canvas:#faf3e3; --surface:#fdfaf1;
  --neutral:#e5f5f9; --primary:#d2ecd0; --accent:#fdeec4; --alert:#f3c1c0;
  --text-muted:#4a4a52; --line:rgba(2,3,9,.1);
  --shadow-sm:4px 4px 0 var(--dark); --shadow:8px 8px 0 var(--dark);
  --shadow-hover:6px 6px 0 var(--dark); --shadow-lg:12px 12px 0 var(--dark);
  --r:14px; --r-sm:10px; --bd:2px solid var(--dark);
  --heading:"Space Grotesk",system-ui,sans-serif;
  --body:"Montserrat",system-ui,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --motion-base:240ms; --ease-out:cubic-bezier(0.2,0.8,0.2,1);
}
*{box-sizing:border-box}
body{margin:0;color:var(--dark);font-family:var(--body);background:var(--canvas)}

/* graph-paper canvas */
.canvas{
  background-image:
    linear-gradient(rgba(2,3,9,.035) 1px,transparent 0),
    linear-gradient(90deg,rgba(2,3,9,.035) 1px,transparent 0);
  background-size:32px 32px; background-position:-1px -1px;
}

/* the universal "sticker" surface */
.surface{
  background:var(--surface); border:var(--bd); border-radius:var(--r);
  box-shadow:var(--shadow-sm);
}

/* primary button with ink-inversion hover */
.btn{
  display:inline-flex; align-items:center; gap:10px;
  background:var(--primary); color:var(--dark); border:var(--bd);
  border-radius:var(--r-sm); box-shadow:var(--shadow-sm);
  font:700 14px var(--heading); padding:12px 18px; cursor:pointer;
  transition:transform 80ms,box-shadow 80ms,background 80ms,color 80ms;
}
.btn:hover{ background:var(--dark); color:var(--canvas);
  transform:translate(-2px,-2px); box-shadow:var(--shadow-hover); }
.btn:active{ transform:translate(2px,2px); box-shadow:2px 2px 0 var(--dark); }

/* big mono metric */
.metric{ font:700 40px var(--font-mono); letter-spacing:-.03em;
  font-variant-numeric:tabular-nums; }
/* wide-tracked uppercase label */
.label{ font:800 11px var(--heading); letter-spacing:.12em;
  text-transform:uppercase; opacity:.72; }

/* entrance stagger */
@keyframes rise{0%{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.view>*{animation:rise var(--motion-base) var(--ease-out) both}
.view>:nth-child(2){animation-delay:60ms}
.view>:nth-child(3){animation-delay:120ms}
.view>:nth-child(4){animation-delay:180ms}
.view>:nth-child(n+5){animation-delay:240ms}
@media (prefers-reduced-motion:reduce){ .view>*{animation:none!important} }
```

Recharts (or any lib) defaults to match:
```js
const CHART = {
  ink:'#020309', grid:'rgba(2,3,9,0.08)', axisFont:'Space Grotesk', axisSize:11,
  series:{ navy:'#3D5A80', sage:'#7FBE7C', terracotta:'#E07A5F',
           amber:'#E8B04B', purple:'#7B5EA7', ink:'#020309' },
  severity:{ p0:'#E07A5F', p1:'#E8B04B', p2:'#3D5A80' },   // red / amber / blue
  diverging:{ pos:'#7FBE7C', neg:'#E07A5F' },              // sage up / terracotta down
  barRadius:0, areaFillOpacity:[0.55, 0.05],               // gradient stops
};
```

---

## 14. Quick reference: do / don't

**Do**
- Cream canvas + faint 32px grid; never plain white.
- 2px solid `#020309` borders on everything structural.
- Solid (0-blur) offset shadows; lift on hover, press on active.
- Pastel semantic fills (mint/yellow/pink/blue) for chrome; saturated earthy
  palette only inside charts.
- Mono tabular figures for all numbers; uppercase wide-tracked labels.
- Eyebrow-over-title headers; stagger content in on view change.

**Don't**
- No blur, glass, or soft shadows; no surface gradients.
- No hairline 1px borders on cards/buttons.
- No saturated UI accent colors outside data viz.
- No proportional figures for metrics (they'll jitter).
- No icon library mismatch — keep icons geometric and ~2px weight.

---

### Screenshot index (`screens/`)
- `01-landing.png`, `01-overview-full.png` — Overview (KPI grid + insight charts)
- `02-analytics.png`, `02b-analytics-charts.png` — diverging bars + gradient area
- `03-workload.png`, `03b-workload-heatmap.png` — KPI variants + horizontal/stacked bars
- `04-pulse.png` — KPI grid pattern
- `05-intelligence.png`, `05b-intelligence-donut.png` — severity bars + donut
- `06-team.png` — person cards + stat chips
- `07-tasks.png` — table with mono date chips
- `08-daily-feed.png` — multi-series stacked area
- `09-actions.png` — full-width block action buttons
- `10-vault-overview.png`, `10b-vault-architecture.png` — system layer, ASCII diagram, run-history table
- `11-button-hover.png` — signature ink-inversion hover
