import type {
	InfisicalAdmin,
	InfisicalOidcTrust,
} from "@hobo/adapter-infisical";
import { createTrustedVault } from "@hobo/core";
import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	CD_STORE_COORDINATES_HANDOFF,
	CD_WORKLOAD_IDENTITY_ENTRY,
	cdStoreCoordinatesText,
	ensureCdWorkloadIdentity,
	vercelTeamSlug,
} from "../src/workload-identity.js";

function fakeAdmin(
	existing?: Readonly<{ name: string; id: string; oidc: boolean }>,
) {
	const calls: string[] = [];
	const trusts: InfisicalOidcTrust[] = [];
	let next = 0;
	const admin: InfisicalAdmin = {
		createProject: async () => {
			throw new Error("not used");
		},
		createFolder: async () => {
			throw new Error("not used");
		},
		findProjectIdentity: async ({ projectId, name }) => {
			calls.push(`find ${name} in ${projectId}`);
			return existing?.name === name ? existing.id : undefined;
		},
		oidcAuthAttached: async (id) => {
			calls.push(`oidc? ${id}`);
			return existing?.id === id && existing.oidc;
		},
		createProjectIdentity: async ({ projectId, name, role }) => {
			next += 1;
			calls.push(`create ${name} in ${projectId} as ${role}`);
			return { identityId: `00000000-0000-4000-8000-00000000000${next}` };
		},
		attachOidcAuth: async (id, trust) => {
			calls.push(`attach ${id}`);
			trusts.push(trust);
		},
		updateOidcAuth: async (id, trust) => {
			calls.push(`update ${id}`);
			trusts.push(trust);
		},
		deleteIdentity: async (id) => {
			calls.push(`delete ${id}`);
		},
		probeToken: async () => "valid",
	};
	return { admin, calls, trusts };
}

function infisicalStore(
	port = createMemorySecretsPort({ id: "memory" }),
): OpenedSecretStore {
	return {
		id: "infisical",
		port,
		reference: (name) => `infisical://proj-1/prod/hobo-cd/${name}`,
	};
}

function signedInVault() {
	const vault = createTrustedVault();
	vault.put("INFISICAL_TOKEN", "owner-session");
	vault.put("VERCEL_TOKEN", "vercel-token");
	vault.put("VERCEL_TEAM_ID", "team_abc");
	return vault;
}

function handedOff(
	vault: ReturnType<typeof createTrustedVault>,
): string | undefined {
	return vault.reveal(CD_STORE_COORDINATES_HANDOFF);
}

const vercel = {
	teamSlug: async () => "acme",
	enableProjectOidc: async () => "enabled" as const,
};

describe("the CD workload identity", () => {
	it("is created once, trusting the hobo-cd project's preview tokens", async () => {
		const { admin, calls, trusts } = fakeAdmin();
		const store = infisicalStore();
		const vault = signedInVault();
		const step = await ensureCdWorkloadIdentity({
			store,
			vault,
			project: "hobo-cd",
			environment: "preview",
			deps: { ...vercel, admin: () => admin },
		});
		expect(step.outcome).toBe("created");
		expect(calls).toEqual([
			"find hobo-cd in proj-1",
			"create hobo-cd in proj-1 as viewer",
			"attach 00000000-0000-4000-8000-000000000001",
		]);
		expect(trusts[0]).toEqual({
			issuer: "https://oidc.vercel.com/acme",
			audiences: ["https://vercel.com/acme"],
			subject: "owner:acme:project:hobo-cd:environment:preview",
			claims: { owner_id: "team_abc" },
			ttlSeconds: 3600,
		});
		const kept = await store.port.access(CD_WORKLOAD_IDENTITY_ENTRY);
		expect(kept.status === "ok" && kept.material).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
		expect(handedOff(vault)).toBe(
			cdStoreCoordinatesText({
				siteUrl: "https://app.infisical.com",
				projectId: "proj-1",
				environment: "prod",
				secretPath: "/hobo-cd",
				identityId: "00000000-0000-4000-8000-000000000001",
			}),
		);
		expect(handedOff(vault)).toContain('"kind": "infisical-cloud-attach"');
		expect(step.detail).not.toContain("00000000-0000-4000-8000-000000000001");
		expect(step.detail).not.toContain("proj-1");
	});

	it("adopts the project's identity of that name instead of creating one", async () => {
		const id = "00000000-0000-4000-8000-0000000000cd";
		for (const oidc of [false, true]) {
			const { admin, calls } = fakeAdmin({ name: "hobo-cd", id, oidc });
			const store = infisicalStore();
			const vault = signedInVault();
			const step = await ensureCdWorkloadIdentity({
				store,
				vault,
				project: "hobo-cd",
				environment: "production",
				deps: { ...vercel, admin: () => admin },
			});
			expect(step.outcome).toBe("created");
			expect(calls).toEqual([
				"find hobo-cd in proj-1",
				`oidc? ${id}`,
				oidc ? `update ${id}` : `attach ${id}`,
			]);
			const kept = await store.port.access(CD_WORKLOAD_IDENTITY_ENTRY);
			expect(kept.status === "ok" && kept.material).toBe(id);
			expect(handedOff(vault)).toContain(id);
		}
	});

	it("is reused on a re-run, its trust re-applied", async () => {
		const { admin, calls } = fakeAdmin();
		const store = infisicalStore();
		await store.port.put(
			CD_WORKLOAD_IDENTITY_ENTRY,
			"00000000-0000-4000-8000-0000000000aa",
		);
		const step = await ensureCdWorkloadIdentity({
			store,
			vault: signedInVault(),
			project: "hobo-cd",
			environment: "preview",
			deps: { ...vercel, admin: () => admin },
		});
		expect(step.outcome).toBe("unchanged");
		expect(calls).toEqual(["update 00000000-0000-4000-8000-0000000000aa"]);
	});

	it("keeps the identity saved first when two runs race, and deletes its own", async () => {
		const { admin, calls } = fakeAdmin();
		const port = createMemorySecretsPort({ id: "memory" });
		const racing: OpenedSecretStore = {
			...infisicalStore(port),
			port: {
				...port,
				access: async (name) =>
					calls.includes("delete 00000000-0000-4000-8000-000000000001")
						? port.access(name)
						: { status: "not-found" },
				createOnly: async (name, value) => {
					await port.put(name, "00000000-0000-4000-8000-0000000000bb");
					return value === "00000000-0000-4000-8000-0000000000bb"
						? { created: true, versionId: "1" }
						: { created: false };
				},
			},
		};
		const vault = signedInVault();
		await ensureCdWorkloadIdentity({
			store: racing,
			vault,
			project: "hobo-cd",
			environment: "preview",
			deps: { ...vercel, admin: () => admin },
		});
		expect(calls).toContain("delete 00000000-0000-4000-8000-000000000001");
		expect(handedOff(vault)).toContain("00000000-0000-4000-8000-0000000000bb");
	});

	it("says why it did nothing where it cannot apply", async () => {
		const { admin, calls } = fakeAdmin();
		const deps = { ...vercel, admin: () => admin };
		const base = {
			project: "hobo-cd",
			environment: "preview" as const,
			deps,
		};
		const bitwarden: OpenedSecretStore = {
			...infisicalStore(),
			id: "bitwarden",
		};
		expect(
			(
				await ensureCdWorkloadIdentity({
					...base,
					store: bitwarden,
					vault: signedInVault(),
				})
			).detail,
		).toMatch(/Infisical only/u);
		const noSession = createTrustedVault();
		noSession.put("VERCEL_TOKEN", "t");
		noSession.put("VERCEL_TEAM_ID", "team_abc");
		expect(
			(
				await ensureCdWorkloadIdentity({
					...base,
					store: infisicalStore(),
					vault: noSession,
				})
			).detail,
		).toMatch(/no Infisical sign-in/u);
		const noTeam = createTrustedVault();
		noTeam.put("INFISICAL_TOKEN", "s");
		noTeam.put("VERCEL_TOKEN", "t");
		expect(
			(
				await ensureCdWorkloadIdentity({
					...base,
					store: infisicalStore(),
					vault: noTeam,
				})
			).detail,
		).toMatch(/no team/u);
		expect(calls).toEqual([]);
	});
});

describe("the Vercel team's slug", () => {
	type TeamsBody = Readonly<{
		id?: string;
		slug?: string;
		teams?: ReadonlyArray<Readonly<{ id: string; slug: string }>>;
		pagination?: Readonly<{ next: number | null }>;
	}>;
	const reply = (status: number, body: TeamsBody) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	it("reads it from the team when the connection may read the team", async () => {
		const http: typeof fetch = async () =>
			reply(200, { id: "team_1", slug: "acme" });
		expect(await vercelTeamSlug("t", "team_1", http)).toBe("acme");
	});

	it("finds it among the sign-in's teams when the team itself answers 403", async () => {
		const seen: string[] = [];
		const http: typeof fetch = async (url) => {
			const target = String(url);
			seen.push(target);
			if (target.endsWith("/v2/teams/team_2")) return reply(403, {});
			if (!target.includes("until="))
				return reply(200, {
					teams: [{ id: "team_1", slug: "other" }],
					pagination: { next: 7 },
				});
			return reply(200, {
				teams: [{ id: "team_2", slug: "acme" }],
				pagination: { next: null },
			});
		};
		expect(await vercelTeamSlug("t", "team_2", http)).toBe("acme");
		expect(seen).toHaveLength(3);
	});

	it("says which answers it got when neither names the team", async () => {
		const http: typeof fetch = async (url) =>
			String(url).endsWith("/v2/teams")
				? reply(200, { teams: [], pagination: { next: null } })
				: reply(403, {});
		await expect(vercelTeamSlug("t", "team_3", http)).rejects.toThrow(
			/HTTP 403.*did not list it/u,
		);
	});
});
