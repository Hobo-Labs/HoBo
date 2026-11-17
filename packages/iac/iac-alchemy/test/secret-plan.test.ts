/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: these fixtures deliberately construct incomplete or malformed native plans and untrusted observations to test the external input boundary. */
import { createHash, createSecretKey } from "node:crypto";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { alchemyTarget } from "../src/index.js";
import {
	type AlchemyCompositeGuard,
	AlchemyIacError,
	captureAlchemyInspection,
	hashAlchemyPriorState,
	inspectAlchemyPlan,
	reinspectAlchemyPlan,
	verifyCompositeEnvironment,
} from "../src/plan.js";
import {
	type AlchemyPriorStateSecrets,
	captureAlchemySecrets,
	fingerprintAlchemyRedacted,
} from "../src/secret-fingerprint.js";
import { registerAlchemySource } from "../src/source-fence.js";

const TOKEN = "low-entropy-private-token";
const scope = {
	tenantId: "tenant",
	targetId: "yard",
	stackName: "App",
	stage: "test",
};
const fingerprint = () => ({
	key: createSecretKey(Buffer.alloc(32, 23)),
	epoch: "host-epoch-1",
	proofRef: "host:key-proof",
	verify: () => true,
});
const prior = (): AlchemyPriorStateSecrets => ({
	scope,
	fingerprint: fingerprint(),
	resourceId: "store",
	resourceType: "Spec.Store",
});

function fixture(token = TOKEN) {
	const redacted = Redacted.make(token);
	const node = {
		resource: {
			FQN: "store",
			Type: "Spec.Store",
			LogicalId: "store",
			Props: { token: redacted },
			RemovalPolicy: "destroy",
		},
		action: "create",
		provider: { version: "1" },
		state: undefined,
		bindings: [],
		downstream: [],
		props: { token: redacted },
	};
	const plan = {
		stack: { name: "App", stage: "test" },
		resources: [{ fqn: "store", resourceType: "Spec.Store", action: "create" }],
		actions: [],
		native: {
			resources: { store: node },
			deletions: {},
			actions: {},
			actionDeletions: {},
			cycleMembers: new Set<string>(),
			output: {},
			destroy: false,
		},
	};
	const target = alchemyTarget({
		...scope,
		programResourceId: "app",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		inventoryEvidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "store",
				resourceType: "Spec.Store",
				providerId: "test",
				providerAccountRef: "account",
				productId: "storage",
			},
		],
	});
	const guard: AlchemyCompositeGuard = {
		proofRef: "host:proof",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment: () => true,
		verifyPlan: () => true,
		secretFingerprint: fingerprint(),
	};
	return { redacted, node, plan, target, guard };
}

describe("host-authenticated Alchemy secret fingerprints", () => {
	it.each([
		"hash",
		"inspect",
		"replay",
	] as const)("does not let a reentrant %s failure forge an inspector classification", (mode) => {
		const f = fixture();
		const other = fixture();
		let previous: unknown;
		try {
			hashAlchemyPriorState({ token: Redacted.make(TOKEN) });
		} catch (error) {
			previous = error;
		}
		expect(previous).toMatchObject({ code: "PLAN_SECRET_UNVERIFIED" });
		Object.defineProperty(f.plan.stack, "name", {
			get() {
				if (mode === "replay") throw previous;
				if (mode === "hash")
					return hashAlchemyPriorState({ token: Redacted.make(TOKEN) });
				return inspectAlchemyPlan(other.plan as never, other.target).digest;
			},
		});
		const result = captureAlchemyInspection(f.plan as never, f.target, f.guard);
		expect(result).toEqual({ ok: false, code: "PLAN_UNINSPECTABLE" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("preserves a failure created by the current inspection itself", () => {
		const f = fixture();
		const result = captureAlchemyInspection(f.plan as never, f.target, {
			...f.guard,
			verifyPlan: () => false,
		});
		expect(result).toEqual({ ok: false, code: "COMPOSITE_PLAN_UNVERIFIED" });
	});

	it("fails closed without a verified key and never reveals secret or unkeyed hash", () => {
		const f = fixture();
		const { secretFingerprint: _secretFingerprint, ...noKey } = f.guard;
		// SAFETY: the fixture constructs a minimal native plan to exercise its data boundary.
		expect(() => inspectAlchemyPlan(f.plan as never, f.target, noKey)).toThrow(
			"PLAN_SECRET_UNVERIFIED",
		);
		const seen: string[] = [];
		const guard = {
			...f.guard,
			verifyPlan: (observation: unknown) => {
				seen.push(JSON.stringify(observation));
				return true;
			},
		};
		const first = inspectAlchemyPlan(f.plan as never, f.target, guard).digest;
		const serialized = JSON.stringify({ first, seen });
		expect(serialized).not.toContain(TOKEN);
		expect(serialized).not.toContain(
			createHash("sha256").update(TOKEN).digest("hex"),
		);
		try {
			inspectAlchemyPlan(f.plan as never, f.target, {
				...guard,
				secretFingerprint: {
					...fingerprint(),
					verify: () => {
						throw new Error(TOKEN);
					},
				},
			});
			throw new Error("verification unexpectedly passed");
		} catch (error) {
			expect(String(error)).toContain("PLAN_SECRET_UNVERIFIED");
			expect(String(error)).not.toContain(TOKEN);
		}
	});

	it("pins secret, scope, key, epoch, resource, purpose and exact path across restarts", () => {
		const config = prior();
		const value = { token: Redacted.make(TOKEN) };
		const first = hashAlchemyPriorState(value, config);
		expect(
			hashAlchemyPriorState(value, { ...config, fingerprint: fingerprint() }),
		).toBe(first);
		expect(
			hashAlchemyPriorState({ token: Redacted.make("different") }, config),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				scope: { ...scope, tenantId: "other" },
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				scope: { ...scope, targetId: "other" },
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				scope: { ...scope, stackName: "Other" },
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				scope: { ...scope, stage: "other" },
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				fingerprint: {
					...fingerprint(),
					key: createSecretKey(Buffer.alloc(32, 24)),
				},
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, {
				...config,
				fingerprint: { ...fingerprint(), epoch: "host-epoch-2" },
			}),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, { ...config, resourceId: "other" }),
		).not.toBe(first);
		expect(
			hashAlchemyPriorState(value, { ...config, resourceType: "Spec.Other" }),
		).not.toBe(first);
		const captured = captureAlchemySecrets(config);
		const redacted = Redacted.make(TOKEN);
		const direct = fingerprintAlchemyRedacted(redacted, captured, ["p:token"]);
		expect(
			fingerprintAlchemyRedacted(redacted, captured, ["p:other"]),
		).not.toBe(direct);
		expect(
			fingerprintAlchemyRedacted(
				redacted,
				{ ...captured, domain: "deletion-properties" },
				["p:token"],
			),
		).not.toBe(direct);
		expect(
			fingerprintAlchemyRedacted(
				Redacted.make(TOKEN, { label: "other" }),
				captured,
				["p:token"],
			),
		).not.toBe(direct);
		const restricted = {
			...config,
			fingerprint: {
				...fingerprint(),
				verify: (claim: {
					domain: string;
					resourceId: string;
					resourceType: string;
				}) =>
					claim.domain === "prior-state" &&
					claim.resourceId === "store" &&
					claim.resourceType === "Spec.Store",
			},
		};
		expect(hashAlchemyPriorState(value, restricted)).toBe(first);
		expect(() =>
			hashAlchemyPriorState(value, { ...restricted, resourceId: "other" }),
		).toThrow("PLAN_SECRET_UNVERIFIED");
	});

	it("detects secret replacement, label mutation and wipe during reinspection", () => {
		const f = fixture();
		const first = inspectAlchemyPlan(f.plan as never, f.target, f.guard).digest;
		expect(reinspectAlchemyPlan(f.plan as never, f.target, f.guard)).toBe(
			first,
		);
		expect(
			inspectAlchemyPlan(f.plan as never, f.target, {
				...f.guard,
				secretFingerprint: {
					...fingerprint(),
					key: createSecretKey(Buffer.alloc(32, 24)),
				},
			}).digest,
		).not.toBe(first);
		expect(
			inspectAlchemyPlan(f.plan as never, f.target, {
				...f.guard,
				secretFingerprint: { ...fingerprint(), epoch: "host-epoch-2" },
			}).digest,
		).not.toBe(first);
		Object.assign(f.node.props, { token: Redacted.make("changed") });
		expect(reinspectAlchemyPlan(f.plan as never, f.target, f.guard)).not.toBe(
			first,
		);
		Redacted.wipeUnsafe(f.redacted);
		expect(() =>
			reinspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("PLAN_UNINSPECTABLE");
		const g = fixture();
		expect(() =>
			inspectAlchemyPlan(g.plan as never, g.target, {
				...g.guard,
				verifyPlan: () => {
					Object.assign(g.node.props, {
						token: Redacted.make(TOKEN, { label: "changed" }),
					});
					return true;
				},
			}),
		).toThrow("PLAN_UNINSPECTABLE");
	});

	it("rejects forged, wiped, accessor-backed, oversized and unsupported wrappers without evaluating getters", () => {
		const config = prior();
		let reads = 0;
		const f = fixture();
		const accessorGuard = {
			...f.guard,
			get secretFingerprint(): NonNullable<
				AlchemyCompositeGuard["secretFingerprint"]
			> {
				reads++;
				throw new Error(TOKEN);
			},
		};
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, accessorGuard),
		).toThrow("PLAN_SECRET_UNVERIFIED");
		expect(reads).toBe(0);
		const fake = Object.create(Object.getPrototypeOf(Redacted.make(TOKEN)));
		Object.defineProperty(fake, "label", {
			enumerable: true,
			get() {
				reads++;
				throw new Error(TOKEN);
			},
		});
		expect(() => hashAlchemyPriorState({ token: fake }, config)).toThrow(
			"PLAN_UNINSPECTABLE",
		);
		expect(reads).toBe(0);
		const proxy = new Proxy(Redacted.make(TOKEN), {
			getPrototypeOf() {
				reads++;
				throw new Error(TOKEN);
			},
			ownKeys() {
				reads++;
				throw new Error(TOKEN);
			},
		});
		expect(() => hashAlchemyPriorState({ token: proxy }, config)).toThrow(
			"PLAN_UNINSPECTABLE",
		);
		expect(reads).toBe(0);
		const wiped = Redacted.make(TOKEN);
		Redacted.wipeUnsafe(wiped);
		expect(() => hashAlchemyPriorState({ token: wiped }, config)).toThrow(
			"PLAN_UNINSPECTABLE",
		);
		expect(() =>
			hashAlchemyPriorState({ token: Redacted.make("x".repeat(4097)) }, config),
		).toThrow("PLAN_UNINSPECTABLE");
		expect(() =>
			hashAlchemyPriorState(
				{ token: Redacted.make({ password: TOKEN }) },
				config,
			),
		).toThrow("PLAN_UNINSPECTABLE");
		expect(() =>
			hashAlchemyPriorState(
				{ token: Redacted.make(TOKEN) },
				{
					...config,
					fingerprint: {
						...fingerprint(),
						key: createSecretKey(Buffer.alloc(8)),
					},
				},
			),
		).toThrow("PLAN_SECRET_UNVERIFIED");
	});

	it("sanitizes a real-plan proxy trap after trusted sandbox verification", () => {
		const f = fixture();
		let traps = 0;
		let verified = false;
		const proxy = new Proxy(f.redacted, {
			has() {
				traps++;
				throw new Error(TOKEN);
			},
		});
		Object.assign(f.node.props, { token: proxy });
		const guard = {
			...f.guard,
			verifyEnvironment: () => {
				verified = true;
				return true;
			},
		};
		verifyCompositeEnvironment(guard, f.target, "plan", "deploy");
		try {
			inspectAlchemyPlan(f.plan as never, f.target, guard);
			throw new Error("proxy unexpectedly passed");
		} catch (error) {
			expect(String(error)).toContain("PLAN_UNINSPECTABLE");
			expect(String(error)).not.toContain(TOKEN);
		}
		expect(verified).toBe(true);
		// Alchemy's genuine Output values are proxies, so recognizing them needs
		// a trap. The host's pre-plan sandbox must fence this code independently.
		expect(traps).toBeGreaterThan(0);
	});

	it("sanitizes output get traps and rejects proxied output expressions before reflection", () => {
		const f = fixture();
		const bad = new Proxy(f.redacted, {
			has: () => true,
			get() {
				throw new AlchemyIacError("ATTACKER", TOKEN);
			},
		});
		Object.assign(f.node.props, { token: bad });
		try {
			inspectAlchemyPlan(f.plan as never, f.target, f.guard);
			throw new Error("proxy unexpectedly passed");
		} catch (error) {
			expect(String(error)).toContain("PLAN_UNINSPECTABLE");
			expect(String(error)).not.toContain(TOKEN);
		}
		let traps = 0;
		const expression = new Proxy(
			{},
			{
				getPrototypeOf() {
					traps++;
					throw new Error(TOKEN);
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error(TOKEN);
				},
			},
		);
		const fakeOutput = new Proxy(
			{},
			{ has: () => true, get: () => expression },
		);
		Object.assign(f.node.props, { token: fakeOutput });
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("PLAN_UNINSPECTABLE");
		expect(traps).toBe(0);
	});

	it("demonstrates that Alchemy state encoding contains the secret and drops labels", () => {
		const original = { token: Redacted.make(TOKEN, { label: "diagnostic" }) };
		const encoded = encodeState(original);
		expect(JSON.stringify(encoded)).toContain(TOKEN);
		const revived = JSON.parse(JSON.stringify(encoded), reviveState) as {
			token: Redacted.Redacted<string>;
		};
		expect(Redacted.value(revived.token)).toBe(TOKEN);
		expect(hashAlchemyPriorState(revived, prior())).not.toBe(
			hashAlchemyPriorState(original, prior()),
		);
		expect(hashAlchemyPriorState(revived, prior())).toBe(
			hashAlchemyPriorState({ token: Redacted.make(TOKEN) }, prior()),
		);
	});

	it("authenticates and revalidates each prior-state resource without callbacks during final reinspection", () => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance",
			status: "created",
			downstream: [],
			bindings: [],
			props: { token: Redacted.make(TOKEN) },
			attr: { id: "physical" },
		};
		Object.assign(f.node, { action: "update", state });
		Object.assign(f.plan.resources[0] ?? {}, { action: "update" });
		const deny = {
			...f.guard,
			secretFingerprint: {
				...fingerprint(),
				verify: (claim: { domain: string }) => claim.domain === "plan",
			},
		};
		expect(() => inspectAlchemyPlan(f.plan as never, f.target, deny)).toThrow(
			"PLAN_SECRET_UNVERIFIED",
		);
		let allowed = true;
		let calls = 0;
		const guard = {
			...f.guard,
			secretFingerprint: {
				...fingerprint(),
				verify: (claim: {
					domain: string;
					resourceId: string;
					resourceType: string;
				}) => {
					calls++;
					return (
						claim.domain === "plan" ||
						(allowed &&
							claim.domain === "prior-state" &&
							claim.resourceId === "store" &&
							claim.resourceType === "Spec.Store")
					);
				},
			},
		};
		const inspected = inspectAlchemyPlan(f.plan as never, f.target, guard);
		expect(inspected.revalidateSources()).toBe(true);
		allowed = false;
		expect(inspected.revalidateSources()).toBe(false);
		const before = calls;
		expect(reinspectAlchemyPlan(f.plan as never, f.target, guard)).toBe(
			inspected.digest,
		);
		expect(calls).toBe(before);
	});

	it("requires a separate authenticated deletion-properties scope", () => {
		const f = fixture();
		const state = {
			fqn: "store",
			resourceType: "Spec.Store",
			logicalId: "store",
			instanceId: "instance",
			status: "created",
			downstream: [],
			bindings: [],
			props: { token: Redacted.make(TOKEN) },
			attr: { id: "physical" },
		};
		Object.assign(f.node, { action: "delete", state });
		Object.assign(f.plan.resources[0] ?? {}, { action: "delete" });
		Object.assign(f.plan.native, {
			resources: {},
			deletions: { store: f.node },
			destroy: true,
		});
		const requirement = {
			resourceId: "store",
			resourceType: "Spec.Store",
			bindleName: "app",
			applicationName: "store",
			sourceKind: "test",
			sourcePath: "/source/store",
		};
		registerAlchemySource(f.node.resource, {
			claim: {
				...requirement,
				sourceDigest: f.target.sourceDigest,
				environmentDigest: f.guard.environmentDigest,
				proofRef: f.guard.proofRef,
			},
			verify: () => true,
		});
		const guard = {
			...f.guard,
			sourceRequirements: [requirement],
			secretFingerprint: {
				...fingerprint(),
				verify: (claim: { domain: string }) =>
					claim.domain !== "deletion-properties",
			},
		};
		expect(() => inspectAlchemyPlan(f.plan as never, f.target, guard)).toThrow(
			"PLAN_SECRET_UNVERIFIED",
		);
	});
});
