import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	BROKER_DISCOVERY_SCHEMA,
	createBrokerAwareUpCommand,
	createBrokerDiscoveryClient,
	createClaimCommand,
	createCredentialPresenter,
	createMockRemoteBrokerState,
	defaultMockDiscovery,
	parseBrokerDiscoveryDocument,
	resolveBrokerTarget,
	resolveBrokerUriFromFlags,
	upsertLoginProfile,
	wantsAnonymousMode,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

describe("broker target resolution", () => {
	it("orders flag > env > profile > local", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-profile-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));

		expect(
			resolveBrokerTarget({
				flags: {},
				env: {},
				hoboHome,
			}),
		).toEqual({ kind: "local" });

		upsertLoginProfile({
			hoboHome,
			principal: { kind: "user", id: "user:alice" },
			tenant: "acme",
			token: "tok",
			brokerUri: "https://profile.example.com",
		});
		expect(
			resolveBrokerTarget({
				flags: {},
				env: {},
				hoboHome,
			}),
		).toMatchObject({
			kind: "remote",
			uri: "https://profile.example.com",
			source: "profile",
		});

		expect(
			resolveBrokerTarget({
				flags: {},
				env: { HOBO_BROKER: "https://env.example.com" },
				hoboHome,
			}),
		).toMatchObject({
			kind: "remote",
			uri: "https://env.example.com",
			source: "env",
		});

		expect(
			resolveBrokerTarget({
				flags: { broker: "https://flag.example.com" },
				env: { HOBO_BROKER: "https://env.example.com" },
				hoboHome,
			}),
		).toMatchObject({
			kind: "remote",
			uri: "https://flag.example.com",
			source: "flag",
		});
	});

	it("treats --broker and --broker-uri as aliases; anonymous and temporary as aliases", () => {
		expect(
			resolveBrokerUriFromFlags({ brokerUri: "https://a.example.com" }),
		).toBe("https://a.example.com");
		expect(
			resolveBrokerUriFromFlags({
				broker: "https://b.example.com",
				brokerUri: "https://a.example.com",
			}),
		).toBe("https://b.example.com");
		expect(wantsAnonymousMode({ anonymous: true })).toBe(true);
		expect(wantsAnonymousMode({ temporary: true })).toBe(true);
		expect(wantsAnonymousMode({})).toBe(false);
	});
});

describe("discovery parse-don't-validate", () => {
	it("accepts a valid document and rejects invalid", () => {
		const doc = parseBrokerDiscoveryDocument(
			defaultMockDiscovery("https://public.example.com"),
		);
		expect(doc.schemaVersion).toBe(BROKER_DISCOVERY_SCHEMA);
		expect(doc.supportsAnonymous).toBe(true);

		expect(() =>
			parseBrokerDiscoveryDocument({ schemaVersion: "nope" }),
		).toThrow(/schemaVersion/);
		expect(() => parseBrokerDiscoveryDocument(null)).toThrow(/object/);
	});
});

describe("remote anonymous up + claim", () => {
	it("anonymous up returns claim material; claim preserves resources/URL", async () => {
		const mock = createMockRemoteBrokerState({
			brokerUri: "https://public.example.com",
			supportsAnonymous: true,
		});
		const discovery = createBrokerDiscoveryClient({
			fixed: new Map([["https://public.example.com", mock.discovery]]),
		});
		// The commands' home. The presenter's offline fixture writes its DPoP key there, and an
		// env with no HOBO_HOME would put it in the user's own ~/.hobo.
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-anon-home-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const up = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery,
			env: { HOBO_HOME: hoboHome },
		});
		const claim = createClaimCommand({
			mockRemote: mock,
			discovery,
			env: { HOBO_HOME: hoboHome },
		});

		const projectDir = await mkdtemp(join(tmpdir(), "hobo-anon-proj-"));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(projectDir, "dist"), { recursive: true });
		await writeFile(
			join(projectDir, "dist", "bindle.js"),
			`export default { name: "hello", resources: {}, edges: [] };\n`,
		);

		const upResult = await up.run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: projectDir, projectDir } as never,
			flags: {
				json: true,
				camp: null,
				cwd: projectDir,
				verbose: false,
				quiet: false,
				help: false,
				to: null,
				rollback: false,
				seed: false,
				restore: null,
				strategy: null,
				target: null,
				check: false,
				last: false,
				offline: false,
				template: null,
				force: false,
				hold: false,
				runtime: null,
				config: null,
				policies: null,
				request: null,
				init: false,
				once: false,
				port: null,
				home: null,
				host: null,
				broker: "https://public.example.com",
				brokerUri: null,
				anonymous: true,
				temporary: false,
				token: null,
			},
			args: [],
			verb: "up",
			emitProgress: () => {},
		});

		expect(upResult.ok).toBe(true);
		expect(upResult.status).toBe("deployed_anonymous");
		// SAFETY: assertion required at this I/O or test boundary.
		const data = upResult.data as {
			claimToken: string;
			primaryUrl: string;
			resources: Record<string, string>;
			mode: string;
		};
		expect(data.mode).toBe("anonymous");
		expect(data.claimToken).toMatch(/^claim_/);
		expect(data.primaryUrl).toContain("anon");

		const claimResult = await claim.run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: projectDir } as never,
			flags: {
				json: true,
				camp: null,
				cwd: projectDir,
				verbose: false,
				quiet: false,
				help: false,
				to: null,
				rollback: false,
				seed: false,
				restore: null,
				strategy: null,
				target: null,
				check: false,
				last: false,
				offline: false,
				template: null,
				force: false,
				hold: false,
				runtime: null,
				config: null,
				policies: null,
				request: null,
				init: false,
				once: false,
				port: null,
				home: null,
				host: null,
				broker: "https://public.example.com",
				brokerUri: null,
				anonymous: false,
				temporary: false,
				token: data.claimToken,
			},
			args: ["acme"],
			verb: "claim",
			emitProgress: () => {},
		});
		expect(claimResult.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
		const cdata = claimResult.data as {
			primaryUrl: string;
			resources: Record<string, string>;
			owner: { id: string };
		};
		expect(cdata.primaryUrl).toBe(data.primaryUrl);
		expect(cdata.resources).toEqual(data.resources);
		expect(cdata.owner.id).toBe("acme");
		expect(
			existsSync(join(hoboHome, "keys", "dpop-user_local-fixture.json")),
		).toBe(true);
	});

	it("fails closed when anonymous requested but not advertised", async () => {
		const mock = createMockRemoteBrokerState({
			brokerUri: "https://locked.example.com",
			supportsAnonymous: false,
		});
		const discovery = createBrokerDiscoveryClient({
			fixed: new Map([["https://locked.example.com", mock.discovery]]),
		});
		const up = createBrokerAwareUpCommand({
			mockRemote: mock,
			discovery,
			env: {},
		});
		const projectDir = await mkdtemp(join(tmpdir(), "hobo-noanon-"));
		cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(projectDir, "dist"), { recursive: true });
		await writeFile(
			join(projectDir, "dist", "bindle.js"),
			`export default { name: "hello", resources: {}, edges: [] };\n`,
		);

		const result = await up.run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: projectDir, projectDir } as never,
			flags: {
				json: true,
				camp: null,
				cwd: projectDir,
				verbose: false,
				quiet: false,
				help: false,
				to: null,
				rollback: false,
				seed: false,
				restore: null,
				strategy: null,
				target: null,
				check: false,
				last: false,
				offline: false,
				template: null,
				force: false,
				hold: false,
				runtime: null,
				config: null,
				policies: null,
				request: null,
				init: false,
				once: false,
				port: null,
				home: null,
				host: null,
				broker: "https://locked.example.com",
				brokerUri: null,
				anonymous: true,
				temporary: false,
				token: null,
			},
			args: [],
			verb: "up",
			emitProgress: () => {},
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_ANON_NOT_SUPPORTED");
	});

	it("expired claim token fails closed", () => {
		let t = 1_000_000;
		const mock = createMockRemoteBrokerState({
			brokerUri: "https://public.example.com",
			now: () => t,
		});
		const session = mock.createAnonymousSession("x");
		t = session.ttlSeconds * 1000 + 1_000_000 + 1;
		expect(() =>
			mock.claim({ claimToken: session.claimToken, account: "acme" }),
		).toThrow(/expired/i);
	});
});

describe("credential presenter dual principals", () => {
	it("keeps agent and human principals distinct", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-cred-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		upsertLoginProfile({
			hoboHome,
			principal: { kind: "user", id: "user:alice" },
			tenant: "acme",
			token: "human-token",
		});
		const presenter = createCredentialPresenter({
			agentPrincipal: { kind: "agent", id: "agent:worker-1" },
		});
		const cred = await presenter.presentAuthenticated({
			audience: "https://broker.example.com",
			hoboHome,
			env: { HOBO_AGENT_SVID: "spiffe://hobo.local/agent/worker-1" },
		});
		expect(cred).not.toBeNull();
		expect(must(cred).principal.kind).toBe("agent");
		expect(must(cred).humanPrincipal?.id).toBe("user:alice");
		expect(must(cred).scheme).toBe("dpop-bound");
		expect(must(cred).dpopProof).toBeTruthy();
	});
});

describe("remote claim missing token", () => {
	it("requires token with broker", async () => {
		const claim = createClaimCommand({ env: {} });
		const result = await claim.run({
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd: "/tmp" } as never,
			flags: {
				json: true,
				camp: null,
				cwd: "/tmp",
				verbose: false,
				quiet: false,
				help: false,
				to: null,
				rollback: false,
				seed: false,
				restore: null,
				strategy: null,
				target: null,
				check: false,
				last: false,
				offline: false,
				template: null,
				force: false,
				hold: false,
				runtime: null,
				config: null,
				policies: null,
				request: null,
				init: false,
				once: false,
				port: null,
				home: null,
				host: null,
				broker: "https://public.example.com",
				brokerUri: null,
				anonymous: false,
				temporary: false,
				token: null,
			},
			args: ["acme"],
			verb: "claim",
			emitProgress: () => {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_TOKEN");
	});
});
