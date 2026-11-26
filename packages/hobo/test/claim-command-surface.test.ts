/**
 * `hobo claim` — binding a deployment to an account without re-provisioning.
 *
 * Claiming is the moment an anonymous deploy stops being temporary. The whole
 * point is that nothing moves: the URL, the resources, and the running
 * workload are preserved, and only ownership changes. `urlPreserved: true` in
 * the remote payload is that promise stated where a consumer can check it.
 *
 * **The remote and local lanes are chosen by what the user supplied, and a
 * half-supplied remote claim is refused rather than silently falling back.**
 * A `--token` with no `--broker` is not a local claim — it is a user who
 * copied half a command, and running the local path for them would either
 * claim the wrong deployment or report "no deployment" for one that exists on
 * a broker.
 *
 * **Claiming twice is a success, not an error.** The ceremony is triggered by
 * a token that may reach the user through a retried script or a re-read
 * terminal. Reporting failure on the second run would make a correct outcome
 * look broken; `already_claimed` says what happened without pretending work
 * was done.
 *
 * **A local claim continues the fenced stream rather than bypassing it.** The
 * deployment stream is fenced by owner epoch. Appending outside the fence
 * would let a stale process overwrite an ownership change it never saw.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { YardRuntime } from "@hobo/cli";
import { deploymentIdFor, parseArgv } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	type RemoteBrokerClient,
	RemoteBrokerClientError,
	type RemoteClaimRequest,
	type RemoteClaimResult,
} from "../src/broker-remote-client.js";
import {
	type ClaimCommandDeps,
	createClaimCommand,
} from "../src/claim-command.js";
import { createDefaultYardRuntime } from "../src/index.js";

const BROKER = "https://public.example.com";

let openStores: RuntimeLocalEventStore[] = [];
const credentialHomes: string[] = [];

afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
	for (const home of credentialHomes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function runtime(): YardRuntime {
	const created = createDefaultYardRuntime();
	// SAFETY: the default runtime factory owns and returns a RuntimeLocalEventStore.
	openStores.push(created.store as RuntimeLocalEventStore);
	return created;
}

/** A remote client that records its claim call and answers what a test needs. */
function fakeRemote(answer: Partial<RemoteClaimResult> = {}) {
	const calls: RemoteClaimRequest[] = [];
	const unused = async () => {
		throw new Error("Unexpected non-claim operation");
	};
	const client: RemoteBrokerClient = {
		brokerUri: BROKER,
		discover: unused,
		createAnonymousSession: unused,
		place: unused,
		claim: async (input: RemoteClaimRequest) => {
			calls.push(input);
			return {
				deploymentId: "dep-1",
				alreadyClaimed: false,
				owner: { kind: "user", id: "acme" },
				previousOwner: { kind: "user", id: "temp:abc" },
				resources: { web: "https://app.example", kv: "kv://store" },
				primaryUrl: "https://app.example",
				status: "running",
				...answer,
			};
		},
	};
	return {
		calls,
		client,
	};
}

/** A presenter that answers without touching disk or minting anything. */
const NO_PRESENTER: NonNullable<ClaimCommandDeps["presenter"]> = {
	presentAuthenticated: async () => null,
	presentAnonymous: () => {
		throw new Error("not used by claim");
	},
};

async function run(
	args: readonly string[],
	options: {
		readonly flags?: Partial<ReturnType<typeof parseArgv>["flags"]>;
		readonly deps?: ClaimCommandDeps;
		readonly cwd?: string;
	} = {},
) {
	const cwd = options.cwd ?? "/tmp/hobo-claim-project";
	const hoboHome = mkdtempSync(join(tmpdir(), "hobo-claim-credentials-"));
	credentialHomes.push(hoboHome);
	const env = { HOBO_HOME: hoboHome };
	return createClaimCommand({
		env,
		presenter: NO_PRESENTER,
		...options.deps,
	}).run({
		context: {
			cwd,
			projectDir: cwd,
			identity: null,
			clients: { readApi: "fixture", runtime: "fixture" },
		},
		flags: { ...parseArgv(["claim"]).flags, ...options.flags },
		args: [...args],
		verb: "claim",
		emitProgress: () => {},
	});
}

describe("account argument", () => {
	it("refuses without an account, showing both ways to give one", async () => {
		// Claiming to nobody is not a meaningful operation, and the positional
		// and flag forms are both in circulation — a user who knows only one
		// would otherwise be told the other is required.
		const result = await run([]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_ACCOUNT");
		expect(result.message).toContain("hobo claim <account>");
		expect(result.message).toContain("--to <account>");
	});

	it("accepts the account positionally or via --to", async () => {
		const { client, calls } = fakeRemote();
		for (const [args, flags] of [
			[["acme"], { broker: BROKER, token: "tok" }],
			[[], { to: "acme", broker: BROKER, token: "tok" }],
		] as const) {
			await run(args, {
				flags: { ...flags },
				deps: { createRemoteClient: () => client },
			});
		}
		expect(calls.map((call) => call.account)).toEqual(["acme", "acme"]);
	});

	it("treats an empty account as no account at all", async () => {
		// A shell expanding an unset variable produces exactly this, and binding
		// a deployment to the empty-string account would be worse than refusing.
		for (const [args, flags] of [
			[[""], {}],
			[[], { to: "" }],
		] as const) {
			expect((await run(args, { flags: { ...flags } })).code).toBe(
				"HOBO_CLAIM_NO_ACCOUNT",
			);
		}
	});
});

describe("remote lane selection", () => {
	it("refuses a token with no broker rather than falling back to local", async () => {
		// A half-copied command is not a local claim. Running the local path
		// would report "no deployment" for one that exists on a broker — a
		// message that sends the user looking in the wrong place entirely.
		const result = await run(["acme"], { flags: { token: "tok" } });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_BROKER");
		expect((result.remediation ?? []).join(" ")).toContain("--token");
		expect((result.remediation ?? []).join(" ")).toContain("omit both");
	});

	it("refuses a broker with no token, naming where the token comes from", async () => {
		// The token is printed once, by an anonymous `hobo up`. A user who did
		// not keep it needs to be told that, not just that a flag is missing.
		const result = await run(["acme"], { flags: { broker: BROKER } });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_TOKEN");
		expect((result.remediation ?? []).join(" ")).toContain("--anonymous");
		expect((result.remediation ?? []).join(" ")).toContain(BROKER);
		expect(result.data).toMatchObject({ brokerUri: BROKER });
	});

	it("accepts the broker under either flag spelling", async () => {
		// `--broker` and `--brokerUri` both appear in the docs and in existing
		// scripts; honouring one would make the other silently select local.
		for (const flags of [
			{ broker: BROKER, token: "tok" },
			{ brokerUri: BROKER, token: "tok" },
		]) {
			const { client } = fakeRemote();
			const result = await run(["acme"], {
				flags,
				deps: { createRemoteClient: () => client },
			});
			expect(result.ok).toBe(true);
			expect(result.data).toMatchObject({ mode: "remote" });
		}
	});

	it("treats an empty token as absent", async () => {
		expect(
			(await run(["acme"], { flags: { broker: BROKER, token: "" } })).code,
		).toBe("HOBO_CLAIM_NO_TOKEN");
	});
});

describe("remote claim", () => {
	it("binds the deployment and reports the URL as preserved", async () => {
		// Not re-provisioning is the entire product claim. Stating it in the
		// payload is what lets a caller assert it rather than infer it from the
		// URL happening to look the same.
		const { client, calls } = fakeRemote();
		const result = await run(["acme"], {
			flags: { broker: BROKER, token: "tok-1" },
			deps: { createRemoteClient: () => client },
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("claimed");
		expect(result.data).toMatchObject({
			urlPreserved: true,
			primaryUrl: "https://app.example",
			previousOwner: { id: "temp:abc" },
			owner: { id: "acme" },
		});
		expect(calls[0]).toMatchObject({ claimToken: "tok-1", account: "acme" });
	});

	it("counts the preserved resources in the message", async () => {
		// "Bound to acme" alone does not say whether the datastore came along.
		// The count is the cheapest confirmation that nothing was dropped.
		const { client } = fakeRemote();
		const result = await run(["acme"], {
			flags: { broker: BROKER, token: "tok" },
			deps: { createRemoteClient: () => client },
		});
		expect(result.message).toContain("2 resource(s) preserved");
	});

	it("reports a second claim as already bound, not as a failure", async () => {
		// The token can reach the user twice — a retried script, a re-read
		// terminal. Failing the second run would make a correct outcome look
		// broken and invite a destructive retry.
		const { client } = fakeRemote({ alreadyClaimed: true });
		const result = await run(["acme"], {
			flags: { broker: BROKER, token: "tok" },
			deps: { createRemoteClient: () => client },
		});
		expect(result.ok).toBe(true);
		expect(result.status).toBe("already_claimed");
		expect(result.message).toContain("already bound to acme");
	});

	it("offers the credential when the presenter has one, and claims without", async () => {
		// Step-up is optional metadata for a token claim — an agent holds no
		// passkey. Requiring a principal would make claiming impossible from CI.
		const withNone = fakeRemote();
		await run(["acme"], {
			flags: { broker: BROKER, token: "tok" },
			deps: { createRemoteClient: () => withNone.client },
		});
		expect(withNone.calls[0]).not.toHaveProperty("credential");

		const withSome = fakeRemote();
		await run(["acme"], {
			flags: { broker: BROKER, token: "tok" },
			deps: {
				createRemoteClient: () => withSome.client,
				presenter: {
					presentAuthenticated: async () => ({
						scheme: "bearer-session",
						principal: { kind: "user", id: "user:ada" },
						tenant: "acme",
						accessToken: "tok",
						audience: BROKER,
						expiresAt: "2026-02-01T00:00:00.000Z",
					}),
					presentAnonymous: () => {
						throw new Error("not used");
					},
				},
			},
		});
		expect(withSome.calls[0]).toHaveProperty("credential");
	});

	it("surfaces a broker refusal under its own code, with expiry guidance", async () => {
		// Expired, unknown, and already-consumed tokens are three different
		// problems. The broker's code separates them; the remediation covers the
		// most common one without hiding the others.
		const result = await run(["acme"], {
			flags: { broker: BROKER, token: "stale" },
			deps: {
				createRemoteClient: () => ({
					...fakeRemote().client,
					claim: async () => {
						throw new RemoteBrokerClientError(
							"claim token expired",
							"HOBO_CLAIM_TOKEN_EXPIRED",
							{ expiredAt: "2026-01-01T00:00:00.000Z" },
						);
					},
				}),
			},
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("remote_claim_failed");
		expect(result.code).toBe("HOBO_CLAIM_TOKEN_EXPIRED");
		expect(result.data).toMatchObject({
			expiredAt: "2026-01-01T00:00:00.000Z",
		});
		expect((result.remediation ?? []).join(" ")).toContain("TTL elapsed");
	});

	it("lets a non-broker throw escape rather than reporting it as a claim failure", async () => {
		// Only `RemoteBrokerClientError` describes something the broker decided.
		// Catching everything would report a local bug as "your token is bad".
		await expect(
			run(["acme"], {
				flags: { broker: BROKER, token: "tok" },
				deps: {
					createRemoteClient: () => ({
						...fakeRemote().client,
						claim: async () => {
							throw new TypeError("client is broken");
						},
					}),
				},
			}),
		).rejects.toThrow("client is broken");
	});
});

describe("local lane", () => {
	it("refuses without a wired Yard runtime", async () => {
		// The local claim writes to the durable log. Without the runtime there is
		// nothing to write to, and that is a composition problem rather than
		// anything the user typed.
		const result = await run(["acme"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});

	it("reports no deployment for a project that was never deployed", async () => {
		// The deployment id is derived from the project directory, so this is
		// also what a user sees when they claim from the wrong folder. Naming
		// the id and pointing at `hobo up` covers both readings.
		const result = await run(["acme"], {
			cwd: "/tmp/hobo-claim-never-deployed",
			deps: { runtime: runtime() },
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_DEPLOYMENT");
		expect(result.message).toContain("hobo up");
		expect(result.data).toMatchObject({
			deploymentId: deploymentIdFor("/tmp/hobo-claim-never-deployed"),
		});
	});
});
