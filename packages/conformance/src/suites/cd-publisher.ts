// PublisherPort conformance (plan 0024 D5 publisher mode, D14, I5). A
// publisher writes desired state where an external engine (GitOps) picks it
// up; convergence is known only from observing that engine.
import {
	abortedSignal,
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	runCdAssertions,
} from "./cd-kit.js";
import {
	CD_RECONCILE_STATUS,
	type Outcome,
	type PublisherLike,
	type SetRecordLike,
} from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const PUBLISHER_SUITE = "hobo.cd.publisher/v1";

// public-contract: assertion names of the PublisherPort suite.
export const PUBLISHER_ASSERTIONS = Object.freeze([
	"targetIsDeclared",
	"publishReturnsRevision",
	"publishIsIdempotent",
	"distinctSetsGetDistinctRevisions",
	"notConvergedBeforeEngineSync",
	"convergedAfterEngineSync",
	"abortIsHonoured",
	"revisionAndObservationAreSecretFree",
] as const);
export type PublisherAssertion = (typeof PUBLISHER_ASSERTIONS)[number];

/** The external engine the publisher writes to, as the harness controls it. */
export interface PublisherEngine {
	/** The engine applies the given revision to the target. */
	sync(revision: string): Promise<void>;
	/** Count of revisions written. */
	writes(): number;
}

export interface PublisherHarness<TSet extends SetRecordLike, TResolved, TCtx> {
	readonly subject: string;
	create(): Promise<{
		publisher: PublisherLike<TSet, TResolved, TCtx>;
		engine: PublisherEngine;
	}>;
	/** Desired Set number `n` (distinct content per n) and its resolved form. */
	desired(n: number): Readonly<{ set: TSet; resolved: TResolved }>;
	ctx(): TCtx;
}

export async function runPublisherConformance<
	TSet extends SetRecordLike,
	TResolved,
	TCtx,
>(
	harness: PublisherHarness<TSet, TResolved, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<PublisherAssertion>> {
	const live = () => new AbortController().signal;
	const publish = async (
		publisher: PublisherLike<TSet, TResolved, TCtx>,
		n: number,
		signal: AbortSignal = live(),
	): Promise<Outcome<Readonly<{ revision: string }>>> => {
		const { set, resolved } = harness.desired(n);
		return publisher.publish({ set, resolved, signal }, harness.ctx());
	};
	const revision = async (
		publisher: PublisherLike<TSet, TResolved, TCtx>,
		n: number,
	): Promise<string> => {
		const outcome = await publish(publisher, n);
		check(
			outcome.ok,
			"publish was refused",
			"publish desired state to the target",
		);
		return outcome.ok ? outcome.value.revision : "";
	};
	return runCdAssertions<PublisherAssertion>(
		PUBLISHER_SUITE,
		harness.subject,
		{
			targetIsDeclared: async () => {
				const { publisher } = await harness.create();
				check(
					publisher.target.length > 0,
					"publisher names no target",
					"name the repository or path it writes to",
				);
			},
			publishReturnsRevision: async () => {
				const { publisher, engine } = await harness.create();
				const rev = await revision(publisher, 1);
				check(
					rev.length > 0,
					"publish returned an empty revision",
					"return the written revision",
				);
				check(
					engine.writes() === 1,
					`publish wrote ${engine.writes()} revisions`,
					"one publish, one write",
				);
			},
			publishIsIdempotent: async () => {
				const { publisher, engine } = await harness.create();
				const a = await revision(publisher, 1);
				const b = await revision(publisher, 1);
				check(
					a === b,
					"re-publishing the same Set produced a new revision",
					"publishing the same Set is a no-op (I12)",
				);
				check(
					engine.writes() === 1,
					"re-publishing the same Set wrote again",
					"compare before writing",
				);
			},
			distinctSetsGetDistinctRevisions: async () => {
				const { publisher } = await harness.create();
				const a = await revision(publisher, 1);
				const b = await revision(publisher, 2);
				check(
					a !== b,
					"two different Sets share a revision",
					"a revision identifies the published content",
				);
			},
			notConvergedBeforeEngineSync: async () => {
				const { publisher } = await harness.create();
				const rev = await revision(publisher, 1);
				const seen = await publisher.observe(
					{ set: harness.desired(1).set, revision: rev, signal: live() },
					harness.ctx(),
				);
				check(
					seen.status !== CD_RECONCILE_STATUS.CONVERGED,
					"CONVERGED before the engine synced",
					"publishing is not converging; observe the engine (I5)",
				);
			},
			convergedAfterEngineSync: async () => {
				const { publisher, engine } = await harness.create();
				const rev = await revision(publisher, 1);
				await engine.sync(rev);
				const seen = await publisher.observe(
					{ set: harness.desired(1).set, revision: rev, signal: live() },
					harness.ctx(),
				);
				check(
					seen.status === CD_RECONCILE_STATUS.CONVERGED,
					`status ${seen.status} after the engine synced`,
					"report CONVERGED once the engine applied the revision",
				);
				check(
					seen.setId === harness.desired(1).set.setId,
					"observation names another Set",
					"echo the observed setId",
				);
			},
			abortIsHonoured: async () => {
				const { publisher, engine } = await harness.create();
				let outcome: Outcome<Readonly<{ revision: string }>> | undefined;
				try {
					outcome = await publish(publisher, 1, abortedSignal());
				} catch {
					outcome = undefined;
				}
				check(
					outcome === undefined || !outcome.ok,
					"an aborted publish succeeded",
					"check the signal before writing",
				);
				check(
					engine.writes() === 0,
					"an aborted publish wrote",
					"check the signal before writing",
				);
			},
			revisionAndObservationAreSecretFree: async () => {
				const { publisher, engine } = await harness.create();
				const rev = await revision(publisher, 1);
				await engine.sync(rev);
				checkSecretFree(rev, "the revision");
				checkSecretFree(
					await publisher.observe(
						{ set: harness.desired(1).set, revision: rev, signal: live() },
						harness.ctx(),
					),
					"the observation",
				);
			},
		},
		options,
	);
}
