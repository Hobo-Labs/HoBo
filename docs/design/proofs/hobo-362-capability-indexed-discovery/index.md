# HOBO-362 Capability-Indexed Discovery Proof

This proof ties ADR-0062's agent-drivable registry discovery to the existing Capability Spec and registry
descriptor contract slices. It stays on the discovery side of the `hobo add` boundary: the output is a
queryable candidate list, not an install or resolver decision.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Query by WIT port returns only certified listings implementing it. | `query by WIT port returns only certified listings implementing it` applies two certified listings and asserts only the blobstore capability is returned. |
| Filtering by region/classification narrows results. | `region and classification filters narrow results strictly` excludes a different region and a missing classification. |
| Same query returns identical results via SDK API and MCP tool. | `SDK API and MCP tool return identical discovery results` compares `index.find(query)` with `tool.invoke(query)`. |
| Newly certified listing appears in index and yanked one disappears from new-selection results. | `certified listings enter the index and yanked listings leave new selections` applies `listing.Certified`, then `listing.Yanked`. |
| Query for interface with no certified listing returns empty with remediation hint, not error. | `empty discovery is a successful result with remediation, not an error` asserts `ok: true`, empty results, and remediation text. |
| Uncertified/unlisted artifact never appears in discovery. | `uncertified or unlisted artifacts never appear in discovery` ignores `listing.Published` and failed certification. |
| Classification filter excludes non-satisfying listing rather than silently including it. | `region and classification filters narrow results strictly` includes a no-classification listing that is excluded. |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\capability-indexed-discovery-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
