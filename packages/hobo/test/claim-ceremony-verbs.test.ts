/**
 * `hobo claim status|open|finalize` — the ownership ceremony verbs themselves.
 *
 * The sibling `claim-ceremony.test.ts` covers the pieces these verbs sit on
 * (the status view, the durable plane, the one-time action store). This file
 * covers the orchestration in `runClaimCeremony`, where the load-bearing claim
 * of ADR-0151 lives: **a provider redirect is an observation, never proof**.
 *
 * Three properties carry most of the risk, and each has a way of quietly
 * inverting itself:
 *
 * 1. `open` hands the operator a bearer URL and records nothing but an
 *    observation. If it ever marked the item claimed, anyone who could make the
 *    CLI open a URL would own the resource.
 * 2. `finalize` refuses outright when no independent verifier is wired. The
 *    tempting failure is to treat "no verifier configured" as "nothing
 *    objected" and pass — which is the same bug with better manners.
 * 3. Obligations gate completion. Ownership verifying is not the end of the
 *    ceremony; a rotation or revocation still outstanding means the item is not
 *    complete, and the result says so with the specific actions named.
 *
 * The refusal paths are tested for their *codes*, not just their falsity: the
 * composed CLI and the MCP surface both branch on `code`, so a refusal that
 * degraded to a generic failure would still look "handled" while losing the
 * caller's ability to tell a missing bundle from an expired action.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ClaimBundle, ClaimItem } from "@hobo/claims";
import { deploymentIdFor } from "@hobo/cli";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import { runClaimCeremony } from "../src/claim-ceremony.js";
import { applyClaimCommand, rebuildClaimState } from "../src/claim-plane.js";
import { createDefaultYardRuntime } from "../src/compose.js";
import { createFileOneTimeActionStore } from "../src/one-time-action-store-file.js";

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

const FAR_FUTURE = 2_000_000_000_000;
const NOW = 1_700_000_000_000;

function item(overrides: Partial<ClaimItem> = {}): ClaimItem {
	return {
		id: "item-db",
		subjectRef: "neon:project/abc",
		subjectKind: "resource",
		providerId: "neon",
		claimStrategyRef: "claim.neon.transfer/v1",
		mode: "account-claim",
		oneTimeActionRef: "action-db",
		deadline: FAR_FUTURE,
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

function bundle(
	deploymentRef: string,
	items: readonly ClaimItem[],
): ClaimBundle {
	return {
		schemaVersion: "hobo.claim-bundle/v1",
		id: "bundle-1",
		deploymentRef,
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

/**
 * A ceremony call against a fresh runtime and an isolated home, with the
 * bundle injected the way the composed binary injects it after `up`.
 */
async function ceremony(
	subcommand: "status" | "open" | "finalize",
	args: readonly string[],
	options: {
		readonly items?: readonly ClaimItem[];
		/** Omit to run with no bundle at all — the "nothing to claim" path. */
		readonly withBundle?: boolean;
		readonly verifyOwnership?: (input: {
			readonly item: ClaimItem;
			readonly nowMs: number;
		}) => Promise<{ readonly verified: boolean; readonly evidenceRef: string }>;
		readonly now?: number;
		readonly env?: NodeJS.ProcessEnv;
		/** Seed the one-time action store so `open` has something to redeem. */
		readonly seedAction?: boolean;
	} = {},
) {
	const runtime = createDefaultYardRuntime();
	stores.push(runtime.store as RuntimeLocalEventStore);
	const cwd = await tempDir("hobo-claim-verb-");
	const deploymentRef = deploymentIdFor(cwd);
	const items = options.items ?? [item()];

	if (options.seedAction === true) {
		const env = options.env ?? {};
		for (const entry of items) {
			if (entry.oneTimeActionRef === undefined) continue;
			await createFileOneTimeActionStore({ home: cwd }).put({
				id: entry.oneTimeActionRef,
				value: "https://console.neon.tech/claim?token=redacted",
				tenantId: env.HOBO_TENANT ?? "default",
				projectId: env.HOBO_PROJECT ?? deploymentRef,
				sessionId: deploymentRef,
				audience: entry.providerId,
				expiresAt: FAR_FUTURE,
				singleUse: true,
			});
		}
	}

	const result = await runClaimCeremony({
		subcommand,
		args,
		flags: { home: cwd },
		context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
		deps: {
			runtime,
			env: options.env ?? {},
			now: () => options.now ?? NOW,
			...(options.withBundle === false
				? {}
				: { bundle: bundle(deploymentRef, items) }),
			...(options.verifyOwnership === undefined
				? {}
				: { verifyOwnership: options.verifyOwnership }),
		},
	});
	return { result: result as Record<string, unknown>, cwd, deploymentRef };
}

describe("the runtime requirement", () => {
	it("refuses without a Yard runtime rather than acting on nothing", async () => {
		// Every verb reads and writes the durable claim journal. With no runtime
		// there is no journal, and a "success" here would be a claim the operator
		// believes happened and that nothing recorded.
		const result = await runClaimCeremony({
			subcommand: "status",
			args: [],
			flags: {},
			context: { cwd: ".", identity: null, clients: {} } as never,
			deps: {},
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});

	it("says how to get one", async () => {
		const result = await runClaimCeremony({
			subcommand: "open",
			args: ["item-db"],
			flags: {},
			context: { cwd: ".", identity: null, clients: {} } as never,
			deps: {},
		});
		expect(String(result.message)).toContain("composed `hobo` binary");
	});

	it("names the subcommand that was refused", async () => {
		// The MCP surface reports this back to a caller that never saw the args.
		const result = await runClaimCeremony({
			subcommand: "finalize",
			args: ["item-db"],
			flags: {},
			context: { cwd: ".", identity: null, clients: {} } as never,
			deps: {},
		});
		expect((result.data as Record<string, unknown>).subcommand).toBe(
			"finalize",
		);
	});
});

describe("the bundle precondition", () => {
	it("reports no bundle rather than an empty ceremony", async () => {
		const { result } = await ceremony("status", [], { withBundle: false });
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_BUNDLE");
	});

	it("tells the operator which deployment it looked for", async () => {
		// Two checkouts of the same project are two deployments; without the ref
		// an operator cannot tell "no bundle" from "wrong directory".
		const { result, deploymentRef } = await ceremony("status", [], {
			withBundle: false,
		});
		expect((result.data as Record<string, unknown>).deploymentRef).toBe(
			deploymentRef,
		);
	});

	it("points at the offer flow that creates one", async () => {
		const { result } = await ceremony("status", [], { withBundle: false });
		expect(String((result.remediation as string[])[0])).toContain("hobo offer");
	});

	it("attaches an injected bundle so the first status call works", async () => {
		// Without this, `hobo claim status` immediately after `up` would say there
		// is nothing to claim while resources sit unclaimed.
		const { result } = await ceremony("status", []);
		expect(result.ok).toBe(true);
	});
});

describe("item id requirement", () => {
	it.each([
		"open",
		"finalize",
	] as const)("requires an item id for %s", async (subcommand) => {
		// "Claim whatever is next" is precisely the implicit selection an
		// ownership ceremony exists to prevent.
		const { result } = await ceremony(subcommand, []);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_USAGE");
	});

	it("shows the usage line with the item placeholder", async () => {
		const { result } = await ceremony("open", []);
		expect(String(result.message)).toContain("<item-id>");
	});

	it("points at status to list the ids", async () => {
		// A refusal that does not say where the ids come from strands the operator.
		const { result } = await ceremony("finalize", []);
		expect(String((result.remediation as string[])[0])).toContain(
			"hobo claim status",
		);
	});

	it("does not require an item id for status", async () => {
		const { result } = await ceremony("status", []);
		expect(result.code).toBe("HOBO_CLAIM_STATUS");
	});
});

describe("status", () => {
	it("reports outstanding items while any remain", async () => {
		const { result } = await ceremony("status", []);
		expect(result.status).toBe("outstanding");
	});

	it("counts the outstanding items against the total", async () => {
		// "1 of 2" is the shape an operator uses to know the ceremony is partial.
		const { result } = await ceremony("status", [], {
			items: [item(), item({ id: "item-edge", providerId: "cloudflare" })],
		});
		expect(String(result.message)).toMatch(/2 of 2 item\(s\) outstanding/u);
	});

	it("names the earliest deadline in the message", async () => {
		// Two providers means two clocks; the earliest is the one that bites.
		const { result } = await ceremony("status", []);
		expect(String(result.message)).toContain(String(FAR_FUTURE));
	});

	it("omits the deadline clause when nothing has one", async () => {
		// A dangling "earliest deadline " with nothing after it reads as a bug.
		const { result } = await ceremony("status", [], {
			items: [item({ deadline: undefined })],
		});
		expect(String(result.message)).not.toContain("earliest deadline");
	});

	it("reports completion once every item is completed", async () => {
		const { result } = await ceremony("status", [], {
			items: [item({ status: "completed" })],
		});
		expect(result.status).toBe("complete");
		expect(String(result.message)).toContain("is complete");
	});

	it("names the bundle it is reporting on", async () => {
		const { result } = await ceremony("status", [], {
			items: [item({ status: "completed" })],
		});
		expect(String(result.message)).toContain("bundle-1");
	});

	it("includes the per-item view in the data", async () => {
		// `--json` consumers read the items, not the sentence.
		const { result } = await ceremony("status", []);
		expect((result.data as { items: unknown[] }).items).toHaveLength(1);
	});

	it("succeeds rather than refusing when work remains", async () => {
		// Outstanding work is the normal state of a ceremony in progress, not an
		// error; a non-zero exit here would break any script that polls status.
		const { result } = await ceremony("status", []);
		expect(result.ok).toBe(true);
	});
});

describe("open", () => {
	it("returns the bearer action url for the operator to visit", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
		});
		expect(result.ok).toBe(true);
		expect(
			String((result.data as Record<string, unknown>).actionUrl),
		).toContain("console.neon.tech");
	});

	it("tells the operator to run finalize afterwards", async () => {
		// Opening is half the ceremony; an operator who stops here leaves the
		// resource unverified and the obligations undischarged.
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
		});
		expect(String(result.message)).toContain("hobo claim finalize item-db");
	});

	it("does not mark the item claimed", async () => {
		// The whole point of ADR-0151: a redirect says a human visited a page, not
		// that ownership moved. Anything stronger than `pending` here would let a
		// mere page-visit transfer a resource.
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
		});
		expect(result.status).toBe("opened");
		expect(JSON.stringify(result.data)).not.toContain("claimed");
	});

	it("reports the lifecycle the observation left behind", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
		});
		expect((result.data as Record<string, unknown>).lifecycle).toBeDefined();
	});

	it("carries the deadline through so the operator sees their clock", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
		});
		expect((result.data as Record<string, unknown>).deadline).toBe(FAR_FUTURE);
	});

	it("reports a null deadline rather than omitting the field", async () => {
		// An absent key and an absent deadline are different facts; a `--json`
		// consumer that saw neither could not tell them apart.
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ deadline: undefined })],
			seedAction: true,
		});
		expect((result.data as Record<string, unknown>).deadline).toBeNull();
	});

	it("refuses an item with no pending action", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ oneTimeActionRef: undefined })],
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_NO_ACTION");
	});

	it("says the item is already complete when that is why", async () => {
		// Same refusal, two very different operator situations: nothing to do
		// because it is done, versus nothing to do because something is wrong.
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ oneTimeActionRef: undefined, status: "completed" })],
		});
		expect(String((result.remediation as string[])[0])).toContain(
			"already complete",
		);
	});

	it("points at status when the item is merely stuck", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ oneTimeActionRef: undefined, status: "pending" })],
		});
		expect(String((result.remediation as string[])[0])).toContain(
			"hobo claim status",
		);
	});

	it("refuses an expired action", async () => {
		// Redeeming past the deadline would hand out a URL the provider has
		// already invalidated, and the failure would surface as a confusing
		// provider-side error instead of an honest local one.
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ deadline: NOW - 1 })],
			seedAction: true,
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("CLAIM_EXPIRED");
	});

	it("treats a deadline exactly at now as expired", async () => {
		// The boundary is inclusive; a deadline reached is a deadline passed.
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ deadline: NOW })],
			seedAction: true,
			now: NOW,
		});
		expect(result.code).toBe("CLAIM_EXPIRED");
	});

	it("names the expiry instant it refused on", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ deadline: NOW - 1 })],
			seedAction: true,
		});
		expect(String(result.message)).toContain(String(NOW - 1));
	});

	it("offers redeploy as the way out of expiry", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			items: [item({ deadline: NOW - 1 })],
			seedAction: true,
		});
		expect(String((result.remediation as string[])[0])).toContain("Redeploy");
	});

	it("reports a claim failure for an item that does not exist", async () => {
		// Not a crash, and not a silently-invented item.
		const { result } = await ceremony("open", ["item-nope"], {
			seedAction: true,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("claim_failed");
	});

	it("echoes the unknown item id back", async () => {
		const { result } = await ceremony("open", ["item-nope"], {
			seedAction: true,
		});
		expect((result.data as Record<string, unknown>).itemId).toBe("item-nope");
	});

	it("refuses the replay of an already-redeemed action", async () => {
		// Single-use is the property that keeps a leaked shell history from being
		// a second chance at the resource.
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-replay-");
		const deploymentRef = deploymentIdFor(cwd);
		await createFileOneTimeActionStore({ home: cwd }).put({
			id: "action-db",
			value: "https://console.neon.tech/claim?token=redacted",
			tenantId: "default",
			projectId: deploymentRef,
			sessionId: deploymentRef,
			audience: "neon",
			expiresAt: FAR_FUTURE,
			singleUse: true,
		});
		const call = () =>
			runClaimCeremony({
				subcommand: "open",
				args: ["item-db"],
				flags: { home: cwd },
				context: {
					cwd,
					projectDir: cwd,
					identity: null,
					clients: {},
				} as never,
				deps: {
					runtime,
					env: {},
					now: () => NOW,
					bundle: bundle(deploymentRef, [item()]),
				},
			});
		expect((await call()).ok).toBe(true);
		expect((await call()).ok).toBe(false);
	});

	it("scopes the redemption to the configured tenant", async () => {
		// A tenant mismatch must not redeem; otherwise the store's tenancy check
		// is decorative and one tenant's action opens another's resource.
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
			env: { HOBO_TENANT: "acme" },
		});
		expect(result.ok).toBe(true);
	});

	it("scopes the redemption to the configured project", async () => {
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
			env: { HOBO_PROJECT: "proj-7" },
		});
		expect(result.ok).toBe(true);
	});
});

describe("finalize", () => {
	const verified = async () => ({
		verified: true,
		evidenceRef: "evidence://neon/ownership/1",
	});

	it("refuses when no independent verifier is configured", async () => {
		// The dangerous alternative is to read "nothing objected" as "verified".
		const { result } = await ceremony("finalize", ["item-db"]);
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_VERIFIER_UNAVAILABLE");
	});

	it("says the verifier must be independent", async () => {
		// Self-attestation by the thing being claimed is not verification.
		const { result } = await ceremony("finalize", ["item-db"]);
		expect(String(result.message)).toContain("independent provider verifier");
	});

	it("finalizes an item whose ownership verifies", async () => {
		const { result } = await ceremony("finalize", ["item-db"], {
			verifyOwnership: verified,
		});
		expect(result.ok).toBe(true);
		expect(result.code).toBe("HOBO_CLAIM_FINALIZED");
	});

	it("reports how many items are still outstanding after one finalizes", async () => {
		// The operator needs to know the ceremony is not over.
		const { result } = await ceremony("finalize", ["item-db"], {
			items: [item(), item({ id: "item-edge", providerId: "cloudflare" })],
			verifyOwnership: verified,
		});
		expect(String(result.message)).toContain("1 item(s) still outstanding");
	});

	it("holds the item open while post-claim obligations remain", async () => {
		// Ownership moving is not the end: a binding still to rotate or a
		// bootstrap authority still to revoke means the creator can still act.
		const { result } = await ceremony("finalize", ["item-db"], {
			items: [
				item({
					postClaimActions: ["rotate-binding", "revoke-bootstrap-authority"],
				}),
			],
			verifyOwnership: verified,
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_CLAIM_OBLIGATIONS");
	});

	it("names each outstanding obligation", async () => {
		// "2 obligations remain" without naming them is not actionable.
		const { result } = await ceremony("finalize", ["item-db"], {
			items: [
				item({
					postClaimActions: ["rotate-binding", "revoke-bootstrap-authority"],
				}),
			],
			verifyOwnership: verified,
		});
		expect(
			(result.data as Record<string, unknown>).outstandingObligations,
		).toEqual(["rotate-binding", "revoke-bootstrap-authority"]);
	});

	it("turns each obligation into a remediation line", async () => {
		const { result } = await ceremony("finalize", ["item-db"], {
			items: [item({ postClaimActions: ["rotate-binding"] })],
			verifyOwnership: verified,
		});
		expect((result.remediation as string[])[0]).toContain("rotate-binding");
	});

	it("counts already-completed obligations as discharged", async () => {
		// Otherwise finalize could never succeed for an item that had any.
		const { result } = await ceremony("finalize", ["item-db"], {
			items: [
				item({
					postClaimActions: ["rotate-binding"],
					completedPostClaimActions: ["rotate-binding"],
				}),
			],
			verifyOwnership: verified,
		});
		expect(result.ok).toBe(true);
	});

	it("passes the item and the clock to the verifier", async () => {
		// A verifier that cannot see the item cannot check the right subject, and
		// one that reads the wall clock instead of the ceremony's would disagree
		// with every deadline the rest of the command enforces.
		let seen: { item: ClaimItem; nowMs: number } | undefined;
		await ceremony("finalize", ["item-db"], {
			verifyOwnership: async (input) => {
				seen = { item: input.item, nowMs: input.nowMs };
				return { verified: true, evidenceRef: "evidence://x" };
			},
			now: 1_234,
		});
		expect(seen?.item.id).toBe("item-db");
		expect(seen?.nowMs).toBe(1_234);
	});

	it("does not finalize when the verifier says ownership did not move", async () => {
		const { result } = await ceremony("finalize", ["item-db"], {
			verifyOwnership: async () => ({
				verified: false,
				evidenceRef: "evidence://neon/denied",
			}),
		});
		expect(result.ok).toBe(false);
	});

	it("reports a claim failure for an item that does not exist", async () => {
		const { result } = await ceremony("finalize", ["item-nope"], {
			verifyOwnership: verified,
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe("claim_failed");
	});

	it("points at status after a claim failure", async () => {
		const { result } = await ceremony("finalize", ["item-nope"], {
			verifyOwnership: verified,
		});
		expect(String((result.remediation as string[])[0])).toContain(
			"hobo claim status",
		);
	});

	it("includes the full status view in the finalized result", async () => {
		// The caller gets the whole ceremony's state back, not just the one item,
		// so a scripted loop can decide whether to keep going.
		const { result } = await ceremony("finalize", ["item-db"], {
			verifyOwnership: verified,
		});
		expect((result.data as { items: unknown[] }).items).toHaveLength(1);
	});
});

describe("the sequence contract between two commands in one invocation", () => {
	// `finalize` applies two commands back to back — VerifyOwnership, then
	// CompleteClaimItem — without re-reading the stream in between. Each apply
	// writes one command envelope *plus one per emitted fact*, so the second
	// append's `expectedSeq` has to come from the first append's report rather
	// than from `previous + 1`. Guessing `+1` made the whole finalize happy path
	// die with an optimistic-concurrency conflict, which read like a concurrent
	// writer when it was really arithmetic.
	it("reports a seq that accounts for the emitted facts", async () => {
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const first = await rebuildClaimState(
			runtime,
			"deployment-seq",
			"deployment-seq:0",
		);
		const applied = await applyClaimCommand(runtime, first, {
			kind: "CompileDeploymentOffer",
			deploymentRef: "deployment-seq",
			offerId: "offer-1",
		});
		expect(applied.seq).toBe(first.seq + 1 + applied.events.length);
	});

	it("matches what a fresh rebuild of the same stream reports", async () => {
		// The reported seq is only useful if it is the same number the store
		// would hand back; anything else just moves the conflict one call later.
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const first = await rebuildClaimState(
			runtime,
			"deployment-seq2",
			"deployment-seq2:0",
		);
		const applied = await applyClaimCommand(runtime, first, {
			kind: "CompileDeploymentOffer",
			deploymentRef: "deployment-seq2",
			offerId: "offer-1",
		});
		const rebuilt = await rebuildClaimState(
			runtime,
			"deployment-seq2",
			"deployment-seq2:0",
		);
		expect(applied.seq).toBe(rebuilt.seq);
	});

	it("lets a second command follow the first without re-reading", async () => {
		// This is the shape `finalize` uses; before the fix it threw.
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const first = await rebuildClaimState(
			runtime,
			"deployment-seq3",
			"deployment-seq3:0",
		);
		const applied = await applyClaimCommand(runtime, first, {
			kind: "CompileDeploymentOffer",
			deploymentRef: "deployment-seq3",
			offerId: "offer-1",
		});
		await expect(
			applyClaimCommand(
				runtime,
				{ ...first, state: applied.state, seq: applied.seq },
				{
					kind: "AttachClaimBundle",
					bundle: bundle("deployment-seq3", [item()]),
				},
			),
		).resolves.toBeDefined();
	});
});

describe("home resolution", () => {
	it("uses the --home flag over the environment default", async () => {
		// The one-time action store lives under the home; reading the wrong one
		// means the action is "missing" even though it was just minted.
		const { result } = await ceremony("open", ["item-db"], {
			seedAction: true,
			env: { HOBO_HOME: "/nonexistent/elsewhere" },
		});
		expect(result.ok).toBe(true);
	});

	it("ignores an empty --home rather than treating it as a path", async () => {
		// An empty string resolves to the process cwd on most path APIs, which is
		// the repo — exactly where a test must never write.
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-home-");
		const result = await runClaimCeremony({
			subcommand: "status",
			args: [],
			flags: { home: "" },
			context: { cwd, projectDir: cwd, identity: null, clients: {} } as never,
			deps: {
				runtime,
				env: { HOBO_HOME: await tempDir("hobo-claim-home-env-") },
				now: () => NOW,
				bundle: bundle(deploymentIdFor(cwd), [item()]),
			},
		});
		expect(result.ok).toBe(true);
	});
});

describe("project directory resolution", () => {
	it("prefers the context's project directory", async () => {
		// The deployment ref is derived from it; picking the shell cwd instead
		// would address a different deployment than the one `up` created.
		const { result, deploymentRef } = await ceremony("status", [], {
			withBundle: false,
		});
		expect((result.data as Record<string, unknown>).deploymentRef).toBe(
			deploymentRef,
		);
	});

	it("falls back to the --cwd flag when the context has no project dir", async () => {
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const projectDir = await tempDir("hobo-claim-cwd-");
		const result = await runClaimCeremony({
			subcommand: "status",
			args: [],
			flags: { cwd: projectDir, home: projectDir },
			context: {
				cwd: "/somewhere/else",
				identity: null,
				clients: {},
			} as never,
			deps: { runtime, env: {}, now: () => NOW },
		});
		expect((result.data as Record<string, unknown>).deploymentRef).toBe(
			deploymentIdFor(projectDir),
		);
	});

	it("falls back to the shell cwd when neither is given", async () => {
		const runtime = createDefaultYardRuntime();
		stores.push(runtime.store as RuntimeLocalEventStore);
		const cwd = await tempDir("hobo-claim-shell-cwd-");
		const result = await runClaimCeremony({
			subcommand: "status",
			args: [],
			flags: { home: cwd },
			context: { cwd, identity: null, clients: {} } as never,
			deps: { runtime, env: {}, now: () => NOW },
		});
		expect((result.data as Record<string, unknown>).deploymentRef).toBe(
			deploymentIdFor(cwd),
		);
	});
});
