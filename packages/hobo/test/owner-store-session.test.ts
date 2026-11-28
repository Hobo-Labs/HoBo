import {
	createTrustedVault,
	parseResolveOutcome,
	parseResolveRequest,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import type { OwnerChannel, OwnerStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import {
	HOSTINGER_WEB_HOSTING_PRODUCT_ID,
	hostingerResolverRegistry,
} from "@hobo/provider-hostinger";
import { describe, expect, it, vi } from "vitest";

import { createDeployCommand } from "../src/deploy-command.js";
import { createDoctorCommand } from "../src/doctor-command.js";
import {
	createOwnerStoreSessions,
	OwnerCredentialUnavailable,
	type OwnerSignIn,
	ownerChannelSignIn,
	ownerWithPageSession,
	withRelaySession,
} from "../src/owner-store-session.js";

const PRIVATE_PROJECT = "synthetic-private-project-id";
const HOSTINGER_TOKEN = "synthetic-hostinger-owner-token-0123456789";
const STORE_SIGN_IN = "synthetic-store-sign-in-token";
const CWD = "/synthetic/project";

function ownerStoreFor(input: {
	readonly chosen: boolean;
	readonly id?: OwnerStore["id"];
	readonly port?: SecretsPort;
}): OwnerStore {
	const id = input.id ?? "infisical";
	return {
		id,
		chosen: input.chosen,
		missing: [],
		handOffSignIn: undefined,
		opened:
			input.port === undefined
				? undefined
				: {
						id,
						port: input.port,
						reference: (name) =>
							`infisical://${PRIVATE_PROJECT}/prod/hobo-cd/${name}`,
					},
		infisicalFolder: undefined,
		unopened: undefined,
		stage: async () => {
			throw new Error("the session never stages a page");
		},
	};
}

async function storeHolding(entries: Readonly<Record<string, string>>) {
	const port = createMemorySecretsPort({ id: `store:${PRIVATE_PROJECT}` });
	for (const [name, value] of Object.entries(entries))
		await port.put(name, value);
	return port;
}

function signedIn(owner: OwnerStore): OwnerSignIn {
	return async ({ vault }) => {
		vault.put("INFISICAL_TOKEN", STORE_SIGN_IN);
		return { kind: "owner", owner };
	};
}

describe("owner store session", () => {
	it("opens the requested CI or CD family folder during owner sign-in", async () => {
		const folders: string[] = [];
		const port = await storeHolding({});
		const signIn = ownerChannelSignIn({
			env: {},
			owner: {
				openUrl: async () => undefined,
				captureSecret: async () => undefined,
				holds: () => false,
				storeSettings: {
					read: async () => ({
						HOBO_SECRET_STORE: "infisical",
						INFISICAL_PROJECT_ID: PRIVATE_PROJECT,
					}),
					write: async () => undefined,
				},
			},
			deps: {
				openStore: async (_id, coordinates) => {
					folders.push(coordinates.INFISICAL_SECRET_PATH ?? "");
					return {
						ok: true,
						store: { id: "infisical", port, reference: (name) => name },
					};
				},
			},
		});
		for (const family of ["ci", "cd"] as const) {
			const vault = createTrustedVault();
			vault.put("INFISICAL_TOKEN", STORE_SIGN_IN);
			const result = await signIn({ cwd: CWD, vault, family });
			expect(result.kind).toBe("owner");
		}
		expect(folders).toEqual(["/hobo-ci-relay", "/hobo-cd"]);
	});

	it("keeps CI and CD sessions separate for the same project", async () => {
		const ci = await storeHolding({ HOSTINGER_API_TOKEN: "ci-token" });
		const cd = await storeHolding({ HOSTINGER_API_TOKEN: "cd-token" });
		const sessions = createOwnerStoreSessions({
			signIn: async ({ family }) => ({
				kind: "owner",
				owner: ownerStoreFor({ chosen: true, port: family === "ci" ? ci : cd }),
			}),
		});
		await sessions.establish(CWD, undefined, "cd");
		await sessions.establish(CWD, undefined, "ci");
		expect(
			await sessions
				.credentials(CWD, "cd")
				.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).toEqual({ token: "cd-token" });
		expect(
			await sessions
				.credentials(CWD, "ci")
				.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).toEqual({ token: "ci-token" });
		sessions.invalidate?.(CWD, "ci");
		expect(sessions.status(CWD, "ci").established).toBe(false);
		expect(sessions.status(CWD, "cd").established).toBe(true);
		const withRelay = withRelaySession(sessions, {
			held: () => ({
				expiresAt: 1000,
				credentials: { resolve: async () => ({ token: "relay-token" }) },
			}),
			now: () => 0,
		});
		expect(
			await withRelay
				.credentials(CWD, "ci")
				.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).toEqual({ token: "relay-token" });
		expect(
			await withRelay
				.credentials(CWD, "cd")
				.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).toEqual({ token: "cd-token" });
		await sessions.close();
	});

	it("keeps each project's sign-in in that project's vault", async () => {
		const vaults = new Map([
			["/project-a", createTrustedVault()],
			["/project-b", createTrustedVault()],
		]);
		const owner = ownerStoreFor({ chosen: true, port: await storeHolding({}) });
		const sessions = createOwnerStoreSessions({
			keptFor: (cwd) => {
				const vault = vaults.get(cwd);
				if (!vault) throw new Error("Unknown project.");
				return vault;
			},
			signIn: async ({ cwd, vault }) => {
				vault.put("INFISICAL_TOKEN", `token-for-${cwd}`);
				return { kind: "owner", owner };
			},
		});
		await sessions.establish("/project-a");
		await sessions.establish("/project-b");
		expect(vaults.get("/project-a")?.reveal("INFISICAL_TOKEN")).toBe(
			"token-for-/project-a",
		);
		expect(vaults.get("/project-b")?.reveal("INFISICAL_TOKEN")).toBe(
			"token-for-/project-b",
		);
		await sessions.close();
	});

	it("discards a selected store and refuses an older sign-in that finishes later", async () => {
		const owner = ownerStoreFor({
			chosen: true,
			port: await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN }),
		});
		let finish: (() => void) | undefined;
		let calls = 0;
		const sessions = createOwnerStoreSessions({
			signIn: async () => {
				calls += 1;
				if (calls === 2)
					await new Promise<void>((resolve) => {
						finish = resolve;
					});
				return { kind: "owner", owner };
			},
		});
		await sessions.establish(CWD);
		const credentials = sessions.credentials(CWD);
		const pending = sessions.establish(CWD);
		expect(finish).toBeDefined();
		sessions.invalidate?.(CWD);
		await expect(
			credentials.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).rejects.toBeInstanceOf(OwnerCredentialUnavailable);
		finish?.();
		expect(await pending).toMatchObject({ code: "HOBO_OWNER_SESSION_CHANGED" });
		expect(sessions.status(CWD)).toEqual({ established: false });
		await sessions.close();
	});

	it("does not return a credential after its family session is invalidated", async () => {
		const store = await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN });
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const port: SecretsPort = {
			...store,
			access: async (name) => {
				const result = await store.access(name);
				await new Promise<void>((resolve) => {
					release = resolve;
					markStarted?.();
				});
				return result;
			},
		};
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(ownerStoreFor({ chosen: true, port })),
		});
		await sessions.establish(CWD, undefined, "ci");
		const pending = sessions
			.credentials(CWD, "ci")
			.resolve("owner://HOSTINGER_API_TOKEN", "test");
		await started;
		sessions.invalidate?.(CWD, "ci");
		release?.();
		await expect(pending).rejects.toBeInstanceOf(OwnerCredentialUnavailable);
		await sessions.close();
	});

	it("consumes a copied page session only in the sign-in that received it", async () => {
		const captureSecret = vi.fn(async () => undefined);
		const openUrl = vi.fn(async () => {});
		const underlying: OwnerChannel = {
			captureSecret,
			openUrl,
			holds: () => false,
		};
		const first = ownerWithPageSession(underlying, "synthetic-page-session");
		const second = ownerWithPageSession(underlying, undefined);
		const request = {
			name: "INFISICAL_CLI_SESSION",
			title: "Session",
			instructions: "",
		};
		await first.openUrl("https://example.test", "Sign in", request.name);
		expect(openUrl).not.toHaveBeenCalled();
		expect(await second.captureSecret(request)).toBeUndefined();
		expect(await first.captureSecret(request)).toBe("synthetic-page-session");
		expect(await first.captureSecret(request)).toBeUndefined();
		expect(captureSecret).toHaveBeenCalledTimes(2);
	});
	it("establishes a session, keeps the store sign-in, and reports only the store's label", async () => {
		const kept = createTrustedVault();
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(
				ownerStoreFor({
					chosen: true,
					port: await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN }),
				}),
			),
			kept,
		});
		expect(sessions.status(CWD)).toEqual({ established: false });
		const state = await sessions.establish(CWD);
		expect(state).toEqual({ status: "established", store: "Infisical" });
		expect(sessions.status(`${CWD}/`)).toEqual({
			established: true,
			store: "Infisical",
		});
		expect(kept.reveal("INFISICAL_TOKEN")).toBe(STORE_SIGN_IN);
		const visible = JSON.stringify([state, sessions.status(CWD)]);
		expect(visible).not.toContain(PRIVATE_PROJECT);
		expect(visible).not.toContain(STORE_SIGN_IN);
		expect(sessions.status("/synthetic/other")).toEqual({ established: false });
	});

	it("reports sign-in-needed with a code, and unchosen, without opening a session", async () => {
		const refused = createOwnerStoreSessions({
			signIn: async () => ({
				kind: "refused",
				code: "HOBO_OWNER_SIGN_IN",
				message: `Open https://app.infisical.com/project/${PRIVATE_PROJECT}`,
				remediation: [PRIVATE_PROJECT],
			}),
		});
		const state = await refused.establish(CWD);
		expect(state).toEqual({
			status: "sign-in-needed",
			store: "Infisical",
			code: "HOBO_OWNER_SIGN_IN",
			reason: "Open <link>",
		});
		expect(JSON.stringify(state)).not.toContain(PRIVATE_PROJECT);
		const api = createOwnerStoreSessions({
			signIn: async () => ({
				kind: "refused",
				code: "HOBO_CD_INFISICAL_API",
				message: `Infisical refused creating this run's token (HTTP 400) for ${PRIVATE_PROJECT}.`,
				remediation: [],
			}),
		});
		const apiState = await api.establish(CWD);
		expect(apiState).toMatchObject({
			code: "HOBO_CD_INFISICAL_API",
			reason:
				"Infisical refused creating this run's token (HTTP 400) for <id>.",
		});
		expect(JSON.stringify(apiState)).not.toContain(PRIVATE_PROJECT);
		expect(refused.status(CWD)).toEqual({ established: false });

		const unchosen = createOwnerStoreSessions({
			signIn: signedIn(ownerStoreFor({ chosen: false })),
		});
		expect(await unchosen.establish(CWD)).toEqual({ status: "unchosen" });

		const unopened = createOwnerStoreSessions({
			signIn: signedIn(ownerStoreFor({ chosen: true, id: "bitwarden" })),
		});
		expect(await unopened.establish(CWD)).toEqual({
			status: "sign-in-needed",
			store: "Bitwarden",
			code: "HOBO_OWNER_SIGN_IN",
		});

		const thrown = createOwnerStoreSessions({
			signIn: async () => {
				throw new Error(`cannot reach ${PRIVATE_PROJECT}`);
			},
		});
		const failure = await thrown.establish(CWD);
		expect(failure).toMatchObject({ status: "sign-in-needed" });
		expect(JSON.stringify(failure)).not.toContain(PRIVATE_PROJECT);
	});

	it("resolves only owner:// locators from the session and refuses env:// ones, never naming the store", async () => {
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(
				ownerStoreFor({
					chosen: true,
					port: await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN }),
				}),
			),
		});
		const credentials = sessions.credentials(CWD);
		await expect(
			credentials.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).rejects.toBeInstanceOf(OwnerCredentialUnavailable);
		await expect(
			credentials.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).rejects.toThrow(/choose_secret_store/u);

		await sessions.establish(CWD);
		expect(
			await credentials.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).toEqual({ token: HOSTINGER_TOKEN });
		for (const ref of ["HOSTINGER_API_TOKEN", "AMBIENT_TOKEN"].map((name) =>
			["env", name].join("://"),
		)) {
			const refusal = await credentials
				.resolve(ref, "test")
				.catch((error) => error);
			expect(refusal).toBeInstanceOf(OwnerCredentialUnavailable);
			expect(refusal).toMatchObject({ reason: "environment-ref" });
			expect(String(refusal)).toMatch(/choose_secret_store/u);
			expect(String(refusal)).not.toContain(HOSTINGER_TOKEN);
		}
		for (const ref of [
			"owner://NOT_STORED",
			"vault://elsewhere/token",
			"owner://../escape",
		]) {
			await expect(credentials.resolve(ref, "test")).rejects.toBeInstanceOf(
				OwnerCredentialUnavailable,
			);
			const said = await credentials.resolve(ref, "test").catch(String);
			expect(said).not.toContain(PRIVATE_PROJECT);
			expect(said).not.toContain(HOSTINGER_TOKEN);
		}
		await expect(
			sessions
				.credentials("/synthetic/other")
				.resolve("owner://HOSTINGER_API_TOKEN", "test"),
		).rejects.toBeInstanceOf(OwnerCredentialUnavailable);

		sessions.close();
		expect(sessions.status(CWD)).toEqual({ established: false });
	});

	it("reads and writes owner store entries only inside an established session", async () => {
		const port = await storeHolding({});
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(ownerStoreFor({ chosen: true, port })),
		});
		const entries = sessions.entries(CWD);
		await expect(entries.read("HOBO_CI_SECRET_STORE_BINDING")).rejects.toEqual(
			new OwnerCredentialUnavailable(
				"owner://HOBO_CI_SECRET_STORE_BINDING",
				"no-session",
			),
		);
		await expect(
			entries.write("HOBO_CI_SECRET_STORE_BINDING", "{}"),
		).rejects.toBeInstanceOf(OwnerCredentialUnavailable);
		await sessions.establish(CWD);
		await expect(
			entries.read("HOBO_CI_SECRET_STORE_BINDING"),
		).resolves.toBeUndefined();
		await entries.write("HOBO_CI_SECRET_STORE_BINDING", '{"kind":"x"}');
		await expect(entries.read("HOBO_CI_SECRET_STORE_BINDING")).resolves.toBe(
			'{"kind":"x"}',
		);
		expect(port.names()).toEqual(["HOBO_CI_SECRET_STORE_BINDING"]);
		await expect(entries.read("not a name")).rejects.toBeInstanceOf(
			OwnerCredentialUnavailable,
		);
	});

	it("gives Hostinger's resolvers the owner's token through the session, only in the request header", async () => {
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(
				ownerStoreFor({
					chosen: true,
					port: await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN }),
				}),
			),
		});
		await sessions.establish(CWD);
		const credentials = sessions.credentials(CWD);
		const resolver = hostingerResolverRegistry({
			resolveCredential: async (ref) =>
				(await credentials.resolve(ref, "hostinger")).token ?? "",
		}).get(HOSTINGER_WEB_HOSTING_PRODUCT_ID);
		if (resolver === undefined) throw new Error("no web hosting resolver");
		const seen: TransportRequest[] = [];
		const transport = async (
			request: TransportRequest,
		): Promise<TransportResponse> => {
			seen.push(request);
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ data: [{ domain: "example.com" }], meta: {} }),
			};
		};
		const outcome = parseResolveOutcome(
			await resolver.reconcile(
				parseResolveRequest({
					ref: {
						slot: "web",
						productId: HOSTINGER_WEB_HOSTING_PRODUCT_ID,
						logicalId: "example.com",
					},
					desired: { orderId: 8675309 },
					credentialRef: "owner://HOSTINGER_API_TOKEN",
				}),
				transport,
			),
		);
		expect(outcome.outputs.domain).toBe("example.com");
		expect(seen.length).toBeGreaterThan(0);
		for (const request of seen)
			expect(request.headers.authorization).toBe(`Bearer ${HOSTINGER_TOKEN}`);
		expect(JSON.stringify(outcome)).not.toContain(HOSTINGER_TOKEN);
	});

	it("hands hobo deploy the session's credentials for its project", async () => {
		const sessions = createOwnerStoreSessions({
			signIn: signedIn(
				ownerStoreFor({
					chosen: true,
					port: await storeHolding({ HOSTINGER_API_TOKEN: HOSTINGER_TOKEN }),
				}),
			),
		});
		await sessions.establish(CWD);
		let resolved: Readonly<Record<string, string>> | undefined;
		const deploy = createDeployCommand({
			env: {},
			hoboHome: "/synthetic/home",
			credentialsFor: sessions.credentials,
			openCd: async (input) => {
				resolved = await input.credentials?.resolve(
					"owner://HOSTINGER_API_TOKEN",
					"cd-realize:hostinger",
				);
				throw new Error("stop after the credentials were handed over");
			},
		});
		await deploy
			.run({
				context: { cwd: CWD },
				flags: {},
				args: ["status"],
				verb: "deploy",
				emitProgress: () => undefined,
			})
			.catch(() => undefined);
		expect(resolved).toEqual({ token: HOSTINGER_TOKEN });
	});

	it("doctor reports whether the owner store session is established, label only", async () => {
		const established = await createDoctorCommand({
			env: {},
			ownerSession: () => ({ established: true, store: "Infisical" }),
		}).run({
			context: { cwd: CWD },
			flags: {},
			args: [],
			verb: "doctor",
			emitProgress: () => undefined,
		});
		expect(established.data).toMatchObject({
			ownerStoreSession: { established: true, store: "Infisical" },
		});
		const missing = await createDoctorCommand({
			env: {},
			ownerSession: () => ({ established: false }),
		}).run({
			context: { cwd: CWD },
			flags: {},
			args: [],
			verb: "doctor",
			emitProgress: () => undefined,
		});
		expect(missing.data).toMatchObject({
			ownerStoreSession: { established: false },
		});
		expect(missing.remediation).toContain(
			"Connect the owner's secret store with HoBo MCP's choose_secret_store so verbs can use the credentials it holds.",
		);
	});
});
