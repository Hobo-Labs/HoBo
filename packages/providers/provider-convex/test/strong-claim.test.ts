import { describe, expect, it } from "vitest";

import {
	applyStrongClaim,
	authorityCanAccessDestination,
	type BackendRef,
	type ConvexMigrationDriver,
	decideStrongClaim,
	initialStrongClaimState,
	parseAuthorityRef,
	runStrongClaim,
	type StrongClaimCommand,
	type StrongClaimState,
	type VerificationSummary,
	verificationFailures,
} from "../src/strong-claim.js";

const K0 = parseAuthorityRef("secretref://hobo/convex/b0/k0");
const K1 = parseAuthorityRef("secretref://hobo/convex/b1/k1");

const B0: BackendRef = {
	backendId: "b0-temporary",
	hostingFormId: "convex.local-accountless/v1",
	url: "http://127.0.0.1:3210",
	authorityRef: K0,
};

const B1: BackendRef = {
	backendId: "b1-owned",
	hostingFormId: "convex.selfhosted-oci/v1",
	url: "https://convex.example.hobo.test",
	authorityRef: K1,
};

const ALL_GREEN: VerificationSummary = {
	documentCountsMatch: true,
	sampledHashesMatch: true,
	filesMatch: true,
	indexesReady: true,
	httpActionsRouting: true,
	websocketHealthy: true,
	authConfigMatches: true,
	appHealthy: true,
};

function drive(
	commands: readonly StrongClaimCommand[],
	from: StrongClaimState = initialStrongClaimState("claim-1"),
): StrongClaimState {
	let state = from;
	for (const command of commands) {
		state = applyStrongClaim(state, command).state;
	}
	return state;
}

const START: StrongClaimCommand = {
	type: "StartClaim",
	source: B0,
	rollbackWindowMs: 60_000,
};
const PROVISION: StrongClaimCommand = {
	type: "ProvisionDestination",
	destination: B1,
};
const DEPLOY: StrongClaimCommand = {
	type: "DeployCodeAndConfig",
	configKeys: ["CONVEX_SITE_ORIGIN"],
};
const FENCE: StrongClaimCommand = {
	type: "QuiesceSource",
	fenceToken: "fence-7",
};
const EXPORT: StrongClaimCommand = {
	type: "ExportSource",
	artifactRef: "artifact://snapshot_1",
	documentCount: 42,
	fileCount: 3,
};
const IMPORT_OK: StrongClaimCommand = {
	type: "ImportIntoDestination",
	artifactRef: "artifact://snapshot_1",
	ok: true,
};
const VERIFY_OK: StrongClaimCommand = {
	type: "VerifyDestination",
	summary: ALL_GREEN,
};
const CUTOVER_OK: StrongClaimCommand = {
	type: "CutoverConnector",
	connectorId: "connector-app",
	ok: true,
};

const UP_TO_IMPORTED = [START, PROVISION, DEPLOY, FENCE, EXPORT, IMPORT_OK];
const UP_TO_VERIFIED = [...UP_TO_IMPORTED, VERIFY_OK];

function fakeDriver(
	overrides: Partial<ConvexMigrationDriver> = {},
): ConvexMigrationDriver {
	const base: ConvexMigrationDriver = {
		provisionDestination: async () => B1,
		deployCodeAndConfig: async () => ({ configKeys: ["CONVEX_SITE_ORIGIN"] }),
		quiesceSource: async () => ({ fenceToken: "fence-7" }),
		export: async () => ({
			artifactRef: "artifact://snapshot_1",
			documentCount: 42,
			fileCount: 3,
		}),
		import: async () => ({ ok: true }),
		verify: async () => ALL_GREEN,
		cutover: async () => ({ ok: true, connectorId: "connector-app" }),
		awaitRollbackWindow: async () => ({ rollback: false }),
		destroy: async () => ({ ok: true, destroyedBackendId: B0.backendId }),
	};
	return { ...base, ...overrides };
}

describe("strong claim: authority handling", () => {
	it("parses broker handles and refuses anything shaped like key material", () => {
		expect(parseAuthorityRef(" secretref://x/y ")).toBe("secretref://x/y");
		expect(() =>
			parseAuthorityRef("bold-hyena-681|01c2f4a9b7e3d5c09c"),
		).toThrow(/key material/u);
		expect(() =>
			parseAuthorityRef("prod:qualified-jaguar-123|eyJ2MTAwMDA9"),
		).toThrow(/key material/u);
		expect(() => parseAuthorityRef("   ")).toThrow(/non-empty/u);
	});

	it("treats every pre-claim authority as compromised", () => {
		const state = drive([START]);
		expect(state.compromisedAuthorityRefs).toEqual([K0]);
	});

	it("refuses a destination that reuses the pre-claim authority", () => {
		const state = drive([START]);
		const decision = decideStrongClaim(state, {
			type: "ProvisionDestination",
			destination: { ...B1, authorityRef: K0 },
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.rejection.code).toBe("reused-compromised-authority");
		}
	});

	it("refuses a destination that is the source backend under a new name", () => {
		const state = drive([START]);
		const decision = decideStrongClaim(state, {
			type: "ProvisionDestination",
			destination: { ...B1, backendId: B0.backendId },
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.rejection.code).toBe("destination-not-fresh");
		}
	});

	it("INVARIANT: the old K0 cannot access B1", () => {
		const state = drive([START, PROVISION]);
		expect(authorityCanAccessDestination(state, K0)).toBe(false);
		expect(authorityCanAccessDestination(state, K1)).toBe(true);
		expect(authorityCanAccessDestination(state, "secretref://other")).toBe(
			false,
		);
	});
});

describe("strong claim: ordering invariants", () => {
	it("refuses to export an unfenced source", () => {
		const state = drive([START, PROVISION, DEPLOY]);
		const decision = decideStrongClaim(state, EXPORT);
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.rejection.code).toBe("source-not-fenced");
		}
		expect(state.sourceWritable).toBe(true);
	});

	it("fences the source before the export is allowed", () => {
		const state = drive([START, PROVISION, DEPLOY, FENCE]);
		expect(state.sourceWritable).toBe(false);
		expect(decideStrongClaim(state, EXPORT).ok).toBe(true);
	});

	it("INVARIANT: cutover only after verification", () => {
		const imported = drive(UP_TO_IMPORTED);
		expect(imported.phase).toBe("imported");
		const decision = decideStrongClaim(imported, CUTOVER_OK);
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.rejection.code).toBe("cutover-before-verification");
		}

		const verified = drive(UP_TO_VERIFIED);
		expect(verified.phase).toBe("verified");
		expect(decideStrongClaim(verified, CUTOVER_OK).ok).toBe(true);
	});

	it("INVARIANT: source destroyed only after cutover AND rollback window", () => {
		const verified = drive(UP_TO_VERIFIED);
		const beforeCutover = decideStrongClaim(verified, {
			type: "DestroySource",
		});
		expect(beforeCutover.ok).toBe(false);
		if (!beforeCutover.ok) {
			expect(beforeCutover.rejection.code).toBe("destroy-before-cutover");
		}

		const cutover = drive([...UP_TO_VERIFIED, CUTOVER_OK]);
		expect(cutover.phase).toBe("rollback-window-open");
		const duringWindow = decideStrongClaim(cutover, { type: "DestroySource" });
		expect(duringWindow.ok).toBe(false);
		if (!duringWindow.ok) {
			expect(duringWindow.rejection.code).toBe(
				"destroy-before-rollback-window-closed",
			);
		}

		const closed = drive([{ type: "CloseRollbackWindow" }], cutover);
		expect(closed.rollbackWindowClosed).toBe(true);
		expect(decideStrongClaim(closed, { type: "DestroySource" }).ok).toBe(true);
	});
});

describe("strong claim: failure branches", () => {
	it("INVARIANT: source stays authoritative on failed import", () => {
		const state = drive([
			START,
			PROVISION,
			DEPLOY,
			FENCE,
			EXPORT,
			{
				type: "ImportIntoDestination",
				artifactRef: "artifact://snapshot_1",
				ok: false,
				reason: "table _storage rejected",
			},
		]);
		expect(state.phase).toBe("failed");
		expect(state.authoritative).toBe("source");
		expect(state.claimComplete).toBe(false);
		expect(state.cutoverDone).toBe(false);
		expect(state.sourceDestroyed).toBe(false);
		expect(state.failure?.code).toBe("import-failed");
	});

	it("fails the claim when any verification check is red", () => {
		for (const key of [
			"documentCountsMatch",
			"sampledHashesMatch",
			"filesMatch",
			"indexesReady",
			"httpActionsRouting",
			"websocketHealthy",
			"authConfigMatches",
			"appHealthy",
		] as const) {
			const summary: VerificationSummary = { ...ALL_GREEN, [key]: false };
			expect(verificationFailures(summary)).toEqual([key]);
			const state = drive([
				...UP_TO_IMPORTED,
				{ type: "VerifyDestination", summary },
			]);
			expect(state.phase).toBe("failed");
			expect(state.authoritative).toBe("source");
			expect(state.claimComplete).toBe(false);
			expect(state.failure?.code).toBe("verification-failed");
			expect(state.failure?.message).toContain(key);
		}
	});

	it("keeps the source authoritative when cutover itself fails", () => {
		const state = drive([
			...UP_TO_VERIFIED,
			{
				type: "CutoverConnector",
				connectorId: "connector-app",
				ok: false,
				reason: "DNS record write rejected",
			},
		]);
		expect(state.phase).toBe("failed");
		expect(state.authoritative).toBe("source");
		expect(state.cutoverDone).toBe(false);
		expect(state.claimComplete).toBe(false);
	});

	it("rolls back inside the window and returns the crown to the source", () => {
		const state = drive([
			...UP_TO_VERIFIED,
			CUTOVER_OK,
			{ type: "Rollback", reason: "error rate spiked" },
		]);
		expect(state.authoritative).toBe("source");
		expect(state.sourceWritable).toBe(true);
		expect(state.cutoverDone).toBe(false);
		expect(state.sourceDestroyed).toBe(false);
		expect(state.claimComplete).toBe(false);
		expect(state.failure?.code).toBe("rolled-back");
	});

	it("INVARIANT: a failed claim never reports completion", () => {
		const failed = drive([
			...UP_TO_IMPORTED,
			{ type: "Abort", code: "driver-error", message: "backend unreachable" },
		]);
		expect(failed.claimComplete).toBe(false);

		// Even a stray Completed event cannot resurrect it.
		const decision = decideStrongClaim(failed, { type: "DestroySource" });
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.rejection.code).toBe("terminal");
		expect(failed.claimComplete).toBe(false);
	});

	it("refuses further commands once terminal", () => {
		const failed = drive([
			START,
			{ type: "Abort", code: "aborted", message: "operator cancelled" },
		]);
		for (const command of [PROVISION, DEPLOY, FENCE, EXPORT] as const) {
			const decision = decideStrongClaim(failed, command);
			expect(decision.ok).toBe(false);
			if (!decision.ok) expect(decision.rejection.code).toBe("terminal");
		}
	});
});

describe("strong claim: saga executor over the injected driver", () => {
	it("completes the happy path and destroys the temporary backend last", async () => {
		const calls: string[] = [];
		const driver = fakeDriver();
		const traced: ConvexMigrationDriver = {
			provisionDestination: async (input) => {
				calls.push("provision");
				return driver.provisionDestination(input);
			},
			deployCodeAndConfig: async (input) => {
				calls.push("deploy");
				return driver.deployCodeAndConfig(input);
			},
			quiesceSource: async (input) => {
				calls.push("quiesce");
				return driver.quiesceSource(input);
			},
			export: async (input) => {
				calls.push("export");
				return driver.export(input);
			},
			import: async (input) => {
				calls.push("import");
				return driver.import(input);
			},
			verify: async (input) => {
				calls.push("verify");
				return driver.verify(input);
			},
			cutover: async (input) => {
				calls.push("cutover");
				return driver.cutover(input);
			},
			awaitRollbackWindow: async (input) => {
				calls.push("rollback-window");
				return driver.awaitRollbackWindow(input);
			},
			destroy: async (input) => {
				calls.push("destroy");
				return driver.destroy(input);
			},
		};

		const result = await runStrongClaim({
			claimId: "claim-happy",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 60_000,
			driver: traced,
		});

		expect(calls).toEqual([
			"provision",
			"deploy",
			"quiesce",
			"export",
			"import",
			"verify",
			"cutover",
			"rollback-window",
			"destroy",
		]);
		expect(result.ok).toBe(true);
		expect(result.state.claimComplete).toBe(true);
		expect(result.state.authoritative).toBe("destination");
		expect(result.state.sourceDestroyed).toBe(true);
		expect(result.receipt.destinationBackendId).toBe(B1.backendId);
		expect(result.receipt.retiredAuthorityRefs).toEqual([K0]);
		expect(result.events.map((e) => e.type)).toEqual([
			"claim.Started",
			"claim.DestinationProvisioned",
			"claim.CodeDeployed",
			"claim.SourceFenced",
			"claim.Exported",
			"claim.Imported",
			"claim.Verified",
			"claim.CutoverCompleted",
			"claim.RollbackWindowClosed",
			"claim.SourceDestroyed",
			"claim.Completed",
		]);
	});

	it("never cuts over or destroys when the import fails", async () => {
		const destroyed: string[] = [];
		const result = await runStrongClaim({
			claimId: "claim-import-fail",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 1,
			driver: fakeDriver({
				import: async () => ({ ok: false, reason: "checksum mismatch" }),
				destroy: async (input) => {
					destroyed.push(input.source.backendId);
					return { ok: true, destroyedBackendId: input.source.backendId };
				},
			}),
		});
		expect(result.ok).toBe(false);
		expect(destroyed).toEqual([]);
		expect(result.state.authoritative).toBe("source");
		expect(result.state.sourceDestroyed).toBe(false);
		expect(result.receipt.claimComplete).toBe(false);
		expect(result.events.map((e) => e.type)).not.toContain(
			"claim.CutoverCompleted",
		);
	});

	it("stops at verification and leaves the source in charge", async () => {
		const result = await runStrongClaim({
			claimId: "claim-verify-fail",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 1,
			driver: fakeDriver({
				verify: async () => ({ ...ALL_GREEN, filesMatch: false }),
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.state.failure?.code).toBe("verification-failed");
		expect(result.state.authoritative).toBe("source");
		expect(result.events.map((e) => e.type)).toContain(
			"claim.VerificationFailed",
		);
	});

	it("rolls back rather than destroying when the window says so", async () => {
		const result = await runStrongClaim({
			claimId: "claim-rollback",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 5,
			driver: fakeDriver({
				awaitRollbackWindow: async () => ({
					rollback: true,
					reason: "p99 regression",
				}),
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.state.authoritative).toBe("source");
		expect(result.state.sourceDestroyed).toBe(false);
		expect(result.state.failure?.code).toBe("rolled-back");
	});

	it("turns a thrown driver error into a failed claim, never a claim", async () => {
		const result = await runStrongClaim({
			claimId: "claim-throw",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 1,
			driver: fakeDriver({
				export: async () => {
					throw new Error("backend closed the connection");
				},
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.state.failure?.code).toBe("driver-error");
		expect(result.state.failure?.message).toBe("backend closed the connection");
		expect(result.receipt.claimComplete).toBe(false);
		expect(result.state.sourceDestroyed).toBe(false);
	});

	it("does not destroy the source when destruction itself reports failure", async () => {
		const result = await runStrongClaim({
			claimId: "claim-destroy-fail",
			source: B0,
			destinationHostingFormId: "convex.selfhosted-oci/v1",
			rollbackWindowMs: 1,
			driver: fakeDriver({
				destroy: async () => ({
					ok: false,
					destroyedBackendId: B0.backendId,
					reason: "provider API refused",
				}),
			}),
		});
		expect(result.ok).toBe(false);
		expect(result.state.sourceDestroyed).toBe(false);
		expect(result.state.claimComplete).toBe(false);
		// The cutover already happened, so the destination stays authoritative.
		expect(result.state.authoritative).toBe("destination");
	});
});
