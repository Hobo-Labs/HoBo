import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Activity, Workflow } from "effect/workflow";
import {
	AcquireGhMachineSlot,
	GhMachinePool,
	GhMachinePoolState,
	GhMachineSlotUnavailable,
	ReleaseGhMachineSlot,
	toGhMachineSnapshots,
} from "./GhMachinePool.aggregate.js";
import {
	GhLintSandbox,
	GhProtocolRejected,
	GhRunnerProtocol,
	GhSandboxFailed,
} from "./GhRelay.externals.js";
import {
	ClaimGhRelayJob,
	FailGhRelayJob,
	GhJobNotClaimed,
	GhJobNotQueued,
	GhRelayJob,
	RecordGhCheckCompleted,
	RecordGhRelayRouted,
	RecordGhRelayWaiting,
} from "./GhRelayJob.aggregate.js";
import { GhRelayRouter, RouteGhJob } from "./GhRelayRouter.aggregate.js";
import {
	GH_DEFAULT_LINT_TOOLS,
	GhJobContext,
	GhMachineId,
	GhRelayJobId,
	GhRouteSkip,
	GhRunnerLabel,
	GhStepKey,
	NonEmptyReason,
	NonNegativeCount,
} from "./ids.js";

const DEFAULT_PR_TITLE_TYPES = [
	"feat",
	"fix",
	"docs",
	"style",
	"refactor",
	"perf",
	"test",
	"build",
	"ci",
	"chore",
	"revert",
] as const;

const CONVENTIONAL_TITLE = /^([a-z]+)(?:\([^)]+\))?!?:\s+.+/u;

type PrTitleEvaluation = Readonly<{
	passed: boolean;
	note: NonEmptyReason;
}>;

function evaluatePrTitle(
	title: string | null,
	allowedTypes: readonly string[],
): PrTitleEvaluation {
	if (title === null || title.trim() === "") {
		return {
			passed: false,
			note: NonEmptyReason.make("Pull request title is empty."),
		};
	}
	const types =
		allowedTypes.length > 0 ? allowedTypes : [...DEFAULT_PR_TITLE_TYPES];
	const match = CONVENTIONAL_TITLE.exec(title.trim());
	const kind = match?.[1];
	if (kind !== undefined && types.includes(kind)) {
		return {
			passed: true,
			note: NonEmptyReason.make(`Pull request title "${title}" is valid.`),
		};
	}
	return {
		passed: false,
		note: NonEmptyReason.make(
			`Pull request title "${title}" must start with one of: ${types.join(", ")}.`,
		),
	};
}

const RouteReplySchema = Schema.Struct({
	outcome: Schema.Literals(["routed", "waiting", "failed"]),
	step: Schema.NullOr(GhStepKey),
	runnerLabel: Schema.NullOr(GhRunnerLabel),
	machineId: Schema.NullOr(GhMachineId),
	reason: NonEmptyReason,
	skipped: Schema.Array(GhRouteSkip),
	notInOrder: Schema.Array(GhStepKey),
});

const LintResultSchema = Schema.Struct({
	passed: Schema.Boolean,
	summary: NonEmptyReason,
	findingCount: NonNegativeCount,
});

const TaggedFailure = Schema.Struct({ _tag: Schema.NonEmptyString });
const decodeTaggedFailure = Schema.decodeUnknownOption(TaggedFailure);

function reasonOf<E>(cause: Cause.Cause<E>): NonEmptyReason {
	const failure = Cause.findErrorOption(cause);
	if (failure._tag === "Some") {
		const decoded = decodeTaggedFailure(failure.value);
		if (decoded._tag === "Some") return NonEmptyReason.make(decoded.value._tag);
	}
	const pretty = Cause.pretty(cause).trim();
	return NonEmptyReason.make(
		pretty.length > 0 ? pretty : "relay-answer-failed",
	);
}

export class AnswerGhRelayJob extends Domain.Saga(
	"AnswerGhRelayJob",
	{
		key: GhRelayJobId,
		input: {
			context: GhJobContext,
		},
		rejects: [
			GhJobNotQueued,
			GhJobNotClaimed,
			GhMachineSlotUnavailable,
			GhProtocolRejected,
			GhSandboxFailed,
		],
	},
	{
		description:
			"Claim and answer a queued GitHub Actions relay or runner-less check job with machine slot compensation.",
	},
) {}

export const AnswerGhRelayJobLive = AnswerGhRelayJob.toLayer(
	Effect.gen(function* () {
		const jobs = yield* GhRelayJob;
		const router = yield* GhRelayRouter;
		const pool = yield* GhMachinePool;
		const protocol = yield* GhRunnerProtocol;
		const sandbox = yield* GhLintSandbox;

		return Effect.fn(function* ({ key, context }) {
			yield* Workflow.addFinalizer((exit) =>
				Exit.isSuccess(exit)
					? Effect.void
					: Activity.make({
							name: "record-relay-failure",
							execute: jobs
								.send(
									key,
									new FailGhRelayJob({
										reason: reasonOf(exit.cause),
										annotations: [reasonOf(exit.cause)],
									}),
								)
								.pipe(Effect.asVoid),
						}).pipe(Effect.orDie),
			);

			yield* Activity.make({
				name: "claim-relay-job",
				success: Schema.Void,
				error: GhJobNotQueued,
				execute: jobs
					.send(key, new ClaimGhRelayJob({ nodeId: context.claimNodeId }))
					.pipe(Effect.asVoid),
			});

			if (context.checkSteps.length > 0) {
				const annotations: NonEmptyReason[] = [];
				let allPassed = true;

				for (const checkStep of context.checkSteps) {
					if (checkStep.check === "pr-title") {
						const verdict = evaluatePrTitle(
							context.pullRequestTitle,
							checkStep.types,
						);
						annotations.push(verdict.note);
						if (!verdict.passed) allPassed = false;
						continue;
					}
					const tools =
						checkStep.tools.length > 0
							? checkStep.tools
							: [...GH_DEFAULT_LINT_TOOLS];
					for (const tool of tools) {
						const run = yield* Activity.make({
							name: `lint-${tool}`,
							success: LintResultSchema,
							error: GhSandboxFailed,
							execute: sandbox.runTool({
								repository: context.repository,
								tool,
								paths: checkStep.paths,
								network: "none",
							}),
						});
						annotations.push(NonEmptyReason.make(`${tool}: ${run.summary}`));
						if (!run.passed) allPassed = false;
					}
				}

				const summary = NonEmptyReason.make(
					allPassed
						? "All relay checks passed."
						: "One or more relay checks failed.",
				);

				yield* Activity.make({
					name: "answer-check-protocol",
					success: Schema.Boolean,
					error: GhProtocolRejected,
					execute: protocol
						.answerJob({
							accountId: context.accountId,
							repository: context.repository,
							jobId: key,
							conclusion: allPassed ? "succeeded" : "failed",
							runnerLabel: null,
							annotations,
						})
						.pipe(Effect.map((reply) => reply.accepted)),
				});

				yield* Activity.make({
					name: "complete-check-job",
					success: Schema.Void,
					error: GhJobNotClaimed,
					execute: jobs
						.send(
							key,
							new RecordGhCheckCompleted({
								passed: allPassed,
								annotations,
								summary,
							}),
						)
						.pipe(Effect.asVoid),
				});
				return;
			}

			const poolState = yield* Activity.make({
				name: "read-machine-pool",
				success: GhMachinePoolState,
				execute: pool.get(context.accountId),
			});
			const machines = toGhMachineSnapshots(poolState, true);

			const decision = yield* Activity.make({
				name: "route-gh-job",
				success: RouteReplySchema,
				execute: router
					.send(
						context.accountId,
						new RouteGhJob({
							jobId: key,
							context,
							machines: [...machines],
							fleet: { enabled: true, taking: true, isolated: true },
						}),
					)
					.pipe(Effect.map((receipt) => receipt.reply)),
			});

			if (
				decision.outcome === "failed" ||
				decision.step === null ||
				decision.runnerLabel === null
			) {
				yield* Activity.make({
					name: "answer-failed-route",
					success: Schema.Boolean,
					error: GhProtocolRejected,
					execute: protocol
						.answerJob({
							accountId: context.accountId,
							repository: context.repository,
							jobId: key,
							conclusion: "failed",
							runnerLabel: null,
							annotations: [decision.reason],
						})
						.pipe(Effect.map((reply) => reply.accepted)),
				});
				yield* Activity.make({
					name: "mark-route-failed",
					execute: jobs
						.send(
							key,
							new FailGhRelayJob({
								reason: decision.reason,
								annotations: [decision.reason],
							}),
						)
						.pipe(Effect.asVoid),
				});
				return;
			}

			if (decision.outcome === "waiting") {
				yield* Activity.make({
					name: "answer-waiting-route",
					success: Schema.Boolean,
					error: GhProtocolRejected,
					execute: protocol
						.answerJob({
							accountId: context.accountId,
							repository: context.repository,
							jobId: key,
							conclusion: "succeeded",
							runnerLabel: decision.runnerLabel,
							annotations: [decision.reason],
						})
						.pipe(Effect.map((reply) => reply.accepted)),
				});
				yield* Activity.make({
					name: "record-waiting-job",
					success: Schema.Void,
					error: GhJobNotClaimed,
					execute: jobs
						.send(
							key,
							new RecordGhRelayWaiting({
								step: decision.step,
								runnerLabel: decision.runnerLabel,
								machineId: decision.machineId,
								skipped: decision.skipped,
							}),
						)
						.pipe(Effect.asVoid),
				});
				return;
			}

			if (decision.step === "machine" && decision.machineId !== null) {
				const machineId = decision.machineId;
				yield* Activity.make({
					name: "acquire-machine-slot",
					success: GhRunnerLabel,
					error: GhMachineSlotUnavailable,
					execute: pool
						.send(
							context.accountId,
							new AcquireGhMachineSlot({
								machineId,
								jobId: key,
								actorId: context.actorId,
								ownerCanRead: true,
							}),
						)
						.pipe(Effect.map((receipt) => receipt.reply.runsOnLabel)),
				}).pipe(
					AnswerGhRelayJob.withCompensation(() =>
						Activity.make({
							name: "release-machine-slot-compensation",
							execute: pool
								.send(
									context.accountId,
									new ReleaseGhMachineSlot({
										machineId,
										jobId: key,
									}),
								)
								.pipe(Effect.asVoid),
						}),
					),
				);
			}

			yield* Activity.make({
				name: "answer-routed-protocol",
				success: Schema.Boolean,
				error: GhProtocolRejected,
				execute: protocol
					.answerJob({
						accountId: context.accountId,
						repository: context.repository,
						jobId: key,
						conclusion: "succeeded",
						runnerLabel: decision.runnerLabel,
						annotations: [decision.reason],
					})
					.pipe(Effect.map((reply) => reply.accepted)),
			});

			yield* Activity.make({
				name: "record-routed-job",
				success: Schema.Void,
				error: GhJobNotClaimed,
				execute: jobs
					.send(
						key,
						new RecordGhRelayRouted({
							step: decision.step,
							runnerLabel: decision.runnerLabel,
							machineId: decision.machineId,
							skipped: decision.skipped,
							notInOrder: decision.notInOrder,
						}),
					)
					.pipe(Effect.asVoid),
			});
		});
	}),
);
