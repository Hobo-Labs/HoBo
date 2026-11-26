/**
 * The Convex strong-claim saga — its fold, and the invariants it never breaks.
 *
 * A strong claim moves a live Convex backend from a source deployment to a
 * destination the user owns: provision, deploy code, fence the source, export,
 * import, verify, cut over. It is a distributed migration of somebody's
 * production data, and the fold below is where "did it work?" is decided.
 *
 * Three invariants hold no matter what sequence of events arrives.
 *
 * **A failure never leaves the destination authoritative.** The source keeps
 * the crown until a cutover actually succeeds. If it did not, a failed
 * migration would leave writes going to a backend that may hold a partial
 * import — the worst outcome available.
 *
 * **A recorded failure can never become a claim.** `claim.Completed` after a
 * failure is ignored rather than believed. This is defence in depth: the
 * decider should never emit that pair, so the fold treating it as a claim
 * would turn a decider bug into silent data loss.
 *
 * **Authority material never reaches an event.** Convex admin and deploy keys
 * have a recognisable shape, and every accepted event is scanned before it is
 * emitted — an event lands in an append-only log, where a leaked key cannot be
 * retracted.
 *
 * Unknown-for-this-phase events are ignored rather than thrown, because the
 * fold runs over a durable log that may contain events written by an older
 * build.
 */
import { describe, expect, it } from "vitest";

import {
	assertNoAuthorityMaterial,
	initialStrongClaimState,
	isTerminal,
	looksLikeAuthorityMaterial,
	parseAuthorityRef,
	reduceStrongClaim,
	reduceStrongClaimAll,
	StrongClaimError,
	type StrongClaimEvent,
	StrongClaimSecretLeakError,
	type StrongClaimState,
	VERIFICATION_CHECK_KEYS,
	verificationFailures,
	verificationPassed,
} from "../src/strong-claim.js";

const initial = () => initialStrongClaimState("claim-1");

/** Fold a sequence of events onto a fresh state. */
const fold = (...events: unknown[]) =>
	reduceStrongClaimAll(initial(), events as StrongClaimEvent[]);

/** A verification summary with every check passing unless overridden. */
const summary = (overrides: Record<string, boolean> = {}) =>
	Object.fromEntries(
		VERIFICATION_CHECK_KEYS.map((key) => [key, overrides[key] ?? true]),
	) as never;

const started = {
	type: "claim.Started",
	compromisedAuthorityRefs: ["ref-old"],
	rollbackWindowMs: 60_000,
};

describe("authority material", () => {
	it("recognises a Convex admin key by its separator and opaque tail", () => {
		// `bold-hyena-681|01c2…` — a hyphenated deployment name, a pipe, and a
		// long base64 tail. That combination is the tell.
		expect(
			looksLikeAuthorityMaterial("bold-hyena-681|01c2abcdefghijklmnop"),
		).toBe(true);
	});

	it("recognises a deploy key under each documented prefix", () => {
		for (const prefix of ["prod", "preview", "dev", "project"]) {
			expect(
				looksLikeAuthorityMaterial(`${prefix}:bold-hyena-681|abc123`),
				prefix,
			).toBe(true);
		}
	});

	it("does not fire on an ordinary broker handle", () => {
		// A false positive refuses a legitimate claim, so the pattern has to
		// leave normal refs, URLs, and ids alone.
		for (const value of [
			"broker://convex/authority/abc",
			"authority-ref-1",
			"https://bold-hyena-681.convex.cloud",
			"claim-1",
		]) {
			expect(looksLikeAuthorityMaterial(value), value).toBe(false);
		}
	});
});

describe("parseAuthorityRef", () => {
	it("brands a trimmed broker handle", () => {
		expect(parseAuthorityRef("  broker://convex/a  ")).toBe(
			"broker://convex/a",
		);
	});

	it("refuses an empty or whitespace-only handle", () => {
		// An empty ref would resolve to nothing at broker time, far from here.
		for (const value of ["", "   ", "\n\t"]) {
			expect(() => parseAuthorityRef(value)).toThrow(StrongClaimError);
		}
	});

	it("refuses anything key-shaped, under the leak error", () => {
		// This is the boundary that keeps a real Convex key out of every event,
		// receipt, plan, and log line downstream.
		expect(() => parseAuthorityRef("prod:bold-hyena-681|abc123")).toThrow(
			StrongClaimSecretLeakError,
		);
		expect(() => parseAuthorityRef("prod:bold-hyena-681|abc123")).toThrow(
			/Convex key material/,
		);
	});
});

describe("assertNoAuthorityMaterial", () => {
	it("passes a clean value", () => {
		expect(() =>
			assertNoAuthorityMaterial(
				{ url: "https://a.convex.cloud" } as never,
				"x",
			),
		).not.toThrow();
	});

	it("finds material nested anywhere in the value", () => {
		// Events are nested by construction; a top-level-only scan would miss
		// every realistic leak.
		expect(() =>
			assertNoAuthorityMaterial(
				{ a: { b: ["prod:bold-hyena-681|abc123"] } } as never,
				"an event",
			),
		).toThrow(StrongClaimSecretLeakError);
	});

	it("names what it refused to emit", () => {
		// The context is what tells the caller which artifact was blocked.
		expect(() =>
			assertNoAuthorityMaterial(
				{ k: "prod:x-y|abcdefghijkl" } as never,
				"the claim receipt",
			),
		).toThrow(/the claim receipt/);
	});
});

describe("verification summary", () => {
	it("passes only when every check passed", () => {
		expect(verificationPassed(summary())).toBe(true);
		expect(verificationFailures(summary())).toEqual([]);
	});

	it("names each failing check", () => {
		// An operator deciding whether to cut over needs to know *which* check
		// disagreed — a document-count mismatch and a routing failure are very
		// different problems.
		const failures = verificationFailures(
			summary({ documentCountsMatch: false, indexesReady: false }),
		);
		expect(failures).toEqual(["documentCountsMatch", "indexesReady"]);
		expect(verificationPassed(summary({ filesMatch: false }))).toBe(false);
	});

	it("treats a missing or non-true check as a failure", () => {
		// Anything but a literal `true` is not a passed check. Truthiness here
		// would let `"false"` or `1` count as verification.
		expect(
			verificationFailures({ ...summary(), appHealthy: undefined } as never),
		).toContain("appHealthy");
		expect(
			verificationFailures({ ...summary(), appHealthy: 1 } as never),
		).toContain("appHealthy");
	});
});

describe("initial state", () => {
	it("starts idle with the source authoritative and writable", () => {
		// Before anything happens the source is still serving production. Any
		// other starting point would be a claim that began by taking the crown.
		const state = initial();
		expect(state.phase).toBe("idle");
		expect(state.authoritative).toBe("source");
		expect(state.sourceWritable).toBe(true);
		expect(state.claimComplete).toBe(false);
		expect(state.failure).toBeNull();
	});

	it("is frozen", () => {
		// The fold returns new states; a caller mutating one in place would make
		// a replay disagree with the log it came from.
		expect(Object.isFrozen(initial())).toBe(true);
	});
});

describe("the happy path", () => {
	const happyPath = [
		started,
		{ type: "claim.DestinationProvisioned" },
		{ type: "claim.CodeDeployed" },
		{ type: "claim.SourceFenced" },
		{ type: "claim.Exported" },
		{ type: "claim.Imported" },
		{ type: "claim.Verified", summary: summary() },
		{
			type: "claim.CutoverCompleted",
			connectorId: "conn-1",
			rollbackWindowMs: 60_000,
		},
		{ type: "claim.RollbackWindowClosed" },
		{ type: "claim.SourceDestroyed" },
		{ type: "claim.Completed" },
	];

	it("walks every phase to a completed claim", () => {
		const state = fold(...happyPath);
		expect(state.phase).toBe("claimed");
		expect(state.claimComplete).toBe(true);
		expect(state.failure).toBeNull();
	});

	it("hands the crown over only at cutover", () => {
		// Everything before cutover is preparation; the source is still serving.
		// Moving authority earlier would send writes to a backend mid-import.
		for (let i = 1; i < 8; i += 1) {
			expect(fold(...happyPath.slice(0, i)).authoritative, String(i)).toBe(
				"source",
			);
		}
		expect(fold(...happyPath.slice(0, 8)).authoritative).toBe("destination");
	});

	it("fences the source before exporting", () => {
		// An export taken while the source is still accepting writes would miss
		// whatever landed after the snapshot.
		expect(fold(...happyPath.slice(0, 4)).sourceWritable).toBe(false);
	});

	it("records the rollback window and the connector at cutover", () => {
		const state = fold(...happyPath.slice(0, 8));
		expect(state.connectorId).toBe("conn-1");
		expect(state.rollbackWindowMs).toBe(60_000);
		expect(state.rollbackWindowClosed).toBe(false);
	});

	it("keeps the verification summary it was given", () => {
		// The summary is what a receipt reports. Recomputing it later would ask
		// a destination that has since changed.
		expect(fold(...happyPath.slice(0, 7)).verification).toEqual(summary());
	});

	it("copies the compromised refs rather than aliasing the event's array", () => {
		const refs = ["ref-old"];
		const state = fold({ ...started, compromisedAuthorityRefs: refs });
		refs.push("ref-new");
		expect(state.compromisedAuthorityRefs).toEqual(["ref-old"]);
		expect(Object.isFrozen(state.compromisedAuthorityRefs)).toBe(true);
	});
});

describe("failures never leave the destination authoritative", () => {
	const failureEvents: Array<[string, Record<string, unknown>]> = [
		["import", { type: "claim.ImportFailed", reason: "disk full" }],
		[
			"verification",
			{ type: "claim.VerificationFailed", failedChecks: ["filesMatch"] },
		],
		["cutover", { type: "claim.CutoverFailed", reason: "dns" }],
		[
			"explicit",
			{ type: "claim.Failed", code: "aborted", message: "operator" },
		],
	];

	it("marks the claim failed and incomplete for each failure kind", () => {
		for (const [name, event] of failureEvents) {
			const state = fold(started, event);
			expect(state.phase, name).toBe("failed");
			expect(state.claimComplete, name).toBe(false);
			expect(state.failure, name).not.toBeNull();
		}
	});

	it("leaves the source authoritative when the failure came before cutover", () => {
		// This is the invariant that matters: a failed migration must not point
		// writes at a backend holding a partial import.
		for (const [name, event] of failureEvents) {
			expect(fold(started, event).authoritative, name).toBe("source");
		}
	});

	it("keeps the destination authoritative when cutover had already succeeded", () => {
		// After a successful cutover the destination *is* serving. Silently
		// reverting authority on a later failure would claim a rollback that
		// never happened.
		const state = fold(
			started,
			{ type: "claim.CutoverCompleted", connectorId: "c", rollbackWindowMs: 1 },
			{ type: "claim.Failed", code: "post-cutover", message: "later problem" },
		);
		expect(state.authoritative).toBe("destination");
		expect(state.claimComplete).toBe(false);
	});

	it("carries the failure's own code and message", () => {
		// The code is what a caller branches on; the message is what an operator
		// reads. A generic failure would lose both.
		expect(
			fold(started, { type: "claim.ImportFailed", reason: "disk full" })
				.failure,
		).toMatchObject({ code: "import-failed", message: "disk full" });
		expect(
			fold(started, {
				type: "claim.VerificationFailed",
				failedChecks: ["filesMatch", "indexesReady"],
			}).failure?.message,
		).toContain("filesMatch, indexesReady");
	});
});

describe("rollback", () => {
	const rolledBack = () =>
		fold(
			started,
			{ type: "claim.CutoverCompleted", connectorId: "c", rollbackWindowMs: 1 },
			{ type: "claim.RolledBack", reason: "latency regression" },
		);

	it("returns the crown to the source and makes it writable again", () => {
		// A rollback that left the source read-only would leave the app with no
		// writable backend at all.
		const state = rolledBack();
		expect(state.authoritative).toBe("source");
		expect(state.sourceWritable).toBe(true);
		expect(state.cutoverDone).toBe(false);
	});

	it("reopens the rollback window flag and records the reason", () => {
		const state = rolledBack();
		expect(state.rollbackWindowClosed).toBe(false);
		expect(state.failure).toMatchObject({
			code: "rolled-back",
			message: "latency regression",
		});
	});

	it("is a failure, not a completion", () => {
		expect(rolledBack().phase).toBe("failed");
		expect(rolledBack().claimComplete).toBe(false);
	});
});

describe("a recorded failure can never become a claim", () => {
	it("ignores claim.Completed after a failure", () => {
		// Defence in depth. The decider should never emit this pair, so the fold
		// believing it would turn a decider bug into silent data loss.
		const state = fold(
			started,
			{ type: "claim.ImportFailed", reason: "disk full" },
			{ type: "claim.Completed" },
		);
		expect(state.phase).toBe("failed");
		expect(state.claimComplete).toBe(false);
	});

	it("returns the same state object rather than a copy", () => {
		// The event changed nothing, and a fresh object would make a caller
		// comparing by identity think it had.
		const failed = fold(started, {
			type: "claim.Failed",
			code: "x",
			message: "y",
		});
		expect(
			reduceStrongClaim(failed, { type: "claim.Completed" } as never),
		).toBe(failed);
	});
});

describe("unknown and out-of-phase events", () => {
	it("ignores an event type it does not know", () => {
		// The fold runs over a durable log that may hold events written by a
		// newer build. Throwing would make an old reader unable to replay at all.
		const state = initial();
		expect(
			reduceStrongClaim(state, { type: "claim.Frobnicated" } as never),
		).toBe(state);
	});

	it("applies an event regardless of the phase it arrives in", () => {
		// The fold is a projection, not a gate — ordering is the decider's job.
		// Rejecting here would duplicate that logic in two places that could
		// disagree.
		expect(fold({ type: "claim.Verified", summary: summary() }).phase).toBe(
			"verified",
		);
	});
});

describe("isTerminal", () => {
	it("treats claimed and failed as terminal and nothing else", () => {
		// Terminal decides whether further commands are accepted at all. Marking
		// a mid-saga phase terminal would strand a claim; missing one would let
		// commands land on a finished migration.
		expect(isTerminal({ phase: "claimed" } as StrongClaimState)).toBe(true);
		expect(isTerminal({ phase: "failed" } as StrongClaimState)).toBe(true);
		for (const phase of [
			"idle",
			"temporary-backend",
			"destination-ready",
			"code-deployed",
			"source-fenced",
			"exported",
			"imported",
			"verified",
			"rollback-window-open",
			"rollback-window-closed",
			"source-destroyed",
		]) {
			expect(isTerminal({ phase } as StrongClaimState), phase).toBe(false);
		}
	});
});

describe("reduceStrongClaimAll", () => {
	it("returns the initial state for no events", () => {
		const state = initial();
		expect(reduceStrongClaimAll(state, [])).toBe(state);
	});

	it("is equivalent to folding one at a time", () => {
		// Replay has to agree with incremental application, or a restored
		// process would disagree with the one that wrote the log.
		const events = [
			started,
			{ type: "claim.DestinationProvisioned" },
			{ type: "claim.CodeDeployed" },
		] as StrongClaimEvent[];
		expect(reduceStrongClaimAll(initial(), events)).toEqual(
			events.reduce(reduceStrongClaim, initial()),
		);
	});
});
