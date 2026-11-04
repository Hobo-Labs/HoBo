import { createFixtureSession, persistSession } from "../cloud/session.js";
import type { YardSession } from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface LoginCommandDeps {
	// Explicit session (tests). Otherwise a deterministic fixture SVID session is
	// minted for the mocked lane.
	readonly session?: YardSession;
	readonly tenant?: string;
	readonly subject?: string;
	// Persist the session to `.hobo/session.json` so `up`/`down` chain. Default on.
	readonly persist?: boolean;
}

// `hobo login` — establish a Yard session/identity context. Mocked lane: mint a
// deterministic fixture principal (a non-`system`, non-empty-id principal the
// gateway's authorize() accepts) with a scoped session token, and persist it to
// `.hobo/session.json` so `hobo up`/`down` run under it. Full @hobo/identity
// OIDC/SVID brokering is a later slice (noted deviation).
export function createLoginCommand(deps: LoginCommandDeps = {}): CommandModule {
	return {
		run: async ({ context }) => {
			const session =
				deps.session ??
				createFixtureSession({
					...(deps.tenant !== undefined ? { tenant: deps.tenant } : undefined),
					...(deps.subject !== undefined
						? { subject: deps.subject }
						: undefined),
				});

			let sessionFile: string | null = null;
			if (deps.persist !== false) {
				const dir = context.projectDir ?? context.cwd;
				sessionFile = await persistSession(dir, session);
			}

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo login ok (${session.principal.id} @ ${session.tenant})`,
				data: {
					command: "login",
					tenant: session.tenant,
					principal: session.principal,
					token: session.token,
					issuedAt: session.issuedAt,
					...(sessionFile !== null ? { sessionFile } : undefined),
				},
			};
		},
	};
}
