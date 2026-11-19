import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
	type AuthorityFlip,
	createMemoryMigrationJournal,
	createReferenceEngine,
	DataCoreError,
	type EngineBinding,
	encodeRecordKey,
	FENCE_NOT_OWNED,
	fenceTokenDigest,
	foldMigration,
	isSupersededError,
	JournalConflictError,
	MIGRATION_EVENTS,
	type MigrationFact,
	type MigrationJournal,
	type MigrationRunResult,
	type NativeTransferPort,
	nativeTransferName,
	type PolicyVerdict,
	parseCanonicalRecord,
	parseDatasetSchema,
	REFERENCE_NATIVE_PROFILE,
	type RecordMutation,
	ROLLBACK_TARGET_UNREACHABLE,
	requirePort,
	runInPlaceEvolve,
	runOfflineCopy,
	runSnapshotAndTail,
	type SoakDecision,
	StaleAuthorityMoveError,
	scopeOf,
	upsertMutation,
} from "../src/index.js";
import {
	ALLOW,
	Authority,
	copyOptions,
	count,
	erase,
	fenced,
	NOW,
	order,
	REALIZATIONS,
	type Stage,
	stage,
	totalOf,
	types,
	writable,
} from "./support/stage.js";

const DENY: PolicyVerdict = {
	...ALLOW,
	ok: false,
	findings: [
		{
			code: "CUSTODY_RETENTION_EXPIRED",
			point: "relay",
			role: "relay",
			detail: "",
			remediation: "",
		},
	],
};

function gate() {
	let open: () => void = () => {};
	let arrive: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const arrived = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	return {
		async wait(): Promise<void> {
			arrive();
			await opened;
		},
		arrived,
		open: () => open(),
	};
}

type Settled =
	| { readonly result: MigrationRunResult }
	| { readonly error: Error };

function settle(run: Promise<MigrationRunResult>): Promise<Settled> {
	return run.then(
		(result) => ({ result }),
		(error: Error) => ({ error }),
	);
}

function errorOf(outcome: Settled): Error {
	assert.ok("error" in outcome, "the stale driver must not report a result");
	return outcome.error;
}

function factsOf(facts: readonly MigrationFact[], type: string) {
	return facts.filter((fact) => fact.type === type);
}

const NO_ERASURES = { since: () => [] };

describe("an authority move that lands late is refused by the router", () => {
	const variants = [
		...REALIZATIONS.map((realization) => ({
			realization,
			targetFence: true,
		})),
		{ realization: "hub" as const, targetFence: false },
	];
	for (const { realization, targetFence } of variants) {
		test(`${realization}, target ${targetFence ? "with" : "without"} a fence: a flip stalled on its way to the router does not land after the migration was rolled back`, async () => {
			const staged = await stage(
				realization,
				targetFence ? {} : { targetOmit: ["fence"] },
			);
			const router = new Authority();
			const stalled = gate();
			const a = settle(
				runSnapshotAndTail(
					copyOptions(staged, {
						erasures: NO_ERASURES,
						soakDecision: () => "hold",
						flipAuthority: async (flip) => {
							if (flip.direction === "to-target") await stalled.wait();
							router.flip(flip);
						},
					}),
				),
			);
			await stalled.arrived;
			const c = await runSnapshotAndTail(
				copyOptions(staged, {
					erasures: NO_ERASURES,
					soakDecision: () => "rollback",
					flipAuthority: router.flip,
				}),
			);
			assert.equal(c.status, "rolled-back", c.reason);
			assert.deepEqual(router.flips, ["to-target", "to-source"]);

			stalled.open();
			const error = errorOf(await a);
			assert.ok(error instanceof StaleAuthorityMoveError, String(error));
			assert.ok(isSupersededError(error));
			assert.deepEqual(
				router.flips,
				["to-target", "to-source"],
				"the late flip moved write authority after the rollback",
			);
			assert.equal(router.side, "source");
			const [late] = router.refused;
			assert.equal(late?.direction, "to-target");
			const journal = await staged.journal.load("m1");
			const headOf = (type: string) =>
				journal.findIndex((fact) => fact.type === type) + 1;
			assert.equal(late?.head, headOf(MIGRATION_EVENTS.CutOver));
			assert.ok((late?.head ?? 0) < headOf(MIGRATION_EVENTS.RollbackDecided));

			assert.equal(foldMigration("m1", journal).status, "rolled-back");
			assert.equal(
				journal[journal.length - 1]?.type,
				MIGRATION_EVENTS.RolledBack,
			);
			assert.equal(await writable(staged.source), true);
			if (targetFence) assert.equal(await writable(staged.target), false);

			const again = await runSnapshotAndTail(
				copyOptions(staged, { flipAuthority: router.flip }),
			);
			assert.equal(again.status, "rolled-back");
			assert.deepEqual(router.flips, ["to-target", "to-source"]);
		});
	}

	test("the same decision delivered twice carries the same head, so finishing a crashed flip is accepted", async () => {
		const staged = await stage("hub");
		const seen: AuthorityFlip[] = [];
		const router = new Authority();
		let down = true;
		const options = copyOptions(staged, {
			soakDecision: () => "hold",
			flipAuthority: (flip) => {
				seen.push(flip);
				if (down) throw new Error("router down");
				router.flip(flip);
			},
		});
		await assert.rejects(runSnapshotAndTail(options), /router down/u);
		down = false;
		const held = await runSnapshotAndTail(options);
		assert.equal(held.status, "held");
		assert.deepEqual(
			seen.map((flip) => [flip.migrationId, flip.direction, flip.head]),
			[
				["m1", "to-target", seen[0]?.head],
				["m1", "to-target", seen[0]?.head],
			],
		);
		assert.deepEqual(router.flips, ["to-target"]);
		assert.deepEqual(router.refused, []);
	});

	test("a compensation's release that lands late does not unfence the source under another driver's cutover", async () => {
		const staged = await stage("hub");
		const fence = requirePort(staged.source, "fence");
		const stalled = gate();
		const slow: EngineBinding = {
			...staged.source,
			fence: {
				raise: (request) => fence.raise(request),
				status: (scope) => fence.status(scope),
				release: async (request) => {
					await stalled.wait();
					await fence.release(request);
				},
			},
		};
		const router = new Authority();
		const a = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slow },
					{ flipAuthority: router.flip, soakDecision: () => "hold" },
					{
						afterPhase: async (phase) => {
							if (phase !== "shift-reads") return;
							await staged.target.records.write({
								dataset: "orders",
								mutations: [order("stray", "1")],
							});
						},
					},
				),
			),
		);
		await stalled.arrived;
		assert.equal(await fenced(staged.source), true);
		await staged.target.records.write({
			dataset: "orders",
			mutations: [erase("stray")],
		});
		const c = await runSnapshotAndTail(
			copyOptions(staged, {
				flipAuthority: router.flip,
				soakDecision: () => "hold",
			}),
		);
		assert.equal(c.status, "held");
		assert.equal(c.state.cutOver, true);
		assert.equal(router.side, "target");
		const raised = factsOf(c.facts, MIGRATION_EVENTS.FenceRaised).map(
			(fact) => fact.data.fenceTokenDigest,
		);
		assert.equal(raised.length, 2);
		assert.notEqual(raised[0], raised[1]);

		stalled.open();
		const error = errorOf(await a);
		assert.ok(error instanceof JournalConflictError, String(error));
		assert.equal(
			await fenced(staged.source),
			true,
			"the late release unfenced the old authority after the cutover",
		);
		assert.equal(await writable(staged.source), false);
		const done = await runSnapshotAndTail(
			copyOptions(staged, { flipAuthority: router.flip }),
		);
		assert.equal(done.status, "completed", done.reason);
	});
});

describe("a negative verdict does not hold a rollback", () => {
	for (const realization of REALIZATIONS) {
		test(`${realization}: a rollback that was decided is finished whatever the verdict says`, async () => {
			const staged = await stage(realization);
			const router = new Authority();
			let decision: SoakDecision = "hold";
			let verdict = ALLOW;
			let routerDown = false;
			const options = () =>
				copyOptions(
					staged,
					{
						erasures: NO_ERASURES,
						soakDecision: () => decision,
						flipAuthority: (flip) => {
							if (routerDown && flip.direction === "to-source") {
								throw new Error("router down");
							}
							router.flip(flip);
						},
					},
					{ policy: () => verdict },
				);
			assert.equal((await runSnapshotAndTail(options())).status, "held");
			decision = "rollback";
			routerDown = true;
			await assert.rejects(runSnapshotAndTail(options()), /router down/u);
			const stuck = await staged.journal.load("m1");
			assert.equal(foldMigration("m1", stuck).rollbackDecided, true);
			assert.equal(await writable(staged.source), false);
			routerDown = false;
			verdict = DENY;
			const rolled = await runSnapshotAndTail(options());
			assert.equal(rolled.status, "rolled-back", rolled.reason);
			assert.equal(router.side, "source");
			assert.equal(await fenced(staged.source), false);
			assert.equal(await writable(staged.source), true);
			assert.equal(await writable(staged.target), false);
		});

		test(`${realization}: a rollback asked for under a negative verdict goes ahead, and records the verdict it ran under`, async () => {
			const staged = await stage(realization);
			const router = new Authority();
			let decision: SoakDecision = "hold";
			let verdict = ALLOW;
			const options = () =>
				copyOptions(
					staged,
					{
						erasures: NO_ERASURES,
						soakDecision: () => decision,
						flipAuthority: router.flip,
					},
					{ policy: () => verdict },
				);
			assert.equal((await runSnapshotAndTail(options())).status, "held");
			verdict = DENY;
			decision = "finalize";
			const blocked = await runSnapshotAndTail(options());
			assert.equal(blocked.status, "held");
			assert.match(
				blocked.reason ?? "",
				/policy verdict is negative before soak: CUSTODY_RETENTION_EXPIRED/u,
			);
			assert.equal(router.side, "target");
			decision = "rollback";
			const rolled = await runSnapshotAndTail(options());
			assert.equal(rolled.status, "rolled-back", rolled.reason);
			assert.equal(router.side, "source");
			assert.equal(await writable(staged.source), true);
			const [decided] = factsOf(rolled.facts, MIGRATION_EVENTS.RollbackDecided);
			assert.deepEqual(decided?.data.policyFindings, [
				"CUSTODY_RETENTION_EXPIRED",
			]);
		});
	}

	test("a rollback asked for under a positive verdict records no findings", async () => {
		const staged = await stage("hub");
		let decision: SoakDecision = "hold";
		const options = () => copyOptions(staged, { soakDecision: () => decision });
		await runSnapshotAndTail(options());
		decision = "rollback";
		const rolled = await runSnapshotAndTail(options());
		const [decided] = factsOf(rolled.facts, MIGRATION_EVENTS.RollbackDecided);
		assert.equal(decided?.data.policyFindings, undefined);
		assert.equal(decided?.data.targetFenced, true);
	});
});

function mortal(target: EngineBinding) {
	const state = { down: false, stops: 0 };
	const refuse = (): never => {
		throw new Error("connect ECONNREFUSED 10.0.0.7:5432");
	};
	const fence = target.fence;
	const native = target.nativeTransfer;
	const binding: EngineBinding = {
		...target,
		...(fence === undefined
			? undefined
			: {
					fence: {
						raise: (request) => (state.down ? refuse() : fence.raise(request)),
						status: (scope) => (state.down ? refuse() : fence.status(scope)),
						release: (request) =>
							state.down ? refuse() : fence.release(request),
					},
				}),
		...(native === undefined
			? undefined
			: {
					nativeTransfer: {
						...native,
						stop: (request) => {
							state.stops += 1;
							return state.down ? refuse() : native.stop(request);
						},
					},
				}),
	};
	return { binding, state };
}

describe("a rollback to a stale source does not wait for a target that is gone", () => {
	for (const realization of REALIZATIONS) {
		test(`${realization}: the target stops answering in soak; the rollback still hands authority back, and records that the target was not fenced`, async () => {
			const staged = await stage(
				realization,
				realization === "hub" ? { sourceOmit: ["apply"] } : {},
			);
			const dead = mortal(staged.target);
			const router = new Authority();
			let decision: SoakDecision = "hold";
			const sourceStops: string[] = [];
			const sourceNative = staged.source.nativeTransfer;
			const source: EngineBinding =
				sourceNative === undefined
					? staged.source
					: {
							...staged.source,
							nativeTransfer: {
								...sourceNative,
								stop: (request) => {
									sourceStops.push(request.transfer);
									return sourceNative.stop(request);
								},
							},
						};
			const options = () =>
				copyOptions(
					{ ...staged, source, target: dead.binding },
					{
						erasures: NO_ERASURES,
						soakDecision: () => decision,
						flipAuthority: router.flip,
					},
				);
			const held = await runSnapshotAndTail(options());
			assert.equal(held.status, "held");
			assert.equal(held.rollback, "to-snapshot");
			assert.equal(router.side, "target");

			dead.state.down = true;
			decision = "rollback";
			sourceStops.length = 0;
			const rolled = await runSnapshotAndTail(options());
			assert.equal(rolled.status, "rolled-back", rolled.reason);
			assert.equal(router.side, "source");
			assert.equal(await fenced(staged.source), false);
			assert.equal(await writable(staged.source), true);
			const [decided] = factsOf(rolled.facts, MIGRATION_EVENTS.RollbackDecided);
			assert.equal(decided?.data.lossless, false);
			assert.equal(decided?.data.targetFenced, false);
			assert.deepEqual(rolled.impedance, [ROLLBACK_TARGET_UNREACHABLE]);
			assert.doesNotMatch(
				JSON.stringify(rolled.facts),
				/ECONNREFUSED|10\.0\.0\.7/u,
			);
			if (realization === "native") {
				assert.deepEqual(sourceStops, [nativeTransferName("m1")]);
				assert.ok(dead.state.stops > 0, "the target was asked, and failed");
			}
		});
	}

	test("a reachable target is still fenced, and the decision says so", async () => {
		const staged = await stage("hub", { sourceOmit: ["apply"] });
		let decision: SoakDecision = "hold";
		const options = () =>
			copyOptions(staged, {
				erasures: NO_ERASURES,
				soakDecision: () => decision,
			});
		await runSnapshotAndTail(options());
		decision = "rollback";
		const rolled = await runSnapshotAndTail(options());
		assert.equal(rolled.status, "rolled-back");
		const [decided] = factsOf(rolled.facts, MIGRATION_EVENTS.RollbackDecided);
		assert.equal(decided?.data.targetFenced, true);
		assert.equal(await fenced(staged.target), true);
		assert.deepEqual(rolled.impedance, []);
	});

	test("a lossless rollback still needs the target: with it gone the rollback fails and authority stays where it is", async () => {
		const staged = await stage("hub");
		const dead = mortal(staged.target);
		const router = new Authority();
		let decision: SoakDecision = "hold";
		const options = () =>
			copyOptions(
				{ ...staged, target: dead.binding },
				{ soakDecision: () => decision, flipAuthority: router.flip },
			);
		const held = await runSnapshotAndTail(options());
		assert.equal(held.rollback, "lossless");
		dead.state.down = true;
		decision = "rollback";
		await assert.rejects(runSnapshotAndTail(options()), /ECONNREFUSED/u);
		assert.equal(router.side, "target");
		assert.equal(await fenced(staged.source), true);
		const journal = await staged.journal.load("m1");
		assert.equal(foldMigration("m1", journal).rollbackDecided, false);
	});
});

describe("a fence is released or adopted only by the migration that can prove it raised it", () => {
	const foreignFence = (binding: EngineBinding) =>
		requirePort(binding, "fence").raise({
			scope: scopeOf("orders"),
			reason: "migration m2 cutover",
		});

	test("the reviewer's case: after a held rollback attempt, a fence another owner raises on the target is not released by a resumed run", async () => {
		const staged = await stage("hub");
		let decision: SoakDecision = "hold";
		let rounds: number | undefined;
		const options = () =>
			copyOptions(staged, {
				soakDecision: () => decision,
				...(rounds === undefined ? undefined : { maxTailRounds: rounds }),
			});
		await runSnapshotAndTail(options());
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("post", "1")],
		});
		decision = "rollback";
		rounds = 0;
		const attempt = await runSnapshotAndTail(options());
		assert.equal(attempt.status, "held");
		assert.equal(await fenced(staged.target), false);
		const foreign = await foreignFence(staged.target);
		decision = "hold";
		rounds = undefined;
		const resumed = await runSnapshotAndTail(options());
		assert.equal(resumed.status, "held");
		assert.match(
			resumed.reason ?? "",
			new RegExp(`^${FENCE_NOT_OWNED}: `, "u"),
		);
		assert.equal(
			await fenced(staged.target),
			true,
			"the other owner's fence was released",
		);
		assert.equal(await writable(staged.target), false);
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("theirs", "2")],
			fenceToken: foreign.fenceToken,
		});
	});

	test("a rollback does not take a fence someone else holds on the target for its own, and does not release it when it fails to converge", async () => {
		const staged = await stage("hub");
		let decision: SoakDecision = "hold";
		let rounds: number | undefined;
		const options = () =>
			copyOptions(staged, {
				soakDecision: () => decision,
				...(rounds === undefined ? undefined : { maxTailRounds: rounds }),
			});
		await runSnapshotAndTail(options());
		const foreign = await foreignFence(staged.target);
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("x", "1")],
			fenceToken: foreign.fenceToken,
		});
		decision = "rollback";
		rounds = 0;
		const attempt = await runSnapshotAndTail(options());
		assert.equal(attempt.status, "held");
		assert.match(
			attempt.reason ?? "",
			new RegExp(`^${FENCE_NOT_OWNED}: `, "u"),
		);
		assert.equal(await fenced(staged.target), true);
		assert.deepEqual(
			factsOf(attempt.facts, MIGRATION_EVENTS.FenceRequested).filter(
				(fact) => fact.data.side === "target",
			),
			[],
			"the migration asked for nothing on the target",
		);
		assert.equal(attempt.state.rollbackDecided, false);
	});

	test("a fence someone else holds on the source is not adopted for the cutover", async () => {
		const staged = await stage("hub");
		const router = new Authority();
		const paused = await runSnapshotAndTail(
			copyOptions(
				staged,
				{ flipAuthority: router.flip },
				{ pauseAfter: "shift-reads" },
			),
		);
		assert.equal(paused.status, "held");
		const foreign = await foreignFence(staged.source);
		const held = await runSnapshotAndTail(
			copyOptions(staged, { flipAuthority: router.flip }),
		);
		assert.equal(held.status, "held");
		assert.match(held.reason ?? "", new RegExp(`^${FENCE_NOT_OWNED}: `, "u"));
		assert.equal(held.state.cutOver, false);
		assert.deepEqual(router.flips, []);
		assert.deepEqual(factsOf(held.facts, MIGRATION_EVENTS.FenceRequested), []);
		assert.equal(await fenced(staged.source), true);
		await requirePort(staged.source, "fence").release({
			scope: scopeOf("orders"),
			fenceToken: foreign.fenceToken,
		});
		const done = await runSnapshotAndTail(
			copyOptions(staged, { flipAuthority: router.flip }),
		);
		assert.equal(done.status, "completed", done.reason);
	});

	test("every fence the migration raises is journaled by digest, never by token", async () => {
		const staged = await stage("hub");
		let decision: SoakDecision = "hold";
		const options = () => copyOptions(staged, { soakDecision: () => decision });
		await runSnapshotAndTail(options());
		const sourceToken = (
			await requirePort(staged.source, "fence").raise({
				scope: scopeOf("orders"),
				reason: "read the token",
			})
		).fenceToken;
		decision = "rollback";
		const rolled = await runSnapshotAndTail(options());
		assert.equal(rolled.status, "rolled-back");
		const raised = factsOf(rolled.facts, MIGRATION_EVENTS.FenceRaised);
		assert.deepEqual(
			raised.map((fact) => [fact.data.side, fact.data.phase]),
			[
				["source", "fence-and-flip"],
				["target", "soak"],
			],
		);
		assert.equal(
			raised[0]?.data.fenceTokenDigest,
			fenceTokenDigest(sourceToken),
		);
		assert.ok(!JSON.stringify(rolled.facts).includes(sourceToken));
		assert.deepEqual(
			types(rolled.facts).filter((type) =>
				[
					"FenceRequested",
					"FenceRaised",
					"CutOver",
					"RollbackDecided",
				].includes(type),
			),
			[
				"FenceRequested",
				"FenceRaised",
				"CutOver",
				"FenceRequested",
				"FenceRaised",
				"RollbackDecided",
			],
		);
	});
});

describe("an erasure that lands between the ledger read and the flip back is replayed", () => {
	test("the ledger is read again after authority is back on the source and before its fence is released", async () => {
		const staged = await stage("hub", { targetOmit: ["fence"] });
		const router = new Authority();
		const ledger: RecordMutation[] = [];
		let decision: SoakDecision = "hold";
		const reads: { readonly side: string; readonly sourceFenced: boolean }[] =
			[];
		const erasures = {
			since: async () => {
				const answered = [...ledger];
				reads.push({
					side: router.side,
					sourceFenced: await fenced(staged.source),
				});
				if (ledger.length === 0) {
					await staged.target.records.write({
						dataset: "orders",
						mutations: [erase("o-3")],
					});
					ledger.push(erase("o-3"));
				}
				return answered;
			},
		};
		const options = () =>
			copyOptions(staged, {
				erasures,
				soakDecision: () => decision,
				flipAuthority: router.flip,
			});
		await runSnapshotAndTail(options());
		decision = "rollback";
		const rolled = await runSnapshotAndTail(options());
		assert.equal(rolled.status, "rolled-back", rolled.reason);
		assert.equal(
			await totalOf(staged.source, "o-3"),
			undefined,
			"the erased subject is readable on the restored authority",
		);
		assert.deepEqual(reads, [
			{ side: "target", sourceFenced: true },
			{ side: "source", sourceFenced: true },
		]);
		const [fact] = factsOf(rolled.facts, MIGRATION_EVENTS.RolledBack);
		assert.equal(fact?.data.erasuresReplayed, 1);
		assert.equal(await count(staged.source), 4);
	});
});

function recording(
	port: NativeTransferPort,
	calls: string[],
): NativeTransferPort {
	return {
		...port,
		pause: (request) => {
			calls.push("pause");
			return port.pause(request);
		},
		resume: (request) => {
			calls.push("resume");
			return port.resume(request);
		},
	};
}

describe("a held native run stops its transfer", () => {
	const REF = {
		profile: REFERENCE_NATIVE_PROFILE,
		transfer: nativeTransferName("m1"),
		scope: scopeOf("orders"),
	};

	async function nativeStage(): Promise<Stage & { readonly calls: string[] }> {
		const staged = await stage("native");
		const calls: string[] = [];
		const port = staged.target.nativeTransfer;
		assert.ok(port);
		return {
			...staged,
			target: { ...staged.target, nativeTransfer: recording(port, calls) },
			calls,
		};
	}

	async function poll(staged: Stage): Promise<void> {
		const source = staged.source.nativeTransfer;
		assert.ok(source);
		await source.reached({ ...REF, mark: await source.mark(REF) });
	}

	test("held by a negative verdict: nothing written to the source reaches the target until the run resumes", async () => {
		const staged = await nativeStage();
		let verdict = DENY;
		const options = () =>
			copyOptions(
				staged,
				{},
				{ policy: (phase) => (phase === "converge" ? verdict : ALLOW) },
			);
		const held = await runSnapshotAndTail(options());
		assert.equal(held.status, "held");
		assert.match(
			held.reason ?? "",
			/policy verdict is negative before converge/u,
		);
		assert.equal(await count(staged.target), 5);
		assert.deepEqual(staged.calls, ["resume", "pause"]);

		await staged.source.records.write({
			dataset: "orders",
			mutations: [order("written-while-held", "9"), erase("o-0")],
		});
		await poll(staged);
		assert.equal(
			await totalOf(staged.target, "written-while-held"),
			undefined,
			"a record reached the target while the migration was held",
		);
		assert.equal(await totalOf(staged.target, "o-0"), "0");

		verdict = ALLOW;
		const done = await runSnapshotAndTail(options());
		assert.equal(done.status, "completed", done.reason);
		assert.equal(await totalOf(staged.target, "written-while-held"), "9");
		assert.equal(await totalOf(staged.target, "o-0"), undefined);
		assert.equal(staged.calls.filter((call) => call === "resume").length, 2);
	});

	test("held on request: a run paused after verify moves nothing either", async () => {
		const staged = await nativeStage();
		const held = await runSnapshotAndTail(
			copyOptions(staged, {}, { pauseAfter: "verify" }),
		);
		assert.equal(held.status, "held");
		assert.equal(staged.calls[staged.calls.length - 1], "pause");
		await staged.source.records.write({
			dataset: "orders",
			mutations: [order("later", "1")],
		});
		await poll(staged);
		assert.equal(await totalOf(staged.target, "later"), undefined);
	});

	test("a hold that only says the engine has not finished leaves the transfer running: pausing it would restart the copy every time", async () => {
		const staged = await nativeStage();
		assert.ok(staged.link);
		staged.link.stall(true);
		const waiting = await runSnapshotAndTail(copyOptions(staged));
		assert.equal(waiting.status, "held");
		assert.match(waiting.reason ?? "", /initial copy has not finished/u);
		assert.ok(!staged.calls.includes("pause"));
		staged.link.stall(false);
		const done = await runSnapshotAndTail(copyOptions(staged));
		assert.equal(done.status, "completed", done.reason);
	});
});

interface RecordedJournals {
	readonly snapshotAndTail: { readonly facts: readonly MigrationFact[] };
	readonly inPlaceEvolve: { readonly facts: readonly MigrationFact[] };
}

const RECORDED = JSON.parse(
	readFileSync(
		path.join(import.meta.dirname, "fixtures", "journal-65a46a72.json"),
		"utf8",
	),
) as RecordedJournals;

const OLD_ORDERS = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "qty", type: "int64" },
	],
});

async function journalOf(
	id: string,
	facts: readonly MigrationFact[],
): Promise<MigrationJournal> {
	const journal = createMemoryMigrationJournal();
	for (const [index, fact] of facts.entries()) {
		await journal.append(id, fact, index);
	}
	return journal;
}

async function recordedStores() {
	const source = createReferenceEngine({ engine: "src" });
	const target = createReferenceEngine({ engine: "tgt" });
	const rows = [
		["a", 1],
		["b", 2],
		["c", 3],
	].map(([id, qty]) => {
		const record = parseCanonicalRecord(OLD_ORDERS, { id, qty });
		return upsertMutation("", encodeRecordKey(OLD_ORDERS, record), record);
	});
	for (const binding of [source, target]) {
		await binding.datasets.ensureDataset(OLD_ORDERS);
		await binding.records.write({ dataset: "orders", mutations: rows });
	}
	const grant = await requirePort(source, "fence").raise({
		scope: scopeOf("orders"),
		reason: "migration m",
	});
	return { source, target, fenceToken: grant.fenceToken };
}

describe("a journal recorded from the 65a46a72 executors is lifted before it is folded", () => {
	const runtime = (journal: MigrationJournal, migrationId: string) => ({
		migrationId,
		journal,
		clock: () => NOW,
		policy: () => ALLOW,
	});

	test("the recorded copy run resumes to completion, and no fence token reaches a result", async () => {
		const { source, target, fenceToken } = await recordedStores();
		const recorded = RECORDED.snapshotAndTail.facts;
		assert.equal(
			recorded.find((fact) => fact.type === MIGRATION_EVENTS.CutOver)?.data
				.fenceToken,
			fenceToken,
		);
		const journal = await journalOf("m", recorded);
		const router = new Authority();
		const done = await runSnapshotAndTail({
			runtime: runtime(journal, "m"),
			source,
			target,
			schema: OLD_ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: router.flip,
		});
		assert.equal(done.status, "completed", done.reason);
		assert.ok(!JSON.stringify(done.facts).includes(fenceToken));
		assert.equal(done.state.pattern, "snapshot-and-tail");
		const digest = (binding: EngineBinding) =>
			requirePort(binding, "verify").digest({
				scope: scopeOf("orders"),
				buckets: 4,
			});
		assert.equal((await digest(source)).count, 0);
		assert.equal((await digest(target)).count, 3);
	});

	test("a recorded journal is checked against its pattern: a copy plan is not resumed as another pattern, and an in-place plan — which named none — is not resumed as a copy", async () => {
		const { source, target } = await recordedStores();
		const copy = await journalOf("m", RECORDED.snapshotAndTail.facts);
		const base = {
			source,
			target,
			schema: OLD_ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
		};
		const refused = (planned: string) => (cause: Error) =>
			cause instanceof DataCoreError &&
			cause.code === "INVALID_MIGRATION_PLAN" &&
			cause.message.includes(`was planned as ${planned}`);
		await assert.rejects(
			runOfflineCopy({ ...base, runtime: runtime(copy, "m") }),
			refused("snapshot-and-tail"),
		);
		const [planned] = RECORDED.inPlaceEvolve.facts;
		assert.equal(planned?.data.pattern, undefined);
		const inPlace = await journalOf("evolve", RECORDED.inPlaceEvolve.facts);
		await assert.rejects(
			runSnapshotAndTail({ ...base, runtime: runtime(inPlace, "evolve") }),
			refused("in-place-evolve"),
		);
		const port = {
			snapshot: () => ({ ref: "snap", takenAt: NOW }),
			applyPhase: () => {
				throw new Error("a copy migration's journal ran an in-place phase");
			},
			verify: () => [],
			restore: () => {},
		};
		await assert.rejects(
			runInPlaceEvolve({
				port,
				plan: {
					migrationId: "m",
					expand: ["x"],
					backfill: ["y"],
					contract: ["z"],
					verify: { afterBackfill: "q" },
				},
				journal: copy,
				clock: () => NOW,
				compatGate: () => ({
					gateId: "g",
					consumersOnLegacySchema: [],
					verifiedAt: NOW,
				}),
			}),
			refused("snapshot-and-tail"),
		);
		assert.equal(
			(await copy.load("m")).length,
			RECORDED.snapshotAndTail.facts.length,
		);
		assert.equal(
			(await inPlace.load("evolve")).length,
			RECORDED.inPlaceEvolve.facts.length,
		);
	});

	test("the recorded in-place run resumes where it stopped, as the in-place migration it was", async () => {
		const journal = await journalOf("evolve", RECORDED.inPlaceEvolve.facts);
		const calls: string[] = [];
		const done = await runInPlaceEvolve({
			port: {
				snapshot: () => ({ ref: "snap-2", takenAt: NOW }),
				applyPhase: (phase, statements) => {
					calls.push(phase);
					return { phase, statements: statements.length, changes: 0 };
				},
				verify: () => [],
				restore: () => {},
			},
			plan: {
				migrationId: "evolve",
				expand: ["ADD email_new"],
				backfill: ["FILL email_new"],
				contract: ["DROP email"],
				verify: { afterBackfill: "SELECT 1" },
			},
			journal,
			clock: () => NOW,
			compatGate: () => ({
				gateId: "g",
				consumersOnLegacySchema: [],
				verifiedAt: NOW,
			}),
		});
		assert.equal(done.status, "completed");
		assert.deepEqual(calls, ["contract"]);
		assert.equal(done.snapshot?.ref, "snap-1");
	});
});
