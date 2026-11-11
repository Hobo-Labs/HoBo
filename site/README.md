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
| `src/components/TrailStage.astro` | The trail on the landing page: the band, the trail marker and their fallback (see below). |
| `src/lib/stage/landing.ts` | Turns the landing page into stops: hand-overs, Bo's walk, signs, and the cast's visits. |
| `src/lib/stage/motion.ts` | The one "may I move?" switch: reduced motion plus the remembered pause. |
| `src/lib/trail-props.ts` | The props that stand on the trail, one per card, and how tall each stands. |
| `src/lib/trail-plates.ts` | Picks up supplied artwork from `public/parallax/plates/`. |
| `src/styles/trail.css` | The trail's styles, global because most of what they style is made by script. |
| `src/components/BoIdle.astro` | Bo standing about — rest, bounce and blink (see below). |
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
- **Design language:** strict black-and-white **rubberhose** 1930s cartoon (Steamboat Willie / Cuphead / Fleischer) — see `DESIGN.md`. All artwork is *supplied*
  (never procedural): Bo's sprite sheets, the scenery plates, the landmarks beside
  the trail and the cast of hobits are files, traced or generated-then-reviewed,
  and used as given. White paper/black ink by day, exact inversion at night —
  everything routes through `--ink`/`--pop`/theme tokens; no hues anywhere (code
  blocks are grayscale-filtered). Chewy title-card display type, film-grain
  overlay, thick ink outlines with hard offset shadows. New components must use
  the tokens, not hardcoded colors.
  **The trail is the landing page's imagery.** Each card on the landing page has
  a prop that stands for it on the trail. The only things drawn here are the road
  signs, because their words have to be text. **Scenery objects are supplied
  artwork, not drawn here:** clouds, hills, poles, ground and props go in
  `public/parallax/` and are used as given. Do not hand-author replacements for
  them.
- **No new JS-family files:** repo policy (AGENTS.md) — config is `astro.config.ts`, not `.mjs`.
- **Single lockfile:** never add a `site/pnpm-lock.yaml`; the architecture guard rejects
  nested lockfiles. Dependencies resolve through the root workspace lockfile.

## The trail

The landing page is a row of stops, not a long scroll. Each `<section>` in
`src/pages/index.astro` is one stop (`data-trail-stop`, with `data-stop-name` for
the trail marker and `data-stop-sign` or its badge for the road sign), and each
of its cards names the prop that stands for it (`data-prop`). `TrailStage.astro`
renders the band; `src/lib/stage/landing.ts` does the travelling.

**On a desktop** (900×560 and up) the page keeps its own layout: the current
section sits above the band and the band sits at the foot of the screen. Moving
on is two parts. The page hands over first: what you were reading drifts back the
way Bo came and goes out of focus while the next section is already coming in, so
there is never a frame with nothing arriving. The band follows: the old stop folds
flat, Bo walks on, and the new stop's props stand up around him, one under each
card, with a road sign over his head naming the stop.

**On a phone** there is not room for both, so the trail is the screen. The
sections themselves are moved onto signs beside the trail — a billboard for the
section's own text and a placard per card, each standing over its prop — and
walking the trail is reading the page. A jump too far to walk closes an iris on
Bo and opens it on the new place.

**Moving is always one stop.** The wheel, the arrow keys, Page Up/Down, a swipe
and the Previous/Next buttons each move exactly one stop, however hard the wheel
was spun, and the trail marker jumps anywhere. Every move is a minimum-jerk glide
of fixed length: it starts from rest and arrives at rest, and a new request
mid-glide bends from the speed it already has, so nothing cuts. Past the last stop
the page lets go and the footer is a normal scroll away.

A wheel gesture ends when the wheel goes quiet (140ms), or when a stream that was
dying away rises again — a second flick — so two deliberate flicks are two steps
and one long burst is one (`startsGesture` in `src/lib/stage/trail-logic.ts`). A
gesture that begins down at the footer only brings the trail back to the stop the
reader left; it never steps on past it.

**He turns round.** Heading back, Bo walks on `bo-walk-left.png`, his other side
drawn as its own sheet. He is never mirrored and never walks backwards: Bo is not
symmetric, and a flip hands the bindle to the wrong arm (see
`public/parallax/README.md`). His stride is taken from the ground covered, so a
planted foot stays planted, and when he stops he lands with the small boing and
stands about on the idle strip.

**Without a script** none of this happens. The sections read top to bottom as an
ordinary page, and the band walks Bo along on a timer at the foot of the
viewport, as scenery. The trail also steps aside for the other designs: picking a
world puts the page back as it was, and picking ink again builds the trail again.

**Supplied artwork.** The plates (`public/parallax/plates/`, read by
`src/lib/trail-plates.ts`), the props (`public/parallax/landmarks/`, read by
`src/lib/trail-props.ts`), the clouds and the cast are files, used as given. A
plate keeps its own aspect and tiles at its own speed; a prop is scaled against
Bo in tile units of the 300-unit scene, so a cottage stands taller than a
toolbox. Night is per plate: `invert` for line art, `keep` for art whose own ink is
the point, `rim` for silhouettes that stay dark and take an outline, each graded by
a `tone` that tracks depth. Props are stored 640px tall, about twice the size the
desktop band draws a tall one, and each stop's art is fetched when the reader
is at or next to it (the rest once the page is idle).

**How it stops.** One button at the bottom right of the band pauses everything
that moves on its own — the clouds, the cast, Bo's idling — and is remembered
(`localStorage` `hobo-motion`, mirrored to `<html data-motion="still">`).
Travelling between stops is not ambient, so it still works. Under
`prefers-reduced-motion` the stops swap in place and nothing travels at all.

**For keyboards and screen readers.** The trail marker is a list of buttons, one
per stop, with the current one marked `aria-current="step"`; arriving at a stop is
announced in a polite live region, and a hidden note explains how the page moves.
The scenery itself is `aria-hidden`: it carries nothing the sections do not.
Moving on from the keyboard or the Previous/Next buttons while reading a stop takes
focus to the next stop's heading, so it never falls back to the page; a marker click
leaves it on the marker. Each stop is recorded in the URL (`history.replaceState`, so
a reload or a shared link lands on it without a history entry per step), and a hash
change goes to the stop it names.

**No stop is ever clipped.** A desktop stop is its own scroll box between the header
and the band: its content is centred while it fits, and once it does not (a laptop, a
zoomed page) it reads from the top, the wheel and the down keys scroll it before they
move on, and its foot fades while there is more below. On a short desktop the band
gives back height first, and the stop's road sign stands beside Bo instead of over
his head, clear of the trail marker's labels. A phone sign never rises under the
trail marker; one taller than the sky scrolls inside its frame and keeps vertical
swipes for that, while a short one passes them to the trail. Past the last stop,
Next, the wheel and a swipe all go on to the footer.

**Checked as built.** `pnpm run landing:verify-dist` serves `dist/` and checks every
stop at 900×560, 1024×600, 1280×620, 1366×657 and 1440×900 (nothing above its box,
every link reachable and uncovered when focused), every phone sign at 390×844,
focus on moving on, the URL and hash, the footer past the last stop, and teardown.
`scripts/deploy-site.mts` runs it with `examples:verify-dist` before publishing. The
decisions behind the trail (which stop a hash names, where a step lands, which keys
are the page's) live in `src/lib/stage/trail-logic.ts`, unit-tested beside it.

## The troupe

The cast of hobits (Tuck, Cog, Mags and Pip) each turn up once in a while, and
meeting one stamps it in the "Hobits met along the way" card on the last stop:

| Who | Where | What happens |
|---|---|---|
| Tuck | asleep by the road at "Why" | wakes when Bo arrives, waves |
| Cog | on a handcar at "How" | waves and rolls off down the line |
| Mags | behind a card, when the page is still | peeks over its top edge, looks round, waves, ducks |
| Pip | on the trail, every few stops | races past |

A card is only used for a peek if the gap above it is actually empty, measured at
the moment of use. One visitor at a time, and moving on sends whoever is out away
at once. All four share one sheet contract (`public/cast/README.md`), which the
build writes to `public/cast/cast.json` for `landing.ts` to read.

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

## Publishing

The site is published by pushing the built output to the **`gh-pages` branch**,
which GitHub Pages serves ("Deploy from a branch"). Two things push it:

- **The release workflow**, after every green `main` push. Its `release-pages-gate`
  job compares the commit `gh-pages` names (`deploy: <sha>`) with the commit under
  release and publishes when the site is behind and a release path (`site/**` among
  them) changed in between. Because it asks what is *published* rather than what the
  triggering commit touched, a deploy that failed or was skipped is retried by the
  next green run; it never publishes a commit older than the one already live. To
  publish `main` without waiting for a push, run the **HoBo release** workflow from
  `main` with **`publish_pages`** ticked. See
  [finding 110](../docs/ci/findings/0110-a-failed-pages-deploy-was-never-retried.md)
  for why it works this way.
- **`pnpm run site:deploy`**, by hand, below.

"Merged" is not "live": check the `gh-pages` commit message for the sha it was built
from before saying a site change has shipped. **Agents must not** wait on, cancel, or
re-request Action runners for gates or promote. Checkin gates stay local: `.githooks`
+ `pnpm agent:check`.

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
