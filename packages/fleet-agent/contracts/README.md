# Contracts

`@hobo/fleet-agent` is scaffolded by the fleet contract commit (ADR-0182).
`placeholder.pact.json` holds no interactions yet; it exists so the package's
contract folder is present from the first commit. The lanes that build this
package add one pact per service boundary it crosses (for the authority, its HTTP API) and replay each from both sides in `test/`.

`api.snapshot.d.ts`, when present, is the emitted declaration of the package's
frozen entry points, written by `scripts/emit-fleet-contracts.mts --write` and
compared by `--check`; only the coordinator changes it.
