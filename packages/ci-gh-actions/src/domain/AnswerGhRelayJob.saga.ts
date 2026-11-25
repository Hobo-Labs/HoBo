import * as Domain from "@alchemy.run/domain";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
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
	GhRelayRouteFacts,
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
	GhFleetSnapshot,
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

type ProtocolAnswerInput = {
	readonly accountId: GhJobContext["accountId"];
	readonly repository: GhJobContext["repository"];
	readonly jobId: GhRelayJobId;
	readonly conclusion: "succeeded" | "failed";
	readonly runnerLabel: GhRunnerLabel | null;
	readonly annotations: readonly NonEmptyReason[];
};

const decodeGhProtocolRejected = Schema.decodeUnknownOption(GhProtocolRejected);

function confirmProtocolAnswer(
	answerJob: (
		input: ProtocolAnswerInput,
	) => Effect.Effect<{ readonly accepted: boolean }, unknown>,
	input: ProtocolAnswerInput,
): Effect.Effect<void, GhProtocolRejected> {
	return answerJob(input).pipe(
		Effect.flatMap((reply) =>
			reply.accepted
				? Effect.void
				: Effect.fail(
						new GhProtocolRejected({
							reason: NonEmptyReason.make(
								"GitHub refused the relay job answer.",
							),
						}),
					),
		),
		Effect.mapError((error) => {
			if (error instanceof GhProtocolRejected) return error;
			const parsed = decodeGhProtocolRejected(error);
			if (Option.isSome(parsed)) {
				return new GhProtocolRejected({ reason: parsed.value.reason });
			}
			return new GhProtocolRejected({
				reason: NonEmptyReason.make(
					error instanceof Error ? error.message : String(error),
				),
			});
		}),
	);
}

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
		const routeFacts = yield* GhRelayRouteFacts;

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
					success: Schema.Void,
					error: GhProtocolRejected,
					execute: confirmProtocolAnswer(protocol.answerJob, {
						accountId: context.accountId,
						repository: context.repository,
						jobId: key,
						conclusion: allPassed ? "succeeded" : "failed",
						runnerLabel: null,
						annotations,
					}),
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

			const routingFacts = yield* Activity.make({
				name: "load-relay-route-facts",
				success: Schema.Struct({
					fleet: Schema.NullOr(GhFleetSnapshot),
					ownerCanRead: Schema.Boolean,
				}),
				execute: routeFacts.loadFacts({
					accountId: context.accountId,
					repository: context.repository,
					actorId: context.actorId,
				}),
			});

			const readPoolAndRoute = (name: string) =>
				Effect.gen(function* () {
					const poolState = yield* Activity.make({
						name,
						success: GhMachinePoolState,
						execute: pool.get(context.accountId),
					});
					const machines = toGhMachineSnapshots(
						poolState,
						routingFacts.ownerCanRead,
					);
					return yield* Activity.make({
						name: `${name}-route`,
						success: RouteReplySchema,
						execute: router
							.send(
								context.accountId,
								new RouteGhJob({
									jobId: key,
									context,
									machines: [...machines],
									fleet: routingFacts.fleet,
								}),
							)
							.pipe(Effect.map((receipt) => receipt.reply)),
					});
				});

			const decision = yield* readPoolAndRoute("read-machine-pool");

			if (
				decision.outcome === "failed" ||
				decision.step === null ||
				decision.runnerLabel === null
			) {
				yield* Activity.make({
					name: "answer-failed-route",
					success: Schema.Void,
					error: GhProtocolRejected,
					execute: confirmProtocolAnswer(protocol.answerJob, {
						accountId: context.accountId,
						repository: context.repository,
						jobId: key,
						conclusion: "failed",
						runnerLabel: null,
						annotations: [decision.reason],
					}),
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
					success: Schema.Void,
					error: GhProtocolRejected,
					execute: confirmProtocolAnswer(protocol.answerJob, {
						accountId: context.accountId,
						repository: context.repository,
						jobId: key,
						conclusion: "succeeded",
						runnerLabel: decision.runnerLabel,
						annotations: [decision.reason],
					}),
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
				const acquire = pool
					.send(
						context.accountId,
						new AcquireGhMachineSlot({
							machineId,
							jobId: key,
							actorId: context.actorId,
							ownerCanRead: routingFacts.ownerCanRead,
						}),
					)
					.pipe(Effect.map((receipt) => receipt.reply.runsOnLabel));

				const acquireActivity = Activity.make({
					name: "acquire-machine-slot",
					success: GhRunnerLabel,
					error: GhMachineSlotUnavailable,
					execute: acquire,
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

				const acquireExit = yield* acquireActivity.pipe(Effect.exit);
				if (Exit.isFailure(acquireExit)) {
					const rejected = Cause.findErrorOption(acquireExit.cause);
					if (
						rejected._tag !== "Some" ||
						rejected.value._tag !== "GhMachineSlotUnavailable" ||
						rejected.value.reason !== "machine_full"
					) {
						return yield* Effect.failCause(acquireExit.cause);
					}
					const reread = yield* readPoolAndRoute(
						"reread-machine-pool-after-acquire-race",
					);
					if (
						reread.outcome !== "waiting" ||
						reread.step === null ||
						reread.runnerLabel === null
					) {
						return yield* Effect.failCause(acquireExit.cause);
					}
					yield* Activity.make({
						name: "answer-waiting-after-acquire-race",
						success: Schema.Void,
						error: GhProtocolRejected,
						execute: confirmProtocolAnswer(protocol.answerJob, {
							accountId: context.accountId,
							repository: context.repository,
							jobId: key,
							conclusion: "succeeded",
							runnerLabel: reread.runnerLabel,
							annotations: [reread.reason],
						}),
					});
					yield* Activity.make({
						name: "record-waiting-after-acquire-race",
						success: Schema.Void,
						error: GhJobNotClaimed,
						execute: jobs
							.send(
								key,
								new RecordGhRelayWaiting({
									step: reread.step,
									runnerLabel: reread.runnerLabel,
									machineId: reread.machineId ?? machineId,
									skipped: reread.skipped,
								}),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}
			}

			yield* Activity.make({
				name: "answer-routed-protocol",
				success: Schema.Void,
				error: GhProtocolRejected,
				execute: confirmProtocolAnswer(protocol.answerJob, {
					accountId: context.accountId,
					repository: context.repository,
					jobId: key,
					conclusion: "succeeded",
					runnerLabel: decision.runnerLabel,
					annotations: [decision.reason],
				}),
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
