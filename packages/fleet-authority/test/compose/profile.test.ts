import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	type AuthorityBus,
	type FleetLogEvent,
	TRUST_RECORD_CONTEXT,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { generateDpopKey, signEnvelope } from "@hobo/fleet/keys";
import { createMemoryBus, createMemoryEventStore } from "@hobo/fleet/testing";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { parseAuthorityConfig } from "../../src/compose/config.js";
import {
	composeAuthority,
	type ProfileAdapters,
} from "../../src/compose/profile.js";
import { composeWitness } from "../../src/compose/witness.js";

const NOW = Date.parse("2026-11-13T10:00:00Z");
const CONFIG = {
	issuer: "https://fleet.example",
	tenant: "acme",
	profile: "standalone",
	natsUrls: ["nats://nats.example:4222"],
	relayUrls: ["https://relay.example"],
	minAgentVersion: "1.2.0",
	dataDir: "state",
	directory: [{ principal: "user:github.com/octo", tags: ["fleet-admin"] }],
	accounts: [
		{
			principal: "service:ci-relay",
			scopes: ["fleet.read"],
			credentialSecret: "relay-credential",
		},
	],
	signIn: [
		{ id: "github", clientId: "Iv1", clientSecretSecret: "github-secret" },
	],
	overlay: [
		{
			provider: "tailscale",
			apiBase: "https://api.tailscale.com",
			organisation: "acme.org",
			credentialSecret: "ts-token",
		},
	],
	// An operations key the authority does not know: ignored.
	witnessTimeoutMs: 120000,
};

function slot(kid: string): string {
	return JSON.stringify({
		v: 1,
		active: kid,
		keys: [
			{ kid, seed: randomBytes(32).toString("base64url"), publicKey: "unused" },
		],
	});
}

/** What the network doubles were handed. */
type Seen = {
	servers?: readonly string[];
	credentials?: string;
	callout?: Readonly<Record<string, string>>;
};

async function fixture(
	options: Readonly<{ incarnation?: number; withCallout?: boolean }> = {},
) {
	let clock = NOW;
	const secrets = createMemorySecretsPort();
	await secrets.put("hobo-fleet/acme/nats-authority", "authority-creds");
	await secrets.put("hobo-fleet/acme/nats-witness", "witness-creds");
	await secrets.put("hobo-fleet/acme/nats-sentinel", "sentinel-creds");
	await secrets.put("hobo-fleet/acme/record-signing", slot("authority#2"));
	await secrets.put("hobo-fleet/acme/witness", slot("witness#1"));
	await secrets.put("relay-credential", "r".repeat(48));
	if (options.withCallout !== false) {
		await secrets.put("hobo-fleet/acme/callout-xkey", "XKEYSEED");
		for (const which of [
			"scoped-observer",
			"scoped-executor",
			"scoped-dispatcher",
		])
			await secrets.put(`hobo-fleet/acme/${which}`, slot(`${which}#1`));
	}
	const bus = createMemoryBus(() => NOW);
	const key = generateDpopKey().signer;
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: "acme",
			sequence: 4,
			authorityIncarnation: options.incarnation ?? 3,
			issuer: "https://fleet.example",
		}),
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(key, TRUST_RECORD_CONTEXT, payload),
			witness: await signEnvelope(key, TRUST_RECORD_CONTEXT, payload),
		}),
	);
	const seen: Seen = {};
	const logs: FleetLogEvent[] = [];
	let calloutLog:
		| ((
				event: FleetLogEvent,
				fields: Readonly<Record<string, string | number | boolean>>,
		  ) => void)
		| undefined;
	const adapters: ProfileAdapters = {
		secrets,
		fetch: async () => new Response("offline", { status: 503 }),
		now: () => clock,
		log: (event) => {
			logs.push(event);
		},
		connectBus: async (input) => {
			seen.servers = input.servers;
			seen.credentials = input.credentials;
			return bus;
		},
		journalStore: async () => createMemoryEventStore(),
		sqliteStore: () => createMemoryEventStore(),
		startCallout: async (input) => {
			seen.callout = {
				xkey: input.xkeySeed,
				observer: input.scopedSeeds.observer,
				incarnation: String(input.incarnation),
			};
			calloutLog = input.log;
			return { async stop() {} };
		},
	};
	const config = parseAuthorityConfig(JSON.stringify(CONFIG), "/srv/fleet");
	if (!config.ok) throw new Error(config.error.message);
	return {
		secrets,
		bus,
		adapters,
		config: config.value,
		seen,
		logs,
		callout: () => calloutLog,
		advance(ms: number) {
			clock += ms;
		},
	};
}

describe("the authority configuration", () => {
	it("resolves defaults and ignores the operations' keys", () => {
		const parsed = parseAuthorityConfig(JSON.stringify(CONFIG), "/srv/fleet");
		expect(parsed).toMatchObject({
			ok: true,
			value: {
				issuer: "https://fleet.example",
				tenant: "acme",
				profile: "standalone",
				dataDir: "/srv/fleet/state",
				secretPrefix: "hobo-fleet/acme",
				natsCredentialsSecret: "hobo-fleet/acme/nats-authority",
				sessionKeySecret: "hobo-fleet/acme/session-key",
				listenHost: "0.0.0.0",
				listenPort: 8443,
			},
		});
	});

	it("refuses a non-https issuer, an unknown profile, no NATS and an unknown provider", () => {
		for (const broken of [
			{ ...CONFIG, issuer: "http://fleet.example" },
			{ ...CONFIG, issuer: "https://fleet.example/path" },
			{ ...CONFIG, profile: "cluster" },
			{ ...CONFIG, natsUrls: [] },
			{ ...CONFIG, signIn: [{ id: "saml", clientId: "x" }] },
			{ ...CONFIG, tenant: "" },
			{ ...CONFIG, listen: "nope" },
		])
			expect(parseAuthorityConfig(JSON.stringify(broken), "/").ok).toBe(false);
	});
});

describe("composing the authority from one configuration", () => {
	it("takes the incarnation from the pinned trust record and signs with the slot's active key", async () => {
		const f = await fixture({ incarnation: 3 });
		const composed = await composeAuthority(f.config, f.adapters);
		if (!composed.ok) throw new Error(composed.error.message);
		const { deps } = composed.value;
		expect(deps.incarnation).toBe(3);
		expect(deps.recordSigner.keyId).toBe("authority#2");
		expect(deps.discovery).toEqual({
			issuer: "https://fleet.example",
			natsUrls: ["nats://nats.example:4222"],
			natsSentinelCredentials: "sentinel-creds",
			relayUrls: ["https://relay.example"],
			minAgentVersion: "1.2.0",
		});
		expect(f.seen).toMatchObject({
			servers: ["nats://nats.example:4222"],
			credentials: "authority-creds",
		});
		expect(deps.signIn.map((provider) => provider.id)).toEqual(["github"]);
		expect(deps.overlayMinters.map((minter) => minter.provider)).toEqual([
			"tailscale",
		]);
		expect(await deps.accounts.verify("r".repeat(48))).toMatchObject({
			ok: true,
			value: { principal: { kind: "service", id: "ci-relay" } },
		});
		expect(
			await deps.directory.tenantsOf(
				{ kind: "user", id: "github.com/octo" },
				{},
			),
		).toEqual([{ tenant: "acme", tags: ["fleet-admin"], aliases: [] }]);
		expect(JSON.parse(deps.issuer.jwks()).keys).toHaveLength(1);
		expect(composed.value.sessionKey).toHaveLength(32);
		await composed.value.stop();
	});

	it("starts a callout responder and records nats-callout availability from its decisions", async () => {
		const f = await fixture();
		const composed = await composeAuthority(f.config, f.adapters);
		if (!composed.ok) throw new Error(composed.error.message);
		await composed.value.start();
		expect(f.seen.callout).toMatchObject({
			xkey: "XKEYSEED",
			incarnation: "3",
		});
		expect(f.seen.callout?.observer).toMatch(/.+/u);
		const log = f.callout();
		log?.("hobo_fleet_callout_refused", {
			check: "member-state",
			reason: "suspended",
		});
		log?.("hobo_fleet_callout_refused", {
			check: "request-signature",
			reason: "unsealed",
		});
		expect(f.logs).toContain("hobo_fleet_callout_refused");
		f.advance(120_000);
		await composed.value.runtime.status.tick();
		const measured = [];
		for await (const positioned of composed.value.deps.store.readAll())
			if (JSON.stringify(positioned.event.data).includes("fleet-nats-callout"))
				measured.push(positioned.event.data);
		expect(measured).toContainEqual(
			expect.objectContaining({
				componentId: "fleet-nats-callout",
				attainment: 0.5,
			}),
		);
		await composed.value.stop();
	});

	it("keeps serving without a callout when its keys are not provisioned", async () => {
		const f = await fixture({ withCallout: false });
		const composed = await composeAuthority(f.config, f.adapters);
		if (!composed.ok) throw new Error(composed.error.message);
		await composed.value.start();
		expect(f.seen.callout).toBeUndefined();
		expect(f.logs).toContain("hobo_fleet_bus_status");
		await composed.value.stop();
	});

	it("refuses to compose without the authority's NATS credentials or record-signing key", async () => {
		const f = await fixture();
		const missing = await composeAuthority(
			{ ...f.config, natsCredentialsSecret: "absent" },
			f.adapters,
		);
		expect(missing.ok).toBe(false);
		const noKey = await composeAuthority(
			{
				...f.config,
				secretPrefix: "elsewhere",
				natsCredentialsSecret: "hobo-fleet/acme/nats-authority",
			},
			f.adapters,
		);
		expect(noKey.ok).toBe(false);
	});

	it("composes the high-availability profile on the journal store", async () => {
		const f = await fixture();
		let journal = 0;
		const composed = await composeAuthority(
			{ ...f.config, profile: "high-availability" },
			{
				...f.adapters,
				journalStore: async () => {
					journal += 1;
					return createMemoryEventStore();
				},
				sqliteStore: () => {
					throw new Error("standalone store in HA");
				},
			},
		);
		expect(composed.ok).toBe(true);
		expect(journal).toBe(1);
	});
});

describe("composing the witness", () => {
	it("connects with the witness's own credentials and signs with the witness slot", async () => {
		const f = await fixture();
		let connectedWith = "";
		const witness = await composeWitness(f.config, {
			secrets: f.secrets,
			now: () => NOW,
			log: () => {},
			connectBus: async (input): Promise<AuthorityBus> => {
				connectedWith = input.credentials;
				return f.bus;
			},
			publish: async () => {},
		});
		expect(witness.ok).toBe(true);
		expect(connectedWith).toBe("witness-creds");
		if (witness.ok) {
			witness.value.start();
			await witness.value.stop();
		}
	});
});
