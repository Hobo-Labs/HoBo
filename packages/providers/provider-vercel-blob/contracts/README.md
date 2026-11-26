# Contracts

One boundary crosses out of this package: the binding's calls to the Vercel
Blob API, made through the pinned `@vercel/blob` 2.8.2 SDK.

## `vercel-blob-ephemeral-state.pact.json` — the HTTP contract

`@hobo/provider-vercel-blob`'s `EphemeralStatePort` binding, together with the
SDK it calls, is the **consumer**; the Vercel Blob API for a private store is
the **provider**.

Each interaction is one HTTP exchange as the SDK sends it: method, path,
query, the body, and only the request headers the binding's behaviour depends
on:

| Header | Pinned because |
|---|---|
| `x-vercel-blob-access: private` | the store is private; every read is authenticated |
| `x-allow-overwrite: 0` | `putIfAbsent` and creating a counter are create-only uploads |
| `x-allow-overwrite: 1` + `x-if-match` | every other write is conditional on the ETag the binding read |
| `x-add-random-suffix: 0` | a key's pathname must be exactly the one derived from the key |
| `x-content-type`, `x-cache-control-max-age` | the record is JSON; the CDN copy is never read and is kept for the minimum |

Reads are `GET <blob url>?cache=0` (`useCache: false`, an origin read), and a
delete is `POST /delete` with `{ "urls": [pathname] }` and `x-if-match`. The
request bodies are the records themselves, so the record format is pinned too.

Responses pin the status, the `etag` header of a read, and the response
fields the SDK maps (`etag` of an upload, `pathname`, `uploadedAt` and `etag`
of a listing). URL fields carry the emulator's port and are not pinned.

One interaction is sent by **another writer**, not by the binding: it bumps
the counter between the binding's read and its conditional upload, so the
pact records the `412 precondition_failed` the binding must turn into a
re-read and a retry.

`test/blob-pact.test.ts` replays both sides. The consumer side drives the
binding through the port and the real SDK against a server that answers with
the pact's responses, and asserts it sends exactly the pact's requests and
reaches the expected results. The provider side sends every request, in order
and including the other writer's, to the local emulator
(`test/fixtures/http-emulator.ts`) and compares status, ETag and pinned
fields. `UPDATE_VERCEL_BLOB_PACT=1` re-records the file from the emulator.

**Hand-authored, not provider-verified.** The provider side is a stand-in
built from the SDK's source and Vercel's docs; nothing here has been replayed
against Vercel. Two answers in it are not documented anywhere and are the
emulator's guesses:

- the refusal of a create-only upload on an existing pathname (`400
  bad_request`, "This blob already exists…") — the binding does not depend on
  the wording: any `BlobError` mentioning "already exists" or
  `allowOverwrite`, and any unclassified `BlobUnknownError`, is treated as a
  refusal and confirmed by reading the blob;
- a conditional delete of a blob that is already gone (`412`) — the binding
  treats `412` and `not_found` alike.

`test/sdk-wire.test.ts` pins the same mappings directly against the SDK:
option to header, `?cache=0`, `precondition_failed` →
`BlobPreconditionFailedError` for both upload and delete, `404` → `null`.
