# Sign-in (L30)

`createSignIn` signs a person in to the authority (design §6.5 "People sign
in") and issues a **person token**: a 15-minute JWT from the authority's
`CredentialIssuer`, bound by DPoP (`cnf.jkt`) to the CLI's sign-in key,
refreshable for 12 hours from sign-in.

## Flows

- **Browser.** `start` checks the request (configured provider, this tenant,
  an RFC 7638 `dpop_thumbprint`, a PKCE S256 `code_challenge`, and a loopback
  `redirect_uri`: `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…` only,
  no `localhost`, user info or fragment), appends `fleet.SignInStarted` and
  returns the provider's authorize URL. `callback` completes with the provider,
  maps the principal through `PrincipalDirectory` (`forbidden` when it has no
  entry for this tenant) and appends `fleet.SignInAuthenticated`. `approval`
  shows the `ApprovalView` (principal, host, device, platform and the four
  fingerprint words of the sign-in key). `approve` appends
  `fleet.SignInApproved` and redirects to the loopback address with a one-time
  authority code (or `error=access_denied`). `complete` checks the code, the
  CLI's PKCE verifier and a DPoP proof made with the sign-in key, appends
  `fleet.SignInCompleted`, then issues.
- **Device code.** `start` with `device_flow` returns an 8-letter user code
  from `BCDFGHJKLMNPQRSTVWXZ`, the verification URL and a 5 s poll interval.
  `device` (the code the person typed; any case, dashes and spaces ignored)
  returns the provider's authorize URL; the callback and approval steps are the
  browser's. `poll` answers `sign-in-pending` until the person confirms,
  `forbidden` if they declined, then the credential once.
- **Refresh.** `refresh` takes a verified person token and a DPoP proof made
  with its key, and re-issues for the tags recorded at sign-in until 12 hours
  after it; the last token never outlives that bound.

## Single use across replicas

Each step is one event on `fleet-signin-<state>`, appended with the
`expectedSeq` that step requires, so of two replicas taking the same step one
wins and the other answers `conflict`. A sign-in expires 10 minutes after it
starts. A device sign-in's state is derived from its user code
(`sha256("hobo-fleet/signin-user-code/v1\0" + code)`), so the verification page
on any replica finds the stream without a second index. Each completed sign-in
also appends `fleet.PersonSignedIn` to `fleet-person-<sha256(principal)>`,
which bounds refresh.

## What is stored and logged

The request as the approval page shows it, the authority's own PKCE verifier
for the provider (it never leaves the authority), the principal and tags, and
the SHA-256 of the authority code. Never a token, the authority code itself or
the CLI's PKCE verifier.

## DPoP

Proofs are checked with `htm` `POST` and `htu` the pinned trust record's
`issuer` followed by the route (`/v1/fleet/signin/complete`,
`/v1/fleet/signin/device/poll`, `/v1/fleet/signin/refresh`). Their `jti` is
claimed through `bus.replay` under a sign-in scope, so the refresh route's own
authentication of the same proof does not count as a replay.
