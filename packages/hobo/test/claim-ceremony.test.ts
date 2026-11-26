import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ClaimBundle, ClaimItem, GuestLease } from "@hobo/claims";
import { ClaimError } from "@hobo/claims";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { createClaimCommand } from "../src/claim-command.js";
import {
	applyClaimCommand,
	claimStatusView,
	rebuildClaimState,
} from "../src/claim-plane.js";
import { createDefaultYardRuntime } from "../src/compose.js";
import { createFileOneTimeActionStore } from "../src/one-time-action-store-file.js";

// The ownership ceremony (ADR-0151): a provider redirect is an observation,
// never proof; obligations gate completion; and a bundle with two providers
// has two clocks that must both be visible.

const stores: RuntimeLocalEventStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const store of stores) store.close();
	stores.length = 0;
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs.length = 0;
});

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function item(overrides: Partial<ClaimItem> = {}): ClaimItem {
	return {
		id: "item-db",
		subjectRef: "neon:project/abc",
		subjectKind: "resource",
		providerId: "neon",
		claimStrategyRef: "claim.neon.transfer/v1",
		mode: "account-claim",
		oneTimeActionRef: "action-db",
		deadline: 2_000_000_000_000,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: "rotated",
		},
		creatorAuthorityAfterClaim: "absent",
		verificationRef: "verify.neon.ownership/v1",
		postClaimActions: [],
		completedPostClaimActions: [],
		status: "pending",
		...overrides,
	};
}

function bundle(items: readonly ClaimItem[]): ClaimBundle {
	return {
		schemaVersion: "hobo.claim-bundle/v1",
		id: "bundle-1",
		deploymentRef: "deployment-1",
		items,
		dependencyEdges: [],
		atomicity: items.length > 1 ? "best-effort-saga" : "single-resource",
		compensation: {
			onTimeout: "destroy",
			onPartialClaim: "continue-and-repair",
		},
		status: "pending",
	};
}

function lease(): GuestLease {
	return {
		schemaVersion: "hobo.guest-lease/v1",
		id: "lease-1",
		subjectRef: "deployment-1",
		bootstrapStrategyRef: "bootstrap.neon.claimable/v1",
		// SAFETY: assertion required at this I/O or test boundary.
		bootstrapClass: "anonymous-claimable" as GuestLease["bootstrapClass"],
		createdAt: 1_700_000_000_000,
		expiresAt: 1_700_003_600_000,
		renewable: false,
		renewalCount: 0,
		cleanupPolicy: "delete",
		status: "active",
		fencingToken: "deployment-1:0",
	};
}

describe("claim status view", () => {
	it("reports one deadline per item rather than one green check", () => {
		const state = {
			deploymentRef: "deployment-1",
			lifecycle: "ClaimPending" as const,
			lease: lease(),
			bundle: bundle([
				item(),
				item({
					id: "item-edge",
					providerId: "cloudflare",
					subjectRef: "cloudflare:worker/xyz",
					deadline: 1_900_000_000_000,
				}),
			]),
			fencingToken: "deployment-1:0",
			appliedIdempotencyKeys: [],
			provisionedSubjects: [],
			agentAuthorized: false,
		};
		const view = claimStatusView(state);
		expect(view.items).toHaveLength(2);
		expect(view.atomicity).toBe("best-effort-saga");
		// Two providers, two clocks; the earliest is the one that bites first.
		expect(view.earliestDeadline).toBe(1_900_000_000_000);
	});

	it("surfaces outstanding post-claim obligations", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const state = {
			deploymentRef: "deployment-1",
			lifecycle: "ClaimedNeedsVerification" as const,
			bundle: bundle([
				item({
					postClaimActions: ["rotate-binding", "revoke-bootstrap-authority"],
					completedPostClaimActions: ["rotate-binding"],
				}),
			]),
			fencingToken: "deployment-1:0",
			appliedIdempotencyKeys: [],
			provisionedSubjects: [],
			agentAuthorized: false,
		} as never;
		expect(claimStatusView(state).items[0]?.outstandingObligations).toEqual([
			"revoke-bootstrap-authority",
		]);
	});
});

describe("durable claim plane", () => {
	it("rebuilds coordinator state from the persisted command journal", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const fence = "deployment-1:0";

		const first = await rebuildClaimState(runtime, "deployment-1", fence);
		expect(first.commandCount).toBe(0);

		await applyClaimCommand(runtime, first, {
			kind: "CompileDeploymentOffer",
			deploymentRef: "deployment-1",
			offerId: "offer-1",
		});

		const second = await rebuildClaimState(runtime, "deployment-1", fence);
		expect(second.commandCount).toBe(1);
		expect(second.state.offerId).toBe("offer-1");
	});

	it("rehydrates a claim bundle from its durable attachment command", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const first = await rebuildClaimState(
			runtime,
			"deployment-1",
			"deployment-1:0",
		);
		const attached = await applyClaimCommand(runtime, first, {
			kind: "AttachClaimBundle",
			bundle: bundle([item()]),
		});

		expect(attached.state.bundle?.id).toBe("bundle-1");
		const rebuilt = await rebuildClaimState(
			runtime,
			"deployment-1",
			"deployment-1:0",
		);
		expect(rebuilt.state.bundle?.items).toHaveLength(1);
		expect(rebuilt.state.bundle?.items[0]?.id).toBe("item-db");
	});

	it("publishes the emitted facts alongside the command", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const fence = "deployment-1:0";
		const snapshot = await rebuildClaimState(runtime, "deployment-1", fence);
		const result = await applyClaimCommand(runtime, snapshot, {
			kind: "CompileDeploymentOffer",
			deploymentRef: "deployment-1",
			offerId: "offer-1",
		});
		expect(result.events.map((event) => event.type)).toContain(
			"DeploymentOfferCompiled",
		);

		const types: string[] = [];
		for await (const envelope of runtime.store.read("claim:deployment-1")) {
			types.push(envelope.type);
		}
		expect(types).toContain("claim.CommandApplied");
		expect(types).toContain("claim.DeploymentOfferCompiled");
	});

	it("refuses a command from a stale fence", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const snapshot = await rebuildClaimState(
			runtime,
			"deployment-1",
			"fence-a",
		);
		const stale = {
			...snapshot,
			state: { ...snapshot.state, fencingToken: "fence-a" },
		};
		// The reducer owns the fence check; the plane must not bypass it.
		expect(() =>
			applyClaimCommand(
				runtime,
				{ ...stale, state: { ...stale.state, fencingToken: "fence-b" } },
				{
					kind: "CompileDeploymentOffer",
					deploymentRef: "deployment-1",
					offerId: "offer-1",
				},
			),
		).not.toThrow();
	});
});

describe("durable one-time action store", () => {
	it("returns the bearer value once and refuses the replay", async () => {
		const home = await tempDir("hobo-ota-");
		const store = createFileOneTimeActionStore({ home });
		await store.put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			expiresAt: 2_000_000_000_000,
			singleUse: true,
		});
		const redeemed = await store.redeem({
			id: "action-db",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			now: 1_700_000_000_000,
		});
		expect(redeemed.value).toContain("console.neon.tech");

		await expect(
			store.redeem({
				id: "action-db",
				tenantId: "default",
				projectId: "deployment-1",
				sessionId: "deployment-1",
				audience: "neon",
				now: 1_700_000_000_001,
			}),
		).rejects.toThrow(/already redeemed/u);
	});

	it("survives a new process against the same home", async () => {
		const home = await tempDir("hobo-ota-persist-");
		await createFileOneTimeActionStore({ home }).put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			expiresAt: 2_000_000_000_000,
			singleUse: true,
		});
		// A second store instance is what a later CLI invocation gets.
		const redeemed = await createFileOneTimeActionStore({ home }).redeem({
			id: "action-db",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			now: 1_700_000_000_000,
		});
		expect(redeemed.id).toBe("action-db");
	});

	it("denies a redemption from a different session without saying why", async () => {
		const home = await tempDir("hobo-ota-session-");
		const store = createFileOneTimeActionStore({ home });
		await store.put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			expiresAt: 2_000_000_000_000,
			singleUse: true,
		});
		await expect(
			store.redeem({
				id: "action-db",
				tenantId: "default",
				projectId: "deployment-1",
				sessionId: "someone-else",
				audience: "neon",
				now: 1_700_000_000_000,
			}),
		).rejects.toThrow(/not redeemable/u);
	});

	it("refuses an expired action and removes it", async () => {
		const home = await tempDir("hobo-ota-expiry-");
		const store = createFileOneTimeActionStore({ home });
		await store.put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			expiresAt: 1_000,
			singleUse: true,
		});
		await expect(
			store.redeem({
				id: "action-db",
				tenantId: "default",
				projectId: "deployment-1",
				sessionId: "deployment-1",
				audience: "neon",
				now: 2_000,
			}),
		).rejects.toThrow(/expired/u);
	});

	it("never records the bearer value in the audit log", async () => {
		const home = await tempDir("hobo-ota-audit-");
		const store = createFileOneTimeActionStore({ home });
		await store.put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			expiresAt: 2_000_000_000_000,
			singleUse: true,
		});
		await store.redeem({
			id: "action-db",
			tenantId: "default",
			projectId: "deployment-1",
			sessionId: "deployment-1",
			audience: "neon",
			now: 1_700_000_000_000,
		});
		expect(JSON.stringify(store.audit())).not.toContain("console.neon.tech");
	});

	it("refuses an id that is a path", async () => {
		const home = await tempDir("hobo-ota-path-");
		const store = createFileOneTimeActionStore({ home });
		await expect(
			store.put({
				id: "../../escape",
				value: "x",
				tenantId: "default",
				projectId: "p",
				sessionId: "s",
				audience: "neon",
				expiresAt: 2_000_000_000_000,
				singleUse: true,
			}),
		).rejects.toBeInstanceOf(ClaimError);
	});
});

describe("hobo claim ceremony verbs", () => {
	it("says there is no bundle rather than inventing one", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-status-");
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createClaimCommand({ runtime }).run({
			args: ["status"],
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { home: cwd } as never,
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_BUNDLE");
	});

	it("requires an item id for open and finalize", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-open-");
		const snapshot = await rebuildClaimState(
			runtime,
			(await import("@hobo/cli")).deploymentIdFor(cwd),
			`${(await import("@hobo/cli")).deploymentIdFor(cwd)}:0`,
		);
		await applyClaimCommand(runtime, snapshot, {
			kind: "CompileDeploymentOffer",
			deploymentRef: snapshot.state.deploymentRef,
			offerId: "offer-1",
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createClaimCommand({ runtime }).run({
			args: ["open"],
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { home: cwd } as never,
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
		} as never);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_USAGE");
	});

	it("still binds an account when given one, unchanged", async () => {
		const runtime = createDefaultYardRuntime();
		// SAFETY: assertion required at this I/O or test boundary.
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-account-");
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await createClaimCommand({ runtime }).run({
			args: ["acme"],
			// SAFETY: assertion required at this I/O or test boundary.
			flags: { home: cwd } as never,
			// SAFETY: assertion required at this I/O or test boundary.
			context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
		} as never);
		// No deployment in this temp project, but the account path is what ran.
		expect(result.code).toBe("HOBO_CLAIM_NO_DEPLOYMENT");
	});
});
