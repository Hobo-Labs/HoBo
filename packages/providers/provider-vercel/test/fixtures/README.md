# Offline fixtures — sponsored project transfer

Sanitized response bodies shaped like the documented Vercel REST contract. Every
credential-looking value here is **obviously fake** (`FAKE-`, `example`,
`000000`) so a fixture can never be mistaken for a live secret and a leaked
fixture is worth nothing.

Shapes come from the endpoints read on **2026-08-08**:

| Fixture | Endpoint | Source |
|---|---|---|
| `transfer-request.created.json` | `POST /projects/{idOrName}/transfer-request` | [create-project-transfer-request](https://vercel.com/docs/rest-api/reference/endpoints/projects/create-project-transfer-request) |
| `project.owned-by-sponsor.json` | `GET /v9/projects/{idOrName}` | [find-a-project-by-id-or-name](https://vercel.com/docs/rest-api/reference/endpoints/projects/find-a-project-by-id-or-name) |
| `project.after-transfer.json` | `GET /v9/projects/{idOrName}` | same |
| `token.deleted.json` | `DELETE /v3/user/tokens/{tokenId}` | [delete-an-authentication-token](https://vercel.com/docs/rest-api/reference/endpoints/authentication/delete-an-authentication-token) |
| `transfer-request.expired.json` | `410` from the transfer endpoints | [create-project-transfer-request](https://vercel.com/docs/rest-api/reference/endpoints/projects/create-project-transfer-request) |
| `resource-probe.prisma-postgres.json` | HoBo-side probe, not a Vercel endpoint | see `src/post-claim.ts` |

`resource-probe.prisma-postgres.json` is explicitly **not** a provider contract:
Vercel documents resource-transfer verify/accept on the *integration server*
side, so there is no claims-generator-side endpoint to mirror. The probe is a
HoBo port and this fixture is its shape.
