# HoBo site

The GitHub Pages site for HoBo: landing page, developer docs, and agent docs, served at
<https://tyler-r-kendrick.github.io/HoBo/>.

Built with [Astro](https://astro.build) in static output mode — no client-side framework.
Most pages are prerendered HTML plus `src/styles/global.css`; the `/examples/`
ship console is the deliberate exception, using a small TypeScript client and
build-generated browser Component Model assets. The console is a three-board
strip: **Pool** (dropdown multi-select yards — Local merges Browser WASM +
Webernetes; All/None; Code shows `station({ yards })` provider imports for the
station provision plan), **Ship** (app Bindle
source), **Live** (Preview ↔ Logs + claim URLs when anonymous deploys issue
them — no Claim CTA). Temporary/agent station stamps (zero permanent API tokens) under `astro
dev` / preview: Cloudflare `/api/cf-temp`, Lakebed `/api/lakebed-temp`,
Netlify `/api/provider-temp/netlify`
(`netlify deploy --allow-anonymous`), local yards `/api/provider-temp/:id`
→ same-origin `/api/anon/host/*`. Replay mocks:
`HOBO_LAKEBED_TEMP_MOCK=1 HOBO_VERCEL_DROP_MOCK=1 HOBO_NETLIFY_TEMP_MOCK=1`.
Temp APIs advertise `apiVersion: hobo-temp-v2` — kill stale `:4321` processes
if Deploy returns HTML. Static GitHub Pages has no temp brokers.
Vercel is unavailable for real anonymous temporary deployment: the SDK has no
documented anonymous API and never falls back to an authenticated CLI login.
`/api/vercel-temp` reports availability false and refuses real provisioning;
`HOBO_VERCEL_DROP_MOCK=1` is an explicit offline fixture lane. Its browser-safe
provider capability constant drives the Examples target pack. Provider requests
keep permanent credentials out of each child or API call without deleting the
server process environment, so concurrent account-backed work is unaffected.
Railway is not an OOB yard. Matching-honest native ports live in
`src/lib/examples/target-capability-packs.ts`. Multi-host selections show
policy placement intent; they do not claim browser-side failover or state
mirroring.

Site parsers and scripts share `src/lib/json-inspect.ts` for JSON I/O boundaries
so anti-slop oxlint (`pnpm exec oxlint --deny-warnings site`) stays green:
named `JsonValue`/`JsonObject` types, tag checks instead of `typeof`, and
`SAFETY:` comments on remaining type assertions.

## Working on the site

Site tests load native app modules and may compile TypeScript. Their bounded
timeout follows `HOBO_TEST_TIMEOUT` (10 seconds by default), matching the other
owning-package lanes; broader affected checks can supply a larger machine budget.

The site is a workspace package (`hobo-site`) in the root pnpm workspace — the repo's
architecture guard requires a single root `pnpm-lock.yaml`. It stays out of the repo's
turbo build/test filters (those target `./packages/*`), so site dependencies only affect
the root install step.

```sh
pnpm install                        # from the repo root
pnpm --filter hobo-site dev        # http://localhost:4321/HoBo/
pnpm --filter hobo-site build      # writes site/dist/
pnpm --filter hobo-site preview    # serve the built dist/
pnpm --filter hobo-site typecheck  # check Astro templates and TypeScript scripts
pnpm --filter hobo-site codegen    # regenerate protobuf TS and vet CUE
```


## Design system (DESIGN.md)

Visual identity for agents lives in **[`DESIGN.md`](./DESIGN.md)** — Google’s open
[DESIGN.md](https://github.com/google-labs-code/design.md) format (`@google/design.md`).

Aesthetic: **Steamboat Willie / Cuphead / rubberhose** (thick ink, sticker shadows,
film grain, Chewy title cards, B&W day/night inversion). Runtime CSS remains
`src/styles/global.css`; keep the two aligned.

### Repo-wide gate (pre-commit)

Every **web UI** package must ship a root `DESIGN.md`. Discovery:

| Signal | Meaning |
|---|---|
| Path is `site/` | Always a web UI root |
| `"hobo": { "webUi": true }` in package.json | Explicit web UI |
| Depends on `astro` / `next` / `nuxt` / … | Framework-hosted web app |
| Already has `DESIGN.md` | Opt-in visual contract |

Lint all of them with the same CLI:

```sh
pnpm run design:lint                            # all web UI DESIGN.md files (pre-commit)
pnpm --filter hobo-site run design:lint         # this package only
pnpm --filter hobo-site run design:export:css   # Tailwind v4 @theme export
pnpm --filter hobo-site run design:export:dtcg  # W3C design tokens
```

`pnpm run check:relevant:staged` (the pre-commit path) selects `design:lint` when
`DESIGN.md`, `site/` UI sources, or `scripts/check-design-md.mts` change.

Agent skill mirrors: `.agents/skills/design-md` and `.claude/skills/design-md`.

## Layout

| Path | What it is |
|---|---|
| `src/pages/index.astro` | The landing page. |
| `src/pages/examples/` | Static Examples ship console and generated example catalog endpoint. |
| `src/components/ParallaxTrail.astro` | The scrolling trail band above the hero (see below); `facing` turns it around. |
| `src/components/BoIdle.astro` | Bo standing about — rest, bounce and blink (see below). |
| `src/lib/trail-art.ts` | The telephone wire — the one thing the band draws for itself. |
| `src/lib/trail-plates.ts` | Picks up supplied artwork from `public/parallax/plates/`. |
| `src/lib/trail-clouds.ts` | The cloud sprites and where each one sits in the tile. |
| `src/lib/bo-walk.ts` | The walk sheets, one per direction, and the refusal to fake a missing one. |
| `src/pages/parallax/[layer].svg.ts` | Serves those tiles as static SVGs, one per layer and theme. |
| `src/pages/{guide,primitives,testing,reference,crew,roles,agents}/**/*.md` | Docs pages; frontmatter picks the `Docs.astro` layout. Sections: Guide, Primitives, **Testing**, **Reference**, **Crew**, Roles/Agents. |
| `src/nav.ts` | Single source of truth for header + sidebar navigation (all sections). |
| `src/layouts/` | `Base.astro` (head/header/footer/theme) and `Docs.astro` (sidebar + prose). |
| `src/styles/global.css` | The whole design system: tokens, light/dark themes, components. |
| `public/llms.txt` | Machine-readable briefing for AI agents (mirrors the pattern HoBo itself designs for). |

## Conventions

- **Base path:** the site deploys under `/HoBo/`. Internal links in `.md` content are
  written absolute with the base (`/HoBo/guide/...`) because Astro does not rewrite
  markdown hrefs. `.astro` files use the `href()` helper from `src/lib/url.ts` instead.
  If the repo is renamed, update `base` in `astro.config.ts` and these links together.
- **Repository links are chrome-only.** The site header (GitHub icon, top right)
  and footer link to github.com/Tyler-R-Kendrick/HoBo — that is the ONLY sanctioned
  repo linking. Page *content* stays standalone: never link to repo paths like
  `docs/design/` from prose — restate what's needed instead. The canonical sources
  in `docs/design/` inform the content but are not linked.
- **Voice:** playful "homeward bound" theme — the guiding principle is continuous
  migration to the cheapest home that passes policy. Whimsy in the prose, precision in
  the tables and code.
- **Design language:** strict black-and-white **rubberhose** 1930s cartoon (Steamboat Willie / Cuphead / Fleischer) — see `DESIGN.md`. All artwork is *traced
  from the reference illustrations* (never procedural): `Mascot.astro` is Bo, and
  `src/components/scenes/` holds the five story panels (crossroads, depot, train,
  blimp, steamboat) placed by narrative on the landing page. White paper/black ink by
  day, exact inversion at night — everything routes through `--ink`/`--pop`/theme
  tokens; no hues anywhere (code blocks are grayscale-filtered). Limelight title-card
  display type, Baloo 2 for rounded UI chrome, film-grain overlay, thick ink outlines
  with hard offset shadows. New components must use the tokens, not hardcoded colors.
  Story panels stay traced. The trail band draws only what cannot be cropped out of a
  plate — which is the telephone wire and nothing else. **Scenery objects are supplied
  artwork, not drawn here:** clouds, hills, poles, ground, birds, wind, rocks, flowers
  and plants go in `public/parallax/plates/` (or `public/parallax/clouds/`) and are used
  as given. Do not hand-author replacements for them.
- **No new JS-family files:** repo policy (AGENTS.md) — config is `astro.config.ts`, not `.mjs`.
- **Single lockfile:** never add a `site/pnpm-lock.yaml`; the architecture guard rejects
  nested lockfiles. Dependencies resolve through the root workspace lockfile.

## The parallax trail band

`ParallaxTrail.astro` sits between the header and the hero. Nearly all of it is supplied
artwork; the split is deliberate.

**Supplied artwork** goes in `public/parallax/plates/`, one file per slot, and is used
exactly as given, at its own aspect ratio, tiled and scrolled at that slot's speed. See
the README in that folder for the slot table and how the shipped plates were composed.
An empty slot renders nothing. **Scenery objects are not to be hand-authored in this
repo**; if a plate is missing, the answer is to supply it, not to draw a substitute.

Everything in the band is cut out of the reference plates: four clouds, three telephone
poles, and the ground strip — split at the emptiest row in it into the part behind Bo
and the near bank in front of him. Each capture is cropped to the rows actually used,
normalized to the same 6-level grayscale + alpha the Bo sheets use, and recomposed on a
full-height canvas so it lands at its scene position: 2.6MB of source crops became ~95KB
of plates.

**The clouds are sprites, not a plate.** They live in `public/parallax/clouds/` with
their placements in `src/lib/trail-clouds.ts`, because each one squashes and bobs on its
own and a single background image can only move as a whole. The layer is a track of
identical segments scrolling by exactly one segment, so it loops on the same guarantee a
tiled plate does.

**Night is per-layer, not one filter.** Grayscale artwork makes it cheap, but a single
`invert(1)` across the band is wrong: it turns clouds into holes in the sky and
telephone poles into white posts. Each slot declares its own treatment — `invert` for
line art, `keep` for artwork whose own ink is the point, `rim` for silhouettes that
should stay dark and take an outline instead — and each is graded by a `tone` that
tracks the parallax speed, so the far layers sit back in the dark instead of all
arriving at the same brilliant white. The plates folder README has the reasoning.

**Drawn here** is one thing only: the wire between the poles, in `src/lib/trail-art.ts`,
served as one static SVG per theme. A wire cannot be cropped out of a plate the way an
object can — it has to span whatever gap the poles happen to leave and close across the
tile seam — so it is generated, as the stroked catenary it actually is. Everything else
that used to be drawn here (ridges, posts, signposts, grass) was replaced by the
captured props and deleted.

**How it stays aligned.** A drawn layer is a 1200×300 tile, sized in CSS as `4 × --band-h`
wide by `--band-h` tall. A plate gets its own tile width — its aspect ratio times the band
height — so it is never squashed, and it is composed on a full-height canvas against that
same 300-unit scene, which is what keeps it registered with everything else. Either way a
layer scrolls by translating exactly one of its own tile widths, so the wrap lands on
identical pixels. A plate has to repeat cleanly on its own; nothing mirrors or blends the
join for it at runtime, which is why the ground plates are mirrored into `A A'` tiles when
they are composed. `--band-h` is a whole number at every breakpoint on purpose — a
fractional tile width brings back sub-pixel seams.

**Which way he walks.** `<ParallaxTrail facing="west" />` turns him around: it picks the
west sheet and reverses every layer, so the world slides the other way and his feet still
plant. His own two animations never reverse — the gait plays forward whichever way he is
pointed — and `animation-direction` does not inherit, so the cloud squash inside the
cloud track is left alone too.

**The west sheet is a separate drawing, not a flip.** Bo is not symmetric: the bindle
hangs from one specific anatomical arm, and mirroring hands it to the other one. Walking
west that arm becomes the far arm, behind the fur silhouette, with the bundle trailing to
screen-right — which is how the supplied sheet draws it. `public/parallax/README.md`
carries the brief, how the sheet was rebuilt from the supplied artwork, and the one thing
that could not be verified: the west poses do not carry a consistent ground contact, so
his feet do not plant against the scrolling ground the way they do going east. If a
sheet for a direction is missing, `facing` **fails the build** with that reason rather
than falling back — a mirrored sheet looked plausible enough to ship once already.

**How fast it goes.** Bo is a 36-frame sprite sheet (`public/parallax/bo-walk.png`, a 6×6
grid, downscaled and posterized to the four tones the drawing uses, with the bindle sack
filled white so it does not vanish on a dark ground). Nine frames make a step, eighteen a
stride, and his planted foot tracks backwards about 11px of a 554px frame per frame. At
the size the band draws him and the export's own 50ms frame timing, that is ~52 tile units
a second, which is where `TRAIL_SECONDS` comes from. **Change his size or frame rate and
`TRAIL_SECONDS` has to change with them**, or he skates — his stride length scales with
him, so the two move together. Every other layer is a fraction of that one speed, and
that fraction is the entire parallax.

`TRAIL_SECONDS` is defined per 1200-unit tile, and each layer's duration is derived from
it *and that layer's own tile width*. This is not decoration: a plate whose aspect is not
4:1 covers a different distance per loop, so a duration taken straight from
`TRAIL_SECONDS` would move it at the wrong speed and the parallax you get would not be
the parallax the slot table claims.

**How it stops.** A hovering cursor, a held or tapped finger, the pause button, a hidden
tab and a band scrolled out of view all set one inherited custom property, `--plx-play`,
which every animation in the band reads. Nothing can freeze Bo without freezing the
scenery with him. `prefers-reduced-motion` pins it to paused and hides the button.

## Bo idling

`BoIdle.astro` renders Bo standing about, and every so often he blinks or moves. One
strip holds three independent states:

| Frames | State | |
|---|---|---|
| `0` | rest | the still pose, shown when nothing is playing |
| `1`–`10` | cycle | one move, which lands back on the rest pose |
| `11` | blink | eyes shut, on a body pose that matches rest |

**Two sheets share that contract**, so `variant` swaps the image and changes nothing
else:

| `variant` | Sheet | The cycle is |
|---|---|---|
| `idle` *(default)* | `public/parallax/bo-idle.png` | a hop — he is loitering |
| `stand` | `public/parallax/bo-stand.png` | a breath anchored at the feet, so he never leaves the ground |

Use `stand` where Bo should be present without asking for attention — the footer uses
it, beside the pre-release caveat, because a mascot doing tricks next to that sentence
undercuts it. Use `idle` where a hop is welcome.

The clips were picked by silhouette rather than by eye, which is what lets a clip start
or stop at any moment without a visible pop, and why the states can be triggered
independently instead of being locked into one long loop.

How closely alpha matches between rest and blink differs by sheet, and this file used to
claim — wrongly — that it was identical in general:

- `bo-idle` — **4618** differing alpha px. Its blink is a separate drawing, so the
  silhouette shifts slightly. Near enough not to pop; not identical.
- `bo-stand` — **0**. Its blink is derived from its own rest frame by editing the colour
  channel only, so the outline cannot drift by construction.

The original **1.78 / 6.38 / 7.55** unit figures are recorded as found from the source
animation. No tool in this repo computes them and they have not been reproduced — treat
them as provenance rather than as a check.

Each instance runs its own timer, so several Bos on a page drift apart rather than
blinking in unison. `<BoIdle still="rest" />` freezes him on one frame and never
animates; `prefers-reduced-motion` does the same. He sleeps while off screen or on a
hidden tab. Pass `label` for a Bo that should be announced, otherwise he is `aria-hidden`.

## Heading anchors

Every `h2`/`h3`/`h4` in `.prose` gets an `id` and a `#` link, via `rehype-slug`
and `rehype-autolink-headings` (wired in `astro.config.ts`).

This was a real gap, not a nicety: before it, **no docs page could be
deep-linked**. `scroll-padding-top` was already set in `global.css` for anchors
that did not exist, and the homepage linked to
`/primitives/bindles/#greenfield-declare-the-bindle-generate-the-code`, which
silently resolved to nothing.

The `#` is hidden until the heading is hovered or the anchor is focused, and it
occupies no layout when hidden — the heading's silhouette never shifts. It is
never `display: none`, so a keyboard user can still reach it.

## Publishing (no Actions)

The site is published by pushing the built output to the **`gh-pages` branch**,
which GitHub Pages serves ("Deploy from a branch"). Local publish is
`pnpm run site:deploy` — no in-repo workflow, and **agents must not** wait on,
cancel, or re-request Action runners for gates or promote. Checkin gates stay
local: `.githooks` + `pnpm agent:check`.

```sh
pnpm run site:deploy              # build deps + site, verify dist, publish
pnpm run site:deploy -- --dry-run # same, but stop before the push
```

[`scripts/deploy-site.mts`](../scripts/deploy-site.mts) automates the steps below and
adds two guards the manual version lacked: it **refuses to publish when `site/` has
uncommitted changes** — otherwise the deploy commit's `@ <sha>` names a commit that
does not describe what shipped — and it stages the build in a throwaway clone, so
`git init` on an orphan branch cannot run inside your working tree.

That mattered: this was a manual procedure with nothing to run, and the live site sat
on a stale commit long after `main` had moved.

<details>
<summary>The equivalent manual steps</summary>

```sh
pnpm --filter hobo-site run build
cd site/dist
git init -b gh-pages
git add -A
git commit -m "deploy: site @ $(git -C ../.. rev-parse --short HEAD)"
git push --force git@github.com:Tyler-R-Kendrick/HoBo.git gh-pages
cd .. && rm -rf dist/.git
```

</details>

The build generates the Examples catalog and real browser WIT component assets
from `examples/try-site/apps/` before Astro writes `site/dist/`; do not hand-edit
the generated output. The Pages happy path remains entirely static. Remote
provider bootstrap is disabled unless a trusted out-of-browser executor is
configured; provider credentials and claim material never enter the page.

Notes:

- `public/.nojekyll` ships in the build so Pages serves Astro's `_astro/` asset
  directory verbatim (Jekyll would otherwise drop underscore-prefixed paths).
- The push is `--force` on purpose: `gh-pages` is a build artifact with disposable
  single-commit history, never a source branch.
- One-time repo setting if Pages isn't already serving: **Settings → Pages →
  Source → Deploy from a branch → `gh-pages` / `(root)`**.
- **`examples/runtime/` WIT wasm ships with the deploy** so hello-world /
  todo-api run fully in-page on Pages (in-page `browser-wasm` station, no
  same-origin API needed). The deploy refuses to publish if the runtime is
  missing from the build. The old "Pages builds fail / hang on the wasm"
  belief traced to runner starvation on 2026-08-06 (jobs cancelled at 15m
  with no runner assigned), not payload size — and a failed branch build
  keeps the previous deployment live. `HOBO_PAGES_STRIP_WIT=1` restores the
  strip as an escape hatch.
- **`pnpm --filter hobo-site run examples:verify-dist`** serves `dist/` over
  plain static HTTP and drives the console end-to-end in a real browser
  (catalog → pool → ship → live WIT invoke). `site:deploy` runs it before
  every publish; `HOBO_SKIP_DIST_VERIFY=1` skips it.
- OpenSaaS / Swaghaus (docker/CLI-backed) still ship via the optional local
  bridge: `pnpm --filter hobo-site run examples:bridge`, then open
  `/HoBo/examples/?bridge=http://127.0.0.1:8787`. The bridge also provisions
  webernetes/lakebed stations for the Pool.

## Design audit (interactive)

`pnpm --filter hobo-site run design:audit` drives the built site in a real
browser (Playwright): every design × theme × page × viewport, real picker
clicks, scrolls, hovers, and two pixel-diff acceptance criteria — switching
designs must render identically to a fresh load (no bleedover), and the ink
default must pixel-match a pre-axis baseline build (pass
`--baseline-dist <dir>`). A differentiation pass asserts each design actually
renders differently from ink, so a dead boot script cannot pass trivially.
Output: screenshot corpus + `findings.md` under `runs/design-audit/`
(gitignored). Exit code = number of failed checks.
