/**
 * A small fleet in one process, for the demo and the agent tests: the test
 * authority (`createTestAuthority`) behind the in-process HTTP stand-in, the
 * memory bus behind a memory connector, one many-active fleet whose owner
 * auto-approves, bootstrap tokens, and agents built from the in-memory key
 * store, the fake sandbox driver and a work kind whose source and runner the
 * caller fills.
 */
import { create } from "@bufbuild/protobuf";
import { type PrincipalRef, parseTenantId, type TenantId } from "@hobo/core";
import {
	ApprovalMode,
	CapacitySchema,
	CoordinationMode,
	DeviceClass,
	type FleetRecord,
	FleetRecordSchema,
	Health,
	ReceiptStatus,
	type Role,
	SandboxTier,
	SessionPurpose,
	TokenCreateRequestSchema,
	WorkNeedsSchema,
	type WorkOffer,
	WorkOrigin,
} from "../src/_generated/fleet_pb.js";
import { createFleetAgent } from "../src/agent/index.js";
import { type FleetId, parseFleetId } from "../src/ids.js";
import { createMemoryKeyStore } from "../src/keys/index.js";
import type {
	AgentDeps,
	CapacitySource,
	Clock,
	EgressProxyFactory,
	FleetLog,
	KeyStore,
	UpstreamWork,
	VerifiedToken,
	WorkRunner,
	WorkSource,
} from "../src/ports.js";
import {
	createFakeSandboxDriver,
	createTestAuthority,
} from "../src/testing/plumbing/index.js";
import { AUTHORITY_ORIGIN, httpAuthority } from "./authority-http.js";
import { createMemoryConnector } from "./memory-connector.js";

export const KIND = "demo-command";
export const FLEET: FleetId = parseFleetId("hobo");
export const TENANT: TenantId = parseTenantId("test");
const ADMIN: PrincipalRef = { kind: "user", id: "admin" };
const DAY_MS = 24 * 3_600_000;

export type World = Awaited<ReturnType<typeof createWorld>>;

/** The test authority, its HTTP stand-in and bus connector, and fleet `hobo` defined by its owner. */
export async function createWorld(now: Clock) {
	const composed = await createTestAuthority(now);
	const http = httpAuthority(composed.authority, now);
	const connector = createMemoryConnector(composed.bus);
	await composed.signInAs(ADMIN, ["fleet-admin"]);
	const admin: VerifiedToken = {
		kind: "person",
		principal: ADMIN,
		tenant: TENANT,
		tags: ["fleet-admin"],
		jkt: "admin-key",
		expiresAtMs: now() + DAY_MS,
	};
	const defined = await composed.authority.defineFleet(
		create(FleetRecordSchema, {
			fleetId: FLEET,
			tenant: TENANT,
			owner: "user:admin",
			coordination: CoordinationMode.MANY_ACTIVE,
			policy: {
				approval: ApprovalMode.AUTO_OWNER,
				sessionPurposes: [SessionPurpose.SHELL],
			},
		}),
		admin,
	);
	if (!defined.ok) throw new Error(`defineFleet: ${defined.error.message}`);

	async function token(
		name: string,
		roles: readonly Role[],
		fleet: FleetId = FLEET,
	): Promise<string> {
		const issued = await composed.authority.issueToken(
			create(TokenCreateRequestSchema, {
				fleet,
				name,
				displayName: name,
				deviceClass: DeviceClass.DEDICATED,
				roles: [...roles],
				ttlSeconds: 900,
			}),
			admin,
		);
		if (!issued.ok) throw new Error(`issueToken: ${issued.error.message}`);
		return issued.value.token;
	}

	/** Another many-active fleet with the same owner; `keyBundleHours` 0 is the policy default. */
	async function defineFleet(
		fleet: FleetId,
		keyBundleHours = 0,
	): Promise<void> {
		const outcome = await composed.authority.defineFleet(
			create(FleetRecordSchema, {
				fleetId: fleet,
				tenant: TENANT,
				owner: "user:admin",
				coordination: CoordinationMode.MANY_ACTIVE,
				policy: { approval: ApprovalMode.AUTO_OWNER, keyBundleHours },
			}),
			admin,
		);
		if (!outcome.ok) throw new Error(`defineFleet: ${outcome.error.message}`);
	}

	return { ...composed, http, connector, admin, token, defineFleet };
}

/** A work source the caller fills; it prepares an empty secret and remembers what it prepared. */
export function queueSource(now: Clock) {
	const queue: (UpstreamWork & Readonly<{ fleet: string }>)[] = [];
	const prepared: string[] = [];
	const source: WorkSource = {
		kind: KIND,
		async poll(fleet: FleetRecord) {
			return queue.filter((work) => work.fleet === fleet.fleetId);
		},
		async prepare(offer: WorkOffer) {
			prepared.push(offer.workKey);
			const index = queue.findIndex((work) => work.workKey === offer.workKey);
			if (index >= 0) queue.splice(index, 1);
			return {
				ok: true,
				value: { parameters: {}, secret: new Uint8Array(), egressAllow: [] },
			};
		},
		async stillWanted() {
			return true;
		},
	};
	const add = (workKey: string, fleet: FleetId = FLEET) =>
		queue.push({
			fleet,
			workKey,
			label: "hobo",
			needs: create(WorkNeedsSchema, { labels: [] }),
			author: "github:1",
			origin: WorkOrigin.INTERNAL,
			repository: "",
			ref: "",
			workflowDigest: "",
			queuedAtMs: now(),
		});
	return { source, add, prepared };
}

/** A runner that succeeds, or waits for `hold` to be released first. */
export function heldRunner() {
	const ran: string[] = [];
	let release: (() => void) | undefined;
	let held: Promise<void> | undefined;
	const runner: WorkRunner = {
		kind: KIND,
		async run(input) {
			ran.push(input.order.offer?.workKey ?? "");
			input.onLog(new TextEncoder().encode(`ran ${input.order.orderId}\n`));
			if (held !== undefined) await held;
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: "sha256:00",
				observedWorkKey: input.order.offer?.workKey ?? "",
			};
		},
	};
	return {
		runner,
		ran,
		hold() {
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release() {
			release?.();
			held = undefined;
		},
	};
}

export function slots(count: number): CapacitySource {
	return {
		async read() {
			return {
				capacity: create(CapacitySchema, {
					freeSlots: count,
					totalSlots: count,
				}),
				health: Health.REACHABLE,
				labels: [],
			};
		},
	};
}

export const openEgress: EgressProxyFactory = {
	async open() {
		return { url: "http://egress.invalid:3128", async close() {} };
	},
};

/** An agent of this world. Every dependency can be replaced. */
export function agentIn(
	world: World,
	options: Readonly<{
		now: Clock;
		log?: FleetLog;
		keys?: KeyStore;
		runners?: readonly WorkRunner[];
		sources?: readonly WorkSource[];
		capacity?: CapacitySource;
		sponsored?: AgentDeps["sponsored"];
		fetch?: typeof fetch;
	}>,
) {
	const keys = options.keys ?? createMemoryKeyStore();
	const deps: AgentDeps = {
		keys,
		authorityUrl: AUTHORITY_ORIGIN,
		tenant: TENANT,
		connector: world.connector,
		capacity: options.capacity ?? slots(2),
		runners: options.runners ?? [],
		sources: options.sources ?? [],
		sandboxes: [
			createFakeSandboxDriver(SandboxTier.S1_CONTAINER),
			createFakeSandboxDriver(SandboxTier.S2_USER_KERNEL),
			createFakeSandboxDriver(SandboxTier.S3_MICROVM),
		],
		egress: openEgress,
		transports: [],
		agentVersion: "1.0.0",
		now: options.now,
		log: options.log ?? (() => {}),
		fetch: options.fetch ?? world.http.fetch,
	};
	return {
		agent: createFleetAgent(
			options.sponsored === undefined
				? deps
				: { ...deps, sponsored: options.sponsored },
		),
		keys,
	};
}
