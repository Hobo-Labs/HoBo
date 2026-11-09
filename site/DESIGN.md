---
version: alpha
name: HoBo Rubberhose
description: >
  Steamboat Willie / Cuphead / Fleischer-style rubberhose cartoon identity for the
  HoBo GitHub Pages site. Thick ink outlines, hard sticker shadows, film grain,
  black-and-white day/night inversion, and title-card lettering — never flat SaaS
  chrome.
colors:
  primary: "#101010"
  on-primary: "#ffffff"
  secondary: "#4a4a46"
  tertiary: "#c5301c"
  on-tertiary: "#ffffff"
  neutral: "#ffffff"
  neutral-raised: "#ffffff"
  neutral-inset: "#f4f4f2"
  ink: "#101010"
  soot: "#1a1512"
  paper: "#ffffff"
  cream: "#f2f1ec"
  mute: "#4a4a46"
  faint: "#6e6d68"
  border: "#e3e2de"
  border-strong: "#c9c8c2"
  spark: "#c5301c"
  go: "#14672c"
  code-bg: "#f7f7f5"
  night-bg: "#0a0a0a"
  night-text: "#f2f1ec"
  night-raised: "#111111"
typography:
  h1:
    fontFamily: Chewy
    fontSize: 3rem
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: 0.01em
  h2:
    fontFamily: Chewy
    fontSize: 2.25rem
    fontWeight: 400
    lineHeight: 1.15
  h3:
    fontFamily: Chewy
    fontSize: 1.5rem
    fontWeight: 400
    lineHeight: 1.2
  body-md:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.65
  body-lg:
    fontFamily: system-ui
    fontSize: 1.125rem
    fontWeight: 400
    lineHeight: 1.65
  label-caps:
    fontFamily: system-ui
    fontSize: 0.75rem
    fontWeight: 700
    letterSpacing: 0.08em
  mono:
    fontFamily: ui-monospace
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: 4px
  md: 12px
  lg: 18px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
  "2xl": 64px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    padding: 14px
    typography: "{typography.h3}"
  button-primary-hover:
    backgroundColor: "{colors.spark}"
    textColor: "{colors.on-tertiary}"
  button-ghost:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: 14px
    typography: "{typography.h3}"
  card:
    backgroundColor: "{colors.neutral-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: 24px
  card-border:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  hairline:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.ink}"
  hairline-soft:
    backgroundColor: "{colors.border}"
    textColor: "{colors.ink}"
  badge:
    backgroundColor: "{colors.neutral-inset}"
    textColor: "{colors.mute}"
    rounded: "{rounded.pill}"
    padding: 8px
  caption:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.faint}"
    typography: "{typography.label-caps}"
  header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    height: 60px
  code-block:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
  link:
    textColor: "{colors.ink}"
  link-hover:
    textColor: "{colors.spark}"
  focus-ring:
    backgroundColor: "{colors.spark}"
  status-go:
    backgroundColor: "{colors.go}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    padding: 8px
  mascot-bo:
    backgroundColor: "{colors.soot}"
    textColor: "{colors.cream}"
  theme-night:
    backgroundColor: "{colors.night-bg}"
    textColor: "{colors.night-text}"
  theme-night-surface:
    backgroundColor: "{colors.night-raised}"
    textColor: "{colors.cream}"
---

## Overview

**Brand & Style:** HoBo’s public site is a **1930s rubberhose cartoon** — Steamboat
Willie ink-and-paper, Cuphead title cards, Fleischer bounce — not a pastel product
dashboard. Everything is **ink on paper by day** and **paper on ink by night**
(exact theme inversion). Bo the bindlebug is soot-colored with googly eyes; scenery
and cast are *supplied* illustration — traced, or generated and then reviewed and
normalized to one ink — never unreviewed generative glop.

Voice is “homeward bound” whimsy with precise technical tables. Agents generating
or editing UI **must** read this file first and keep every surface on-system.

Canonical CSS implementation: `site/src/styles/global.css`. This DESIGN.md is the
**agent-facing contract**; the stylesheet is the runtime truth. Prefer tokens over
hardcoded hex in new work.

### Aesthetic pillars

1. **Rubberhose geometry** — pie-cut eyes, sausage limbs, squash-and-stretch motion
   (honor `prefers-reduced-motion`).
2. **Thick ink outlines** — 2–3px borders; hard **sticker** offset shadows (not soft
   Material elevation blobs).
3. **Title-card type** — **Chewy** for display headings; quiet system-ui for body.
4. **Film grain** — faint fixed grain overlay; old-reel vibe without muddy contrast.
5. **Strict B&W base** — neutrals dominate; **spark** (vermillion) and **go** (green)
   are rare interactive/status accents only — never rainbow chrome.
6. **Supplied art only** — nothing on the site is drawn in a renderer. Bo, the
   scenery plates, the landmarks beside the trail and the cast of hobits are
   all artwork — traced, or generated and then reviewed — vendored as files
   and used as given. Do not invent flat vector substitutes.
   **The trail is the page's imagery.** The landing page used to stop five
   times for a large traced scene panel; those are gone, and the props they
   were traced from now stand on the trail itself, where each one arrives with
   the section it belongs to (see *The trail* under Motion). A page of text
   with one living picture docked beneath it reads as a place; a page that
   interrupts itself with five posters reads as a slideshow.
   Prop ink follows the plates' night rule and inverts to chalk; Bo and the
   cast follow the mascot rule (soot stays dark and takes a light rim, never
   inverts); clouds keep their own ink.

## Colors

Palette is **ink / paper** with two functional accents.

| Token | Light role | Notes |
|---|---|---|
| **primary / ink** (`#101010`) | Headlines, primary buttons, outlines | Steamboat soot-black |
| **neutral / paper** (`#ffffff`) | Page ground | Clean cel paper |
| **secondary / mute** (`#4a4a46`) | Captions, meta | Warm gray, not blue-gray SaaS |
| **tertiary / spark** (`#c5301c`) | Focus, hover links, danger pop | Cuphead vermillion — sparingly |
| **go** (`#14672c`) | Success / positive status | Rare |
| **soot** (`#1a1512`) | Bo’s body fill | Never pure `#000` on the bug |
| **cream** (`#f2f1ec`) | Night text / ink inversion pair | Paper-on-ink |

**Dark theme:** invert grounds and inks (`night-bg` / `night-text`). Accents stay
readable; do not invent neon palettes.

**Do not:** flat brand gradients, purple AI glow, glassmorphism, or full-color
product illustration.

### The five palettes

Colour is a **second axis**, orthogonal to day/night. `data-theme` stays the
inversion pair; `data-palette` re-inks the paper and the line. Absent the
attribute you get `ink` — the canonical Steamboat Willie black-and-white — so
the default is the *absence* of a choice, not a choice.

| Palette | `data-palette` | Paper / ink (day) | Character |
|---|---|---|---|
| **Ink on Paper** | *(none)* | `#ffffff` / `#101010` | The canonical. Maximum MA — the page is mostly empty on purpose. |
| **Dusk Meadow** | `dusk` | `#fbf5e9` / `#2e2418` | Ghibli golden hour. Warm paper, sepia line. |
| **Rain Glass** | `rain` | `#f2f5f7` / `#1b2732` | A downpour seen through glass. Cool, quiet, indigo. |
| **Cel Bloom** | `cel` | `#f7f0e1` / `#241a12` | Cuphead title card. Card stock and vermillion. |
| **Moss Quiet** | `moss` | `#f1f4ee` / `#1e2a1c` | Forest floor. The softest of the five. |

Every palette overrides the same sixteen tokens and each is an inversion pair,
so night is never a separately-tuned palette — it is the same decision, flipped.

**The Same Contract Rule.** Every palette carries exactly one paper, one ink,
and two rare accents (`spark`, `go`). A palette that needs a third accent is not
a theme, it is a different design system. This is what lets The One Voice Rule
survive a switch: the accents stay rare in all five, so rarity keeps meaning
what it meant.

**The Absent Default Rule.** Selecting `ink` *removes* `data-palette` rather
than setting it. The canonical look is what you get by not choosing, which keeps
a stored preference from quietly becoming a fifth thing to maintain.

**A palette declares 16 values; the rest derive.** `--ink`, `--link`,
`--meadow`, `--sky` and their `-soft` pairs, plus `--code-bg` and `--hero-grid`,
are `var()` indirections onto `--text`, `--accent` and `--bg` — so re-inking the
paper re-inks the links, rules and code blocks automatically. This is not a
convenience: when those eight were written out per-theme instead, every palette
silently inherited the ink theme's pure-black `#101010` links, and Dusk shipped
warm paper with cold links. A palette that has to restate a derived token is a
sign the token belongs in the declared set, not that it should be overridden.

The genuinely shared tokens are `--ember-a/b/c`, `--glow` and `--shadow`: a
neutral depth ramp that is deliberately palette-independent, because shadow is
paper behaviour, not ink colour.

Palettes are offered behind a disclosure, never as five buttons in the bar. The
designer persona's clutter thresholds are the lowest available and
`junior-frontend` treats choice overload as a hard budget — so five options may
exist, but they may not shout. Closed, the picker costs one icon.

## Typography

- **Display (h1–h3):** Chewy — rubberhose title card, slightly uneven friendly letterforms.
- **Body:** system-ui stack — legible docs prose at 1rem / 1.65 line-height.
- **Labels:** small caps tracking for badges and step numbers.
- **Mono:** ui-monospace for code only.

Headlines can be slightly oversized and “bouncy”; body stays calm so technical
tables remain scannable.

## Layout

- Max content width ≈ **1160px** container; header ~**3.75rem**.
- Spacing scale: 4 / 8 / 16 / 24 / 40 / 64 — generous cartoon breathing room.
- Docs: sticky sidebar + prose column; landing: hero + sections of cards, with
  the trail band docked to the bottom of the viewport for the whole page.
- Base path deploy: `/HoBo/` — links in markdown include the base.

## Elevation & Depth

Not Material elevation. Use **sticker depth**:

- Hard offset shadows (e.g. 4px 4px 0 ink) on cards/buttons when pop is needed.
- Thick 2–3px borders in `ink` / `border-strong`.
- Film grain overlay sits above the whole page (non-interactive).
- The trail band uses **supplied plates and landmarks**, not CSS-drawn hills.
  It sits above the page as a docked strip with one ink rule along its top
  edge — a frame, not a floating panel, so it takes no shadow.

## Motion

Rubberhose is an *animation* idiom. A still rubberhose surface is a poster of
one — the bounce is the point, and motion here is identity, not decoration.

But the persona who owns this identity declares `prefers-reduced-motion`, and
two more declare `cognitive-load-sensitive`. So the rule is not "animate less".
It is: **every motion must survive being removed.** If taking the animation away
breaks comprehension, the animation was carrying information that should have
been in the layout.

### The curve

**Two curves, and only two.**

| Token | Curve | Peak | For |
|---|---|---|---|
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | 1.000 | Everything. Decelerates hard and stops clean. |
| `--ease-boing` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 1.098 | The bounce: overshoots and settles — squash-and-stretch expressed as a curve. |

This entry used to claim there was one token and that `--ease` overshot. Neither
was true: `--ease` peaks at exactly 1.0 and never overshoots, while three
hardcoded copies of the real bounce curve sat in the stylesheet unnamed and
unaccounted for. They are the same curve, so they are now one token.

Reach for `--ease` by default. `--ease-boing` is for motion whose *job* is to
read as cartoon physics — the postcard bob, the theme toggle, landmark hovers — and
a third curve is not available. Anything that seems to need one is either not
rubberhose or is a special case that must say why in a comment.

A generic design linter will flag the bounce as dated and prescribe exponential
easing. On a flat SaaS surface that advice is correct. Here it is backwards:
[ADR-0149](../docs/design/adr/07-portability-extensibility.md#adr-0149) makes the
Fleischer identity binding, and the overshoot **is** the identity. Do not
quiet that warning by flattening the curve.

**Durations.** Three steps, and no fourth:

| Token | Value | For |
|---|---|---|
| `--dur-tap` | 120ms | State you caused: press, toggle, focus |
| `--dur-move` | 220ms | Something travelling: hover lift, disclosure |
| `--dur-scene` | 420ms | Something arriving: page-level reveal |

These govern **response** motion — transitions and entrances, anything the user
waits through. A rubberhose gag lands in under half a second; a UI that takes
longer is not being charming, it is being slow.

**Ambient loops are exempt, and the exemption is finite.** A looping animation
is scenery: nobody waits for it to finish, so a duration budget aimed at
perceived latency does not apply. Every current exception, in full — anything
not on this list is a bug:

| Animation | Duration | Why it is exempt |
|---|---|---|
| `boing` / `boing-sm` | 550ms / 450ms | The signature bounce. Overshoot needs the settle; clipped to 420ms it reads as a twitch, not a squash. |
| `postcard-sway` | 2.2s | Loop — homepage postcard drift |
| `plx-cloud-squash` | 3.1s | Loop — parallax cloud |
| `plx-scroll` on the cloud track | 190s | Loop — the weather. The one thing in the band that keeps moving when the page is at rest |
| `plx-bob` / `plx-sway` | 5.2s / 4.1s | Loop — a landmark that floats bobs, one that is afloat rocks. Planted things stay planted |
| `plx-bo-hop` | 950ms | Bo's idle hop: ten drawn frames at the strip's own cadence. A sprite cycle is as long as its drawing |
| `troupe-doze` | 2.6s | Loop — a napping hobit breathing, for as long as he is out |
| `lost-bob` | 3.6s | Loop — Bo idling on the 404 |
| `blink` | 7.3s | Loop — Bo's eyes |

`boing` is the honest one to watch: it is response motion that exceeds the cap
on purpose. Two named exceptions is a style; a third would mean the cap is
fiction and the table should be rewritten instead of extended.

### MA (間) — the interval is the animation

The Japanese `MA` is not empty time, it is *charged* time: the pause that gives
the next beat meaning. Applied here:

**The Rest Rule.** A sequence of entering elements is staggered by **60ms**
(`--stagger`), and the stagger is the content. Three cards arriving together is
a state change; three cards arriving 60ms apart is a sentence. Never stagger
more than five things — past that it stops reading as rhythm and starts reading
as lag. *Implemented on the palette menu* (`.palette-picker[open] .palette-menu
button`), which has exactly five items — the rule's ceiling, which is why those
delays are written out rather than generated.

**The Held Breath Rule.** Anything that reveals on scroll waits until it is
**15% into the viewport**, not at the edge. The gap between "it could animate"
and "it does" is the MA. Triggering at the boundary makes the page feel twitchy.
*Implemented* as `animation-range: entry 15% entry 60%` on `.card`.
This rule was documented before it was true — the range began at `entry 0%`,
i.e. exactly the boundary the rule forbids — so treat an unimplemented rule here
as a defect in the stylesheet, not a nicety in the doc.

**The Empty Frame Rule.** Motion never fills space that was doing work by being
empty. If an animation's job is to draw the eye to a region, the region earns
attention by having margin around it, not by moving.

### Reduced motion — parity, not removal

`@media (prefers-reduced-motion: reduce)` must leave the surface **complete**,
not degraded:

- Transitions collapse to `none`. Elements land in their final state — they do
  not skip a step or appear un-styled.
- Looping and idle animation (Bo's idle, film grain drift, parallax) **stops
  entirely**. It is ambient, so its removal costs nothing.
- Anything that communicates state — focus rings, open/closed, loading — keeps
  communicating it, by colour, outline or position instead of movement.
- Scroll-triggered reveals become *already revealed*. Never leave content at
  `opacity: 0` behind a trigger that reduced-motion disabled: that is how a
  motion preference turns into a blank page.

**Two limits of the blanket rule, stated rather than papered over.**

*Delay is not duration.* Zeroing `animation-duration` leaves `animation-delay`
untouched, and an element with `both` fill holds its **backwards** fill for the
whole delay — so a staggered sequence still moves under reduced motion, just in
one jump per step instead of a slide. The Rest Rule's five buttons did exactly
that for 240ms. The reduced-motion block therefore zeroes `animation-delay` and
`transition-delay` as well. Any new stagger inherits that; none should re-add a
delay inside the reduced-motion block.

*Scroll timelines ignore duration entirely.* The blanket
`animation-duration: 0.01ms !important` does *not* stop a scroll-linked
animation: `animation-timeline: view()` is driven by scroll position, not by
time, so `rise-in` still runs under `prefers-reduced-motion`.
It is survivable only because that keyframe animates `translate` and nothing
else — the content is at worst offset by 34px, never hidden. **This is exactly
why the rules above forbid opacity in a scroll reveal**: the mechanism that is
supposed to disable it cannot. Any scroll-linked animation that touched opacity
would be invisible to precisely the users who asked for less motion.

**The audit test:** set `prefers-reduced-motion: reduce`, disable JavaScript,
and load the page. Every piece of content must be present and legible. If
anything is missing, the motion was load-bearing and the layout is wrong.

### The trail

The trail band is docked to the bottom of the viewport on the landing page and
the page scrolls over it. It is the one place scroll drives motion, and here
the scroll relationship *is* the meaning: reading down the page walks Bo down
the trail.

- **The ground moves half as far as the page.** Every other layer moves a
  fraction of that — the same slot speeds the plates always declared. Nothing
  moves faster than scroll itself, which reads as a glitch rather than depth.
- **His stride comes from the ground covered,** so a planted foot stays
  planted. Past the pace at which a stride is readable he is simply running.
- **Scrolling back up runs the reel backwards:** the same frames in reverse
  order. He is never mirrored — Bo is not symmetric.
- **Each section is a stop.** Its landmarks ride the ground and pull alongside
  him as that section's heading reaches the reading line, and a small flat
  marker names the stretch. A landmark is the section it stands for: clicking
  one goes there.
- **The world follows the scroll; it does not track it.** A wheel notch would
  arrive as a jump cut. Easing toward it turns the distance into a short walk
  that ends in a slow last step.
- **When the page stops, he stops,** lands with the small boing, and stands
  about until it moves again.

It is **ambient by definition**: it carries no information the page does not
already carry in its headings, so every part of it survives being removed.
With no script the band falls back to walking itself on a timer, exactly as it
used to. Under reduced motion nothing travels at all — the band holds still
and the current section's landmarks are simply *in place* beside Bo, swapped
without movement when the section changes. State by position, not by motion.

The one arrival the page is allowed on load is his: Bo walks the last few
steps into frame.

### The troupe

A still page should not be a dead one. When the reader has stopped scrolling
for a few seconds, one of the cast turns up, does one small thing, and leaves.

**The Margin Rule.** A visitor may appear in exactly two places: on the trail,
which is the page's margin by construction, or rising from *behind* a box's
top edge into the gap above it. Before every appearance that gap is measured
for real — structure is fine, a line of text or another box is not — and if
anything a reader could be looking at is there, that box is skipped. Nobody
ever stands in the reading column. This is the "ambient motion belongs in the
margins" rule below, enforced at runtime instead of trusted.

**The One Guest Rule.** One visitor at a time, a rest of 8–16 seconds between
them, and after six in one sitting they leave the reader alone until the page
moves again. A visitor who keeps arriving is a notification.

**The Exit Rule.** The moment the page scrolls, whoever is out gets out of the
way — a startle, then gone in under a quarter second, faster than he arrived.
Attention the reader just spent on scrolling is not ours to compete for.

**The Whole Sheet Rule.** A character looks around by moving his pupils, not
his outline: look-left, look-right and blink are derived from the standing
pose by changing colour only, so the silhouette cannot boil between them.

None of it carries information and none of it loops. The pause button on the
trail stops the trail and the troupe together and is remembered; under
`prefers-reduced-motion` the troupe does not run at all.

### What motion may not do

- **Don't** animate `width`, `height`, `top` or `left`. Transform and opacity
  only; anything else invites layout thrash on a long docs page.
- **Don't** animate on page load except for the one scene-level reveal — on the
  landing page, Bo walking into frame. A page that performs on arrival delays
  reading.
- **Don't** use motion as the only signal for anything. Colour, position or text
  must say it too.
- **Don't** loop anything in the reading column. Ambient motion belongs in the
  margins — literally. The troupe's Margin Rule is how that is checked.

## Shapes

- **md radius 12px** default cards/buttons; **lg 18px** for story cards.
- Pills for badges/step chips.
- Avoid 0-radius enterprise rectangles and 32px soft “iOS” bubbles.

## Components

### Buttons (cartoon signage — not pills)

Buttons are **roadside / tavern sign boards**, not soft ellipses or Material CTAs:

- **Silhouette:** chamfered wooden-plank `clip-path` (cut corners), never `border-radius: 999px`.
- **Ink rim:** hard outer stroke + painted inner rail + top rivet/nail heads.
- **Type:** Chewy title-card lettering (`h3` scale), slightly tracked.
- **Primary:** solid ink (or night cream) fill, paper text; hover can flash **spark** vermillion like a painted warning sign.
- **Ghost:** paper/board fill, ink rim, reads as an unpainted plank.
- **Motion:** hang-and-bounce on hover (`translate` + slight `rotate`); press flattens the sticker shadow.
- **Shadow:** hard offset sticker depth only — no soft blur elevation.
- **Pressable = raised.** The plank costume (chamfer + ink rim + sticker shadow
  + hang-and-bounce) is reserved for things you can press. Inert markers —
  status lamps, kind glyphs, lock badges — are flat ink, no shadow, no chamfer.
  If a sticker shadow ever decorates something inert, the affordance is broken.
- **Icon verbs.** On operational chrome (dashboards, Evidence, controls),
  action buttons speak in drawn monochrome glyphs — play, stop, restart, copy,
  sun/moon — not locale-dependent words. The localized verb lives only in
  `aria-label`/`title`. Marketing signage may keep Chewy lettering; controls
  that *do* things stay language-free.

### Cards

- Paper ground, ink border, optional hard shadow; icons are monochrome or Bo art.

### Navigation

- Header on paper/ink with high contrast; active states use underline or ink chip,
  not rainbow tabs.

### Code

- Inset code blocks on `code-bg`; grayscale filter acceptable so syntax never
  breaks the B&W story.

### Focus

- **spark** outline 2.5px — always visible for a11y.

### Native chrome

OS defaults (grey scroll thumbs, system select arrows, triangle `<details>`
markers, bland cursors) are **off-system**. Own them in
`site/src/styles/native-chrome.css` (loaded from `Base.astro` after
`global.css`):

- **Scrollbars:** thick ink thumb on inset track; hover → `spark`; Firefox via
  `scrollbar-color` / `scrollbar-width`.
- **Cursors:** SVG ink pointer / hand / I-beam (`--cursor-ink`,
  `--cursor-point`, `--cursor-type`); `not-allowed` on disabled.
- **Selects:** `appearance: none` + ink chevron; sticker border + hard offset
  shadow. Multi-select lists use authored checklists (see Examples), not OS
  `<select multiple>` chrome.
- **Details:** ink chevron that rotates open; hide `::-webkit-details-marker`.
- **Checkboxes / radios / range:** `accent-color: var(--ink)`.

## Do's and Don'ts

### Do

- Lead with rubberhose / Steamboat / Cuphead language in new illustrations and
  motion (bounce, squash, pie eyes).
- Keep day/night as **inversion pairs** of the same tokens.
- Reuse existing Bo / plate / landmark / cast art; generate new art only
  through the reviewed pipeline (`media/scripts/`, AGENTS.md "Generated-art
  rules") and normalize it to the same contracts.
- Put interactive emphasis on **spark** sparingly; default chrome stays ink/paper.
- Validate this file with `pnpm --filter hobo-site run design:lint`.

### Don't

- Don’t introduce flat SaaS blues, purples, or multi-stop brand gradients.
- Don’t replace supplied art with stock isometric 3D or “AI app” blobs, and
  don’t bring back full-width scene panels between sections — the trail is the picture.
- Don’t thin outlines below ~2px on primary chrome.
- Don’t soft-blur everything into modern glass UI.
- Don’t put free-text secrets or live credentials in examples (HoBo policy).
- Don’t link page prose to raw `docs/design/` repo paths — restate for Pages.
