# @hobo/provider-redaction

The one redactor for provider text (an API error body, CLI output, an
apiserver Status, a host fault). Every provider and pack that puts such text in an error message, a log
line or a receipt redacts it here, so the shapes and their bounds exist once.

A leaf package: it imports no HoBo package, and only the packages that redact
provider text depend on it. It lives outside `@hobo/core` so that a change to a
redaction shape runs the suites that redact, not every dependent of core.

| Export | What |
|---|---|
| `@hobo/provider-redaction` | `redactProviderText`, `createProviderRedactor`, `redactMatches`, the shared shapes and detectors (`SHARED_PATTERNS`), `LONG_TOKEN_RUN_PROFILE` (the profile of every provider whose own rule was a long token run), and `KEPT_LOCATOR`, what it keeps on purpose |

The harness that holds it linear and never weaker than the copies it replaced
(`linear-time`, `linear-sweep`, `redaction-differential`) is test-only, in
`@hobo/redaction-test-harness`, which every caller takes as a devDependency.

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

- A private key is found in code (`keySpans`), with one pass for BEGIN lines (in
  any case) and one for END lines (written as keys write them: a `-----end …`
  line in a body ends nothing, as no redactor this replaced ended on one). It
  runs from its BEGIN line to the last END
  line before the next BEGIN, when that line starts a line (after whitespace,
  the start, or an escaped `\n`), with the rest of that line's run. With no
  such END line, or one another shape's match ran over (`Bearer -----END …`),
  it runs to the next BEGIN line or the end: a `-----BEGIN` that starts no
  BEGIN line (`-----BEGINx`) does not stop it. A label is anything up to the
  next `-`. A BEGIN line is also one that appears only once the other shapes'
  matches are taken out, as each redactor this replaced took them out first
  (`-----BEGIN eyJ…-x… PRIVATE KEY-----`, a JWT with a `-` in the label): the
  text is searched again with the matches masked, and with the keys found
  masked (whole, and body only), until no new BEGIN line appears, each found
  one a key of its own. A text that nests more than eight such lines is
  redacted from the first of them to the end. `PRIVATE_KEY_PATTERN` on its own
  takes BEGIN to the next BEGIN.
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
  reference, not a secret, and is kept, as a key's value too, only in the
  grammar the code that issues locators writes (`src/locator.ts`, after
  `parseSecretRef` in `@hobo/bindings`): an authority and at least one path
  segment of unreserved URI characters, an optional `#field`, or `env://` and
  a variable's name. It ends at the end of its run, after closing quotes or
  brackets, or at an escaped `\n` or `\r`. Whatever is glued after it (a
  line break's escape and the next line, a zero-width or direction mark) is
  redacted and the locator kept; a value that is not in the grammar at all
  (`secret://locSECRET`, a control character in the run) is redacted whole.
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
`K` itself (`[\u017F\u212AA-Za-z0-9_-]`), and the look-behind that says where
its run starts holds the same class: one that left them out let every position
inside a run of `ſ` start a match (`ſ` repeated 64k times took 46 s). A run
that starts with `ſ` or `K` before a credential keeps the credential: a
prefixed key takes the letter with it, and a JWT keeps it as its lead. The
one shape that needs `u` (the secret-named key, for `\p{Cc}`) spells its words
in both cases with `anyCase` (`token` is `[Tt][Oo][Kk\u212A][Ee][Nn]`) instead
of setting `i`.

## Tests

`test` runs the fast tier, in four files so they run in parallel:

- `provider-redaction.test.ts`: what each shape redacts and keeps, the window,
  profiles and decoding, and every leak rounds 1 to 4 found as a fixed input;
- `regressions.test.ts`: every hostile input a review found a quadratic search
  on, screened once each against a linear scan (`test/adversarial.ts`,
  `assertInputLinear`), and round 5's leaks;
- `detectors.test.ts`: the shared detectors held to the ones they replaced, on
  20k texts each;
- `long-token-profile.test.ts`: `LONG_TOKEN_RUN_PROFILE`, the profile six
  providers share, held to the two-line rule it replaced on 5k texts, once here
  rather than in each provider.

`test:deep` runs `*.deep.test.ts`: every shared shape and detector swept over
its own classes, fragments, repeated pieces and periodic texts, the whole
redactor's growth on each hostile input, a megabyte of each searched whole, the
negative controls the sweep must catch, the detectors at 150k texts, and the
long-token profile at 50k texts on three seeds with its growth and sweep.

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

`data-models/provider_redaction.proto` describes a provider's profile as data:
its pattern sources and options. `data-models/provider_redaction.cue`
constrains it. The TypeScript types hold `RegExp`s, which a record cannot, so
they are not generated from the proto.

## Commands

```bash
pnpm exec turbo run build test --filter ./packages/provider-redaction
pnpm exec turbo run build test:deep --filter ./packages/provider-redaction
```
