# @hobo/provider-redaction

The one redactor for provider text (an API error body, CLI output, an
apiserver Status, a host fault), and the linear-time test harness that holds
it. Every provider and pack that puts such text in an error message, a log
line or a receipt redacts it here, so the shapes and their bounds exist once.

A leaf package: it imports no HoBo package, and only the packages that redact
provider text depend on it. It lives outside `@hobo/core` so that a change to a
redaction shape runs the suites that redact, not every dependent of core.

| Export | What |
|---|---|
| `@hobo/provider-redaction` | `redactProviderText`, `createProviderRedactor`, `redactMatches`, the shared shapes and detectors |
| `@hobo/provider-redaction/linear-time` | `measureGrowth`, `assertGrowsLinearly`, for tests |
| `@hobo/provider-redaction/linear-sweep` | the growth sweep, for tests |
| `@hobo/provider-redaction/redaction-differential` | the differential test against an old redactor, for tests |

## Provider redaction

`@hobo/provider-redaction` is the one redactor for provider text. `redactProviderText`
replaces the shared credential shapes (private key, JWT, bearer token, an
`Authorization` header in any scheme, `Basic` and `Token` credentials,
connection strings, URL credentials, secret-named keys, prefixed keys) with
`[redacted]`, turns control characters into spaces, and cuts to `maxLength`; it
searches the first `REDACTION_WINDOW` (8192) characters, or four times
`maxLength`, plus the rest of the run of non-whitespace the cut falls in, and
marks a longer text cut.

Every shape searches the same text, and the spans they match are merged and
replaced once (`redactMatches`): searched in turn over a text being rewritten,
one shape's match cut short a run another needed whole, or took another's name.
Each is searched twice, as the text came (a control character is not
whitespace, so `Bearer abcd\u0007SECRET` is one credential) and with control
characters as spaces (so `PASSWORD\u0000=…` is found); flattening puts one
character for one, so both searches' spans are in the same text. A shape's
search resumes at the last run of a match, so a match that starts inside it is
still found (`**Token**: api_key=**Token:** …`); the runs before it are not
read again, so each character is read at most twice.

`createProviderRedactor(profile)` adds a provider's own `patterns` and generic
`fallbacks` (a long-opaque-run rule), spans to `keep` whole, full
percent-decoding (`decodePercentFully`, one pass), and whitespace collapsing.
The whole text is searched with each kept span masked by a run character no
shape's class holds, so a value glued to a kept digest (`password=sha256:…-x`)
is still a key and its value; a kept span a credential span reaches is
redacted with it. A pattern is parsed by `redactionPattern`, which refuses one
that is not global or is sticky.

Some rules the shapes hold, each with a test:

- A private key is found in code (`keySpans`), with one pass for BEGIN lines and
  one for END lines, in any case. It runs from its BEGIN line to the last END
  line before the next BEGIN, when that line starts a line (after whitespace,
  the start, or an escaped `\n`), with the rest of that line's run. With no
  such END line, or one another shape's match ran over (`Bearer -----END …`),
  it runs to the next BEGIN line or the end: a `-----BEGIN` that starts no
  BEGIN line (`-----BEGINx`) does not stop it. A label is anything up to the
  next `-`; a `-----BEGIN` whose label another shape's match runs into (a JWT
  that took a word of it) is still the start of a key, and is redacted from
  there. `PRIVATE_KEY_PATTERN` on its own takes BEGIN to the next BEGIN.
- A JWT is an `ey` header and two segments of ten or more (`JWT_PATTERN`), or an
  `eyJ` one of eight or more and three segments (`JSON_JWT_PATTERN`, also
  `SIGNED_JWT_PATTERN`); `my-eyewear-store.myshopify.com` is neither. It is
  searched from the start of its run and redacted from its `ey`: the word
  before a hyphen is kept (`token-[redacted]`), as #1773 keeps it.
- `Basic` or `Token` and a credential of eight characters or more with a digit,
  a symbol or mixed case; a word in prose (`Token required`, `Basic
  authentication`) is not one.
- A URL with a user is a credential, with or without a password and with or
  without a scheme: a token is often the user (`https://ghp_…@github.com/…`,
  `Token ://…@host`).
- A locator (`hobo-token://…`, `hobo-secret://…`, `secret://…`, `env://…`) is a
  reference, not a secret, and is kept, as a key's value too, when its run is
  clean: 256 characters or fewer, no control character in it, ending at
  whitespace or the end. One a control character runs on through is redacted.
  Only those schemes: `password://…` and `api-key://…` are a key and its value.
- A secret-named key (`token`, `secret`, `auth`, `authorization`, `session`,
  `password`, `api_key`, `secret_key`, `access_key`, `private_key`, …) whose
  value ends in a separator, or has one after it (`api_key=password: …`,
  `token=Token =…`), takes the run after it too, and the one after that while
  each does (`api_key=a,password= b= SECRET`).

`JWT_DETECTOR` and `PRIVATE_KEY_DETECTOR` are the same shapes for guards that
refuse instead.

No shape is searched with both the `i` and `u` flags. Under `iu` a pattern
folds case the Unicode way, so `[A-Za-z]` and `\w` also hold `ſ` (U+017F, a
long s) and `K` (U+212A, the Kelvin sign): a look-behind that refuses a start
after a letter then refused one after `ſ` too, and `ſghp_…`, `Ksk_live_…` and
`ſBearer …` went unredacted. The shapes use `i` alone, which folds ASCII only;
a body class that should hold every letter the old `iu` copy held lists `ſ` and
`K` itself (`[\u017F\u212AA-Za-z0-9_-]`), and a look-behind stays ASCII. The
one shape that needs `u` (the secret-named key, for `\p{Cc}`) spells its words
in both cases with `anyCase` (`token` is `[Tt][Oo][Kk\u212A][Ee][Nn]`) instead
of setting `i`.

## Linear-time tests

`@hobo/provider-redaction/linear-time` is how the redaction tests prove a pattern linear
without a wall-clock bound that a slow or loaded machine fails.
`measureGrowth(run, input)` times `input(n)` and `input(4n)` in the CPU time of
the thread that runs them (so other processes on a loaded machine do not count),
the better of two runs each, taking turns. n doubles from 4096 (to at most 2^18)
until a run takes 30 ms of CPU time, long against Linux's few-millisecond
CPU-time ticks; an operation too quick for that is repeated within each timed
run, the same number of times at both sizes. `assertGrowsLinearly` throws a
`NonLinearGrowthError` at `LINEAR_GROWTH_LIMIT` (8: linear work grows about 4x,
quadratic about 16x), then runs `input(1 MB)` once. An operation that costs next
to nothing even repeated `MAX_REPEAT` times is linear while 4n stays under 240
ms. `NEGATIVE_CONTROL` holds a test's expected-to-fail pattern to small sizes and
one run, since quadratic work shows its 16x early. The only absolute bound is
`HANG_BACKSTOP_MS` (20 s) on a single call, an `OperationHangError`.
`repeatedTo(unit, prefix)` builds the inputs.

`@hobo/provider-redaction/linear-sweep` runs one pattern or function on inputs nobody has to
think of: runs of each character of its alphabet and of the separator classes
(`_`, whitespace, `.`, `-`, `%`, `+`, `:`, quotes, `*`, `=`, `/`, `@`, `,`, two
control characters), every ordered pair of them, its own words before each run,
and runs between its literal fragments (`patternFragments`: every literal of
three or more characters in its source, and `=` and `:`): a fragment, a run,
and a fragment or a terminator after it, and a whole sample (a word), a run, a
terminator and a fragment (`key … aaa -----END`). Each input's call on 2 Ki
characters is screened against the fastest of 32 scans of as many characters
by the redactor's own search (`referenceFloor`, once a sweep): under 32 times
that, the better of three calls, it is linear. Linear patterns cost up to about
23, quadratic ones 160 or more. The screen is in wall time, since a call that
short reads 0 on the CPU clock; load only ever slows a run, so it cannot lift
the fastest of many scans, and a slowed call only costs a measurement. An input
above 32 is measured as growth in CPU time (`judgeInput`). A call that reaches
the hang backstop is an offender, named. `assertPatternSweepLinear` sweeps one
pattern through the redactor's own search, with its fragments taken from its
source, and `profilePatterns` lists a profile's.

`@hobo/provider-redaction/redaction-differential` holds a redactor to the one it replaced.
`assertRevealsNoMore(old, now)` generates texts of credential shapes,
separators and control characters carrying random markers, and fails when the
new redactor shows half a marker the old one hid. The texts carry credentials
at their real lengths with a marker inside (AKIA keys, `ghp_`, Stripe, GitLab
and Slack tokens, a full JWT, private keys with and without END), percent
encodings, non-ASCII, zero-width and direction characters, secret names used as
schemes, and digests a value is glued to. The one exception is a marker in a
clean locator's own path or in the name of the key it is the value of, which
the shared redactor keeps on purpose (`decode` says what the redactor does to a
text first). `assertFindsNoLess(old, now, pieces)` does the same for a
detector: every text the old one found, the new one finds.

## Architecture

The package is pure functions over strings: it has no commands and emits no
events, runs no actors, and keeps no event store, projections or materialized
views, snapshots, or read stores. Its one boundary is a function call, recorded
in `contracts/pacts/provider-redaction-boundary.pact.json` as an in-process
library that owns no service boundary.

Parse, don't validate: `redactionPattern` parses a `RegExp` into the derived
type `RedactionPattern` (global, not sticky) or refuses it, and every function
that searches takes the parsed type, so an unparsed pattern cannot reach a
search.

## Data models

`data-models/provider_redaction.proto` describes the evidence the harness
reports as data: a profile's pattern sources, a growth measurement, and a sweep
input's outcome. `data-models/provider_redaction.cue` constrains each. The
TypeScript types hold `RegExp`s and functions, which a record cannot, so they
are not generated from the proto.

## Commands

```bash
pnpm exec turbo run build test --filter ./packages/provider-redaction
```
