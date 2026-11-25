import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
	AcquireGhMachineSlot,
	AnswerGhRelayJob,
	ClearGhProviderHealth,
	ConnectGhMachine,
	EpochMs,
	formatGhRunsOn,
	type GH_LINT_TOOLS,
	GhAccountId,
	GhAccountStatusView,
	GhActorId,
	GhAdvertKeyId,
	GhCheckMixedStepsRefused,
	GhDeliveryId,
	GhJobAutoRetryRecorded,
	GhLintSandbox,
	GhMachineConnected,
	GhMachineId,
	GhMachinePaused,
	GhMachinePool,
	GhMachineRemoved,
	GhMachineResumed,
	GhMachineSlotAcquired,
	GhMachineSlotReleased,
	GhMachineSlotUnavailable,
	GhMachineTakenOver,
	GhMinutesUsageSynced,
	GhProtocolRejected,
	GhProviderHealthCleared,
	GhProviderMissRecorded,
	GhProviderSpendSynced,
	GhRelay,
	GhRelayActivityView,
	GhRelayCheckCompleted,
	GhRelayHandlers,
	GhRelayJob,
	GhRelayJobClaimed,
	GhRelayJobFailed,
	GhRelayJobId,
	GhRelayJobQueued,
	GhRelayJobRouted,
	GhRelayJobWaiting,
	GhRelayNodeId,
	GhRelayRouteFacts,
	GhRelayRouter,
	GhRepoSlug,
	GhRetryDisabled,
	GhRetryLimitReached,
	GhRouteDecisionRecorded,
	GhRunnerLabel,
	type GhRunnerOrderConfig,
	GhRunnerOrderConfigured,
	GhRunnerProtocol,
	GhStaleAdvertKey,
	isGhProviderLabel,
	isGhRunnerLabelToken,
	NonEmptyReason,
	NonNegativeCents,
	NonNegativeCount,
	NonNegativeMinutes,
	PauseGhMachine,
	PercentLimit,
	PositiveRunId,
	PositiveSlots,
	parseGhRelayInputs,
	parseGhRunsOn,
	QueueGhRelayJob,
	RecordGhProviderMiss,
	RemoveGhMachine,
	RequestGhJobAutoRetry,
	ResumeGhMachine,
	RouteGhJob,
	SyncGhMinutesUsage,
	SyncGhProviderSpend,
	VerifyGhMachineAdvert,
} from "../src/domain/index.js";

const DEFAULT_ROUTE_FACTS = {
	fleet: { enabled: true, taking: true, isolated: true },
	ownerCanRead: true,
} as const;

const routeFactsForQueuedJob = () => [
	Story.call(GhRelayRouteFacts.loadFacts, {
		accountId: ACCOUNT,
		repository: REPO,
		actorId: ACTOR_OWNER,
	}),
	Story.succeed(GhRelayRouteFacts.loadFacts, DEFAULT_ROUTE_FACTS),
];

const story = Story.make(GhRelay, {
	layer: GhRelayHandlers,
	stub: [GhRunnerProtocol, GhLintSandbox, GhRelayRouteFacts],
});

const ACCOUNT = GhAccountId.make("acct-gh-1");
const REPO = GhRepoSlug.make("octo/app");
const ACTOR_OWNER = GhActorId.make("42");
const T0 = EpochMs.make(1_763_400_000_000);
const PREDICT_NOW = DateTime.makeUnsafe(T0);
const NODE_ID = "hobo-relay-node";

const routerRef = GhRelayRouter.ref(ACCOUNT);
const poolRef = GhMachinePool.ref(ACCOUNT);

function jobContext(
	overrides: Partial<{
		readonly repository: GhRepoSlug;
		readonly runId: PositiveRunId;
		readonly runAttempt: PositiveRunId;
		readonly jobName: string;
		readonly matrixLeg: string | null;
		readonly isPrivate: boolean;
		readonly isFork: boolean;
		readonly actorId: GhActorId;
		readonly runsOn: readonly GhRunnerLabel[];
		readonly checkSteps: readonly {
			readonly check: "pr-title" | "lint";
			readonly types: readonly string[];
			readonly tools: readonly (typeof GH_LINT_TOOLS)[number][];
			readonly paths: readonly string[];
		}[];
		readonly hasNonCheckSteps: boolean;
		readonly pullRequestTitle: string | null;
		readonly nowMs: EpochMs;
		readonly claimNodeId: GhRelayNodeId;
	}> = {},
) {
	return {
		accountId: ACCOUNT,
		repository: overrides.repository ?? REPO,
		runId: overrides.runId ?? PositiveRunId.make(101),
		runAttempt: overrides.runAttempt ?? PositiveRunId.make(1),
		jobName: overrides.jobName ?? "build",
		matrixLeg: overrides.matrixLeg ?? null,
		isPrivate: overrides.isPrivate ?? true,
		isFork: overrides.isFork ?? false,
		actorId: overrides.actorId ?? ACTOR_OWNER,
		runsOn: overrides.runsOn ?? [
			GhRunnerLabel.make(
				"hobo/machine=self-hosted/depot=auto/github=ubuntu-24.04",
			),
		],
		candidates: [],
		first: null,
		size: null,
		checkSteps: overrides.checkSteps ?? [],
		hasNonCheckSteps: overrides.hasNonCheckSteps ?? false,
		pullRequestTitle: overrides.pullRequestTitle ?? null,
		nowMs: overrides.nowMs ?? T0,
		claimNodeId: overrides.claimNodeId ?? GhRelayNodeId.make("hobo-relay-node"),
	};
}

function defaultOrderEvent() {
	return new GhRunnerOrderConfigured({
		repository: REPO,
		order: {
			steps: [
				{ key: "machine", minutesLimitPercent: null, spendLimitCents: null },
				{
					key: "depot",
					minutesLimitPercent: null,
					spendLimitCents: NonNegativeCents.make(5_000),
				},
				{
					key: "github",
					minutesLimitPercent: PercentLimit.make(80),
					spendLimitCents: null,
				},
			],
			skipUnhealthy: true,
			autoSizeVcpus: 4,
			retry: { enabled: true, target: "other", maxRetries: 2 },
		},
	});
}

describe("@hobo/ci-gh-actions/domain RelayRunner runs-on syntax", () => {
	it("parses and round-trips RelayRunner-like structured runs-on syntax, arrays, and relay inputs", () => {
		expect(parseGhRunsOn("hobo-relay")).toEqual({
			ok: true,
			kind: "relay-check",
			label: GhRunnerLabel.make("hobo-relay"),
		});
		expect(parseGhRunsOn("relayrunner")).toEqual({
			ok: true,
			kind: "relay-check",
			label: GhRunnerLabel.make("relayrunner"),
		});
		expect(parseGhRunsOn("hobo")).toEqual({
			ok: true,
			kind: "fleet",
			label: GhRunnerLabel.make("hobo"),
			candidates: [{ step: "fleet", labels: [GhRunnerLabel.make("hobo")] }],
		});

		const structured = parseGhRunsOn(
			"hobo/first=depot/size=8/machine=self-hosted,macOS,ARM64/depot=auto/runs-on=runs-on=123/runner=8cpu-linux-x64/github=ubuntu-24.04",
		);
		expect(structured).toEqual({
			ok: true,
			kind: "route",
			first: "depot",
			size: 8,
			candidates: [
				{
					step: "machine",
					labels: [
						GhRunnerLabel.make("self-hosted"),
						GhRunnerLabel.make("macOS"),
						GhRunnerLabel.make("ARM64"),
					],
				},
				{ step: "depot", labels: [GhRunnerLabel.make("auto")] },
				{
					step: "runs-on",
					labels: [GhRunnerLabel.make("runs-on=123/runner=8cpu-linux-x64")],
				},
				{ step: "github", labels: [GhRunnerLabel.make("ubuntu-24.04")] },
			],
		});

		if (structured.ok && structured.kind === "route") {
			const formatted = formatGhRunsOn(structured);
			expect(parseGhRunsOn(formatted)).toEqual(structured);
		}

		expect(
			parseGhRunsOn(["hobo", "first=blacksmith", "size=16", "blacksmith=auto"]),
		).toEqual({
			ok: true,
			kind: "route",
			first: "blacksmith",
			size: 16,
			candidates: [
				{ step: "blacksmith", labels: [GhRunnerLabel.make("auto")] },
			],
		});

		expect(parseGhRelayInputs({ github: "${{ vars.RUNNER }}" })).toMatchObject({
			ok: false,
		});
		expect(parseGhRunsOn("ubuntu-24.04")).toMatchObject({ ok: false });
	});
});

describe("@hobo/ci-gh-actions/domain GhRelay Alchemy Domain model", () => {
	it("passes structural Domain.verify(GhRelay) and enforces branded schemas at compile and runtime", () => {
		expect(() => Domain.verify(GhRelay)).not.toThrow();

		// @ts-expect-error GhRepoSlug requires branded slug, not plain string
		const invalidRepo: GhRepoSlug = "octo/app";
		expect(invalidRepo).toBe("octo/app");

		// @ts-expect-error GhAccountId cannot be assigned to GhRelayJobId
		const mismatchedId: GhRelayJobId = ACCOUNT;
		expect(mismatchedId).toBe(ACCOUNT);

		expect(() => Schema.decodeUnknownSync(GhRepoSlug)("not-a-slug")).toThrow();
		expect(() => Schema.decodeUnknownSync(PositiveSlots)(0)).toThrow();
		expect(() => Schema.decodeUnknownSync(PositiveSlots)(33)).toThrow();
		expect(() => Schema.decodeUnknownSync(PercentLimit)(101)).toThrow();
	});

	it("routes structured runs-on matrix legs with first/size/auto and fails over on spend caps (R08, R11, R14)", async () => {
		const jobMatrix1 = GhRelayJob.ref(GhRelayJobId.make("job-matrix-1"));
		const jobMatrix2 = GhRelayJob.ref(GhRelayJobId.make("job-matrix-2"));
		const machineId = GhMachineId.make("m-dev-1");
		const ctx1 = jobContext({
			jobName: "test (node-22)",
			matrixLeg: "node-22",
			runsOn: [
				GhRunnerLabel.make(
					"hobo/first=depot/size=8/machine=self-hosted/depot=auto/github=ubuntu-24.04",
				),
			],
		});
		const ctx2 = jobContext({
			jobName: "test (node-24)",
			matrixLeg: "node-24",
			runsOn: [
				GhRunnerLabel.make(
					"hobo/first=depot/machine=self-hosted/depot=auto/github=ubuntu-24.04",
				),
			],
		});

		await Effect.runPromise(
			story(
				Story.given(routerRef, defaultOrderEvent()),
				Story.given(
					poolRef,
					new GhMachineConnected({
						machineId,
						name: "dev-laptop",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-dev-1"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(2),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-v1"),
						isolatedContainer: false,
						adopted: false,
						connectedAtMs: T0,
					}),
				),
				Story.when(jobMatrix1, new QueueGhRelayJob({ context: ctx1 })),
				...routeFactsForQueuedJob(),
				Story.then(jobMatrix1, new GhRelayJobQueued({ context: ctx1 })),
				Story.then(
					jobMatrix1,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: jobMatrix1.id,
						repository: REPO,
						outcome: "routed",
						step: "depot",
						runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-8"),
						machineId: null,
						reason: NonEmptyReason.make(
							"Routed to depot-ubuntu-24.04-8 (depot).",
						),
						skipped: [],
						notInOrder: [],
						decidedAtMs: T0,
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: jobMatrix1.id,
					conclusion: "succeeded",
					runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-8"),
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					jobMatrix1,
					new GhRelayJobRouted({
						step: "depot",
						runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-8"),
						machineId: null,
						skipped: [],
						notInOrder: [],
					}),
				),
				Story.when(
					routerRef,
					new SyncGhProviderSpend({
						provider: "depot",
						spentCents: NonNegativeCents.make(5_000),
					}),
				),
				Story.then(
					routerRef,
					new GhProviderSpendSynced({
						provider: "depot",
						spentCents: NonNegativeCents.make(5_000),
					}),
				),
				Story.when(jobMatrix2, new QueueGhRelayJob({ context: ctx2 })),
				...routeFactsForQueuedJob(),
				Story.then(jobMatrix2, new GhRelayJobQueued({ context: ctx2 })),
				Story.then(
					jobMatrix2,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: jobMatrix2.id,
						repository: REPO,
						outcome: "routed",
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-dev-1"),
						machineId,
						reason: NonEmptyReason.make(
							"Routed to hobo-machine-m-dev-1 (machine dev-laptop).",
						),
						skipped: [
							{ step: "depot", reason: "spend_limit", detail: "5000/5000" },
						],
						notInOrder: [],
						decidedAtMs: T0,
					}),
				),
				Story.then(
					poolRef,
					new GhMachineSlotAcquired({
						machineId,
						jobId: jobMatrix2.id,
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-dev-1"),
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: jobMatrix2.id,
					conclusion: "succeeded",
					runnerLabel: GhRunnerLabel.make("hobo-machine-m-dev-1"),
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					jobMatrix2,
					new GhRelayJobRouted({
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-dev-1"),
						machineId,
						skipped: [
							{ step: "depot", reason: "spend_limit", detail: "5000/5000" },
						],
						notInOrder: [],
					}),
				),
				Story.view(GhRelayActivityView, jobMatrix1, {
					_tag: "Routed",
					accountId: ACCOUNT,
					repository: REPO,
					step: "depot",
					runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-8"),
					machineId: null,
					skipped: [],
					notInOrder: [],
				}),
			),
		);
	});

	it("blocks public/fork jobs from personal machines, trips and clears circuit breakers, and honors GitHub minutes limits (M03, X02, R07, R09)", async () => {
		const jobPublic = GhRelayJob.ref(GhRelayJobId.make("job-public-1"));
		const jobRecovered = GhRelayJob.ref(GhRelayJobId.make("job-recovered-1"));
		const machineId = GhMachineId.make("m-personal-1");
		const ctxPublic = jobContext({
			isPrivate: false,
			isFork: true,
			runsOn: [
				GhRunnerLabel.make(
					"hobo/machine=self-hosted/depot=auto/github=ubuntu-24.04",
				),
			],
			nowMs: EpochMs.make(T0 + 5_000),
		});
		const ctxRecovered = jobContext({
			isPrivate: false,
			runsOn: [GhRunnerLabel.make("hobo/depot=auto/github=ubuntu-24.04")],
			nowMs: EpochMs.make(T0 + 10_000),
		});

		await Effect.runPromise(
			story(
				Story.given(routerRef, defaultOrderEvent()),
				Story.given(
					poolRef,
					new GhMachineConnected({
						machineId,
						name: "dev-laptop",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-personal-1"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(2),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-v1"),
						isolatedContainer: false,
						adopted: false,
						connectedAtMs: T0,
					}),
				),
				Story.when(
					routerRef,
					new RecordGhProviderMiss({ provider: "depot", atMs: T0 }),
				),
				Story.then(
					routerRef,
					new GhProviderMissRecorded({ provider: "depot", atMs: T0 }),
				),
				Story.when(
					routerRef,
					new RecordGhProviderMiss({
						provider: "depot",
						atMs: EpochMs.make(T0 + 1_000),
					}),
				),
				Story.then(
					routerRef,
					new GhProviderMissRecorded({
						provider: "depot",
						atMs: EpochMs.make(T0 + 1_000),
					}),
				),
				Story.when(
					routerRef,
					new RecordGhProviderMiss({
						provider: "depot",
						atMs: EpochMs.make(T0 + 2_000),
					}),
				),
				Story.then(
					routerRef,
					new GhProviderMissRecorded({
						provider: "depot",
						atMs: EpochMs.make(T0 + 2_000),
					}),
				),
				Story.when(jobPublic, new QueueGhRelayJob({ context: ctxPublic })),
				...routeFactsForQueuedJob(),
				Story.then(jobPublic, new GhRelayJobQueued({ context: ctxPublic })),
				Story.then(
					jobPublic,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: jobPublic.id,
						repository: REPO,
						outcome: "routed",
						step: "github",
						runnerLabel: GhRunnerLabel.make("ubuntu-24.04"),
						machineId: null,
						reason: NonEmptyReason.make("Routed to ubuntu-24.04 (github)."),
						skipped: [
							{ step: "machine", reason: "public_repository", detail: "" },
							{
								step: "depot",
								reason: "provider_unhealthy",
								detail: "depot",
							},
						],
						notInOrder: [],
						decidedAtMs: EpochMs.make(T0 + 5_000),
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: jobPublic.id,
					conclusion: "succeeded",
					runnerLabel: GhRunnerLabel.make("ubuntu-24.04"),
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					jobPublic,
					new GhRelayJobRouted({
						step: "github",
						runnerLabel: GhRunnerLabel.make("ubuntu-24.04"),
						machineId: null,
						skipped: [
							{ step: "machine", reason: "public_repository", detail: "" },
							{
								step: "depot",
								reason: "provider_unhealthy",
								detail: "depot",
							},
						],
						notInOrder: [],
					}),
				),
				Story.when(routerRef, new ClearGhProviderHealth({ provider: "depot" })),
				Story.then(
					routerRef,
					new GhProviderHealthCleared({ provider: "depot" }),
				),
				Story.when(
					routerRef,
					new SyncGhMinutesUsage({
						usedMinutes: NonNegativeMinutes.make(1_800),
						includedMinutes: NonNegativeMinutes.make(2_000),
						burnPerHour: NonNegativeMinutes.make(200),
					}),
				),
				Story.then(
					routerRef,
					new GhMinutesUsageSynced({
						usedMinutes: NonNegativeMinutes.make(1_800),
						includedMinutes: NonNegativeMinutes.make(2_000),
						burnPerHour: NonNegativeMinutes.make(200),
					}),
				),
				Story.when(
					jobRecovered,
					new QueueGhRelayJob({ context: ctxRecovered }),
				),
				...routeFactsForQueuedJob(),
				Story.then(
					jobRecovered,
					new GhRelayJobQueued({ context: ctxRecovered }),
				),
				Story.then(
					jobRecovered,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: jobRecovered.id,
						repository: REPO,
						outcome: "routed",
						step: "depot",
						runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-4"),
						machineId: null,
						reason: NonEmptyReason.make(
							"Routed to depot-ubuntu-24.04-4 (depot).",
						),
						skipped: [],
						notInOrder: [],
						decidedAtMs: EpochMs.make(T0 + 10_000),
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: jobRecovered.id,
					conclusion: "succeeded",
					runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-4"),
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					jobRecovered,
					new GhRelayJobRouted({
						step: "depot",
						runnerLabel: GhRunnerLabel.make("depot-ubuntu-24.04-4"),
						machineId: null,
						skipped: [],
						notInOrder: [],
					}),
				),
			),
		);
	});

	it("enforces machine takeover key rotation, slot release compensation, and pause/resume/remove lifecycle (M06, M07, M08, X01)", async () => {
		const machineId = GhMachineId.make("m-takeover");
		const compJob = GhRelayJob.ref(GhRelayJobId.make("job-comp-1"));
		const ctxComp = jobContext({
			runsOn: [GhRunnerLabel.make("hobo/machine=self-hosted")],
		});

		await Effect.runPromise(
			story(
				Story.given(
					routerRef,
					new GhRunnerOrderConfigured({
						repository: REPO,
						order: {
							steps: [
								{
									key: "machine",
									minutesLimitPercent: null,
									spendLimitCents: null,
								},
							],
							skipUnhealthy: true,
							autoSizeVcpus: 2,
							retry: { enabled: true, target: "other", maxRetries: 2 },
						},
					}),
				),
				Story.when(
					poolRef,
					new ConnectGhMachine({
						machineId,
						name: "workstation",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-old"),
						isolatedContainer: true,
						adopted: false,
						nowMs: T0,
					}),
				),
				Story.then(
					poolRef,
					new GhMachineConnected({
						machineId,
						name: "workstation",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-old"),
						isolatedContainer: true,
						adopted: false,
						connectedAtMs: T0,
					}),
				),
				Story.when(
					poolRef,
					new ConnectGhMachine({
						machineId,
						name: "workstation",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-new"),
						isolatedContainer: true,
						adopted: false,
						nowMs: EpochMs.make(T0 + 1_000),
					}),
				),
				Story.then(
					poolRef,
					new GhMachineTakenOver({
						machineId,
						previousKeyId: GhAdvertKeyId.make("key-old"),
						newKeyId: GhAdvertKeyId.make("key-new"),
						takenOverAtMs: EpochMs.make(T0 + 1_000),
					}),
					new GhMachineConnected({
						machineId,
						name: "workstation",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-new"),
						isolatedContainer: true,
						adopted: false,
						connectedAtMs: EpochMs.make(T0 + 1_000),
					}),
				),
				Story.when(
					poolRef,
					new VerifyGhMachineAdvert({
						machineId,
						advertKeyId: GhAdvertKeyId.make("key-old"),
						nowMs: EpochMs.make(T0 + 2_000),
					}),
				),
				Story.rejected(
					new GhStaleAdvertKey({
						machineId,
						rejectedKeyId: GhAdvertKeyId.make("key-old"),
						activeKeyId: GhAdvertKeyId.make("key-new"),
					}),
				),
				Story.when(compJob, new QueueGhRelayJob({ context: ctxComp })),
				...routeFactsForQueuedJob(),
				Story.then(compJob, new GhRelayJobQueued({ context: ctxComp })),
				Story.then(
					compJob,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: compJob.id,
						repository: REPO,
						outcome: "routed",
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
						machineId,
						reason: NonEmptyReason.make(
							"Routed to hobo-machine-m-takeover (machine workstation).",
						),
						skipped: [],
						notInOrder: [],
						decidedAtMs: T0,
					}),
				),
				Story.then(
					poolRef,
					new GhMachineSlotAcquired({
						machineId,
						jobId: compJob.id,
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-takeover"),
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: compJob.id,
				}),
				Story.fail(
					GhRunnerProtocol.answerJob,
					new GhProtocolRejected({
						reason: NonEmptyReason.make("github-503"),
					}),
				),
				Story.then(
					poolRef,
					new GhMachineSlotReleased({
						machineId,
						jobId: compJob.id,
					}),
				),
				Story.then(
					compJob,
					new GhRelayJobFailed({
						reason: NonEmptyReason.make("GhProtocolRejected"),
						annotations: [NonEmptyReason.make("GhProtocolRejected")],
					}),
				),
				Story.saga(AnswerGhRelayJob, compJob, {
					_tag: "Rejected",
					rejection: new GhProtocolRejected({
						reason: NonEmptyReason.make("github-503"),
					}),
				}),
				Story.when(poolRef, new PauseGhMachine({ machineId })),
				Story.then(poolRef, new GhMachinePaused({ machineId })),
				Story.when(poolRef, new ResumeGhMachine({ machineId })),
				Story.then(poolRef, new GhMachineResumed({ machineId })),
				Story.when(poolRef, new RemoveGhMachine({ machineId })),
				Story.then(poolRef, new GhMachineRemoved({ machineId })),
				Story.view(GhAccountStatusView, poolRef, {
					machines: [],
					unhealthyProviders: [],
					routedCount: NonNegativeCount.make(1),
					waitingCount: NonNegativeCount.make(0),
					failedCount: NonNegativeCount.make(0),
					autoRetryCount: NonNegativeCount.make(0),
				}),
			),
		);
	});

	it("waits when the sole machine is busy and enforces deduplicated max-2 auto-retry (M04, R10)", async () => {
		const machineId = GhMachineId.make("m-busy");
		const busyJob = GhRelayJob.ref(GhRelayJobId.make("job-busy-1"));
		const waitJob = GhRelayJob.ref(GhRelayJobId.make("job-wait-1"));
		const ctxBusy = jobContext({
			runsOn: [GhRunnerLabel.make("hobo/machine=self-hosted")],
		});
		const ctxWait = jobContext({
			runsOn: [GhRunnerLabel.make("hobo/machine=self-hosted")],
		});

		await Effect.runPromise(
			story(
				Story.given(
					routerRef,
					new GhRunnerOrderConfigured({
						repository: REPO,
						order: {
							steps: [
								{
									key: "machine",
									minutesLimitPercent: null,
									spendLimitCents: null,
								},
							],
							skipUnhealthy: true,
							autoSizeVcpus: 2,
							retry: { enabled: true, target: "other", maxRetries: 2 },
						},
					}),
				),
				Story.given(
					poolRef,
					new GhMachineConnected({
						machineId,
						name: "workstation",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-1"),
						isolatedContainer: true,
						adopted: false,
						connectedAtMs: T0,
					}),
				),
				Story.when(busyJob, new QueueGhRelayJob({ context: ctxBusy })),
				...routeFactsForQueuedJob(),
				Story.then(busyJob, new GhRelayJobQueued({ context: ctxBusy })),
				Story.then(
					busyJob,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: busyJob.id,
						repository: REPO,
						outcome: "routed",
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
						machineId,
						reason: NonEmptyReason.make(
							"Routed to hobo-machine-m-busy (machine workstation).",
						),
						skipped: [],
						notInOrder: [],
						decidedAtMs: T0,
					}),
				),
				Story.then(
					poolRef,
					new GhMachineSlotAcquired({
						machineId,
						jobId: busyJob.id,
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, { jobId: busyJob.id }),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					busyJob,
					new GhRelayJobRouted({
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
						machineId,
						skipped: [],
						notInOrder: [],
					}),
				),
				Story.when(waitJob, new QueueGhRelayJob({ context: ctxWait })),
				...routeFactsForQueuedJob(),
				Story.then(waitJob, new GhRelayJobQueued({ context: ctxWait })),
				Story.then(
					waitJob,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.then(
					routerRef,
					new GhRouteDecisionRecorded({
						jobId: waitJob.id,
						repository: REPO,
						outcome: "waiting",
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
						machineId,
						reason: NonEmptyReason.make(
							"Waiting for busy runner hobo-machine-m-busy (machine).",
						),
						skipped: [
							{
								step: "machine",
								reason: "machine_full",
								detail: "workstation",
							},
						],
						notInOrder: [],
						decidedAtMs: T0,
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: waitJob.id,
					runnerLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					waitJob,
					new GhRelayJobWaiting({
						step: "machine",
						runnerLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
						machineId,
						skipped: [
							{
								step: "machine",
								reason: "machine_full",
								detail: "workstation",
							},
						],
					}),
				),
				Story.when(
					routerRef,
					new RequestGhJobAutoRetry({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-1"),
					}),
				),
				Story.then(
					routerRef,
					new GhJobAutoRetryRecorded({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-1"),
						attemptNumber: NonNegativeCount.make(1),
					}),
				),
				Story.when(
					routerRef,
					new RequestGhJobAutoRetry({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-1"),
					}),
				),
				Story.when(
					routerRef,
					new RequestGhJobAutoRetry({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-2"),
					}),
				),
				Story.then(
					routerRef,
					new GhJobAutoRetryRecorded({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-2"),
						attemptNumber: NonNegativeCount.make(2),
					}),
				),
				Story.when(
					routerRef,
					new RequestGhJobAutoRetry({
						repository: REPO,
						runId: PositiveRunId.make(77),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-3"),
					}),
				),
				Story.rejected(
					new GhRetryLimitReached({
						runId: PositiveRunId.make(77),
						jobName: "test",
						retriesUsed: NonNegativeCount.make(2),
						maxRetries: 2,
					}),
				),
				Story.view(GhAccountStatusView, poolRef, {
					machines: [
						{
							machineId,
							name: "workstation",
							runsOnLabel: GhRunnerLabel.make("hobo-machine-m-busy"),
							slots: PositiveSlots.make(1),
							busy: NonNegativeCount.make(1),
							paused: false,
							sharing: "only_me",
							adopted: false,
							takeoverCount: NonNegativeCount.make(0),
						},
					],
					unhealthyProviders: [],
					routedCount: NonNegativeCount.make(1),
					waitingCount: NonNegativeCount.make(1),
					failedCount: NonNegativeCount.make(0),
					autoRetryCount: NonNegativeCount.make(2),
				}),
			),
		);
	});

	it("runs runner-less pr-title and 7-tool sandboxed lint checks with paths and refuses mixed check jobs (C01, C02, X03)", async () => {
		const mixedJob = GhRelayJob.ref(GhRelayJobId.make("job-mixed-1"));
		const checkJob = GhRelayJob.ref(GhRelayJobId.make("job-check-1"));
		const ctxCheck = jobContext({
			runsOn: [GhRunnerLabel.make("hobo-relay")],
			checkSteps: [
				{
					check: "pr-title",
					types: ["feat", "fix"],
					tools: [],
					paths: [],
				},
				{
					check: "lint",
					types: [],
					tools: ["oxfmt", "zizmor"],
					paths: ["packages/**", "!packages/legacy/**"],
				},
			],
			pullRequestTitle: "feat: add 7-tool lint",
		});

		await Effect.runPromise(
			story(
				Story.when(
					mixedJob,
					new QueueGhRelayJob({
						context: jobContext({
							runsOn: [GhRunnerLabel.make("hobo-relay")],
							checkSteps: [
								{
									check: "pr-title",
									types: ["feat", "fix"],
									tools: [],
									paths: [],
								},
							],
							hasNonCheckSteps: true,
							pullRequestTitle: "feat: ok",
						}),
					}),
				),
				Story.rejected(
					new GhCheckMixedStepsRefused({
						reason: NonEmptyReason.make(
							"A relay check job must contain only HoBo check steps and never runs scripts or other steps.",
						),
					}),
				),
				Story.when(checkJob, new QueueGhRelayJob({ context: ctxCheck })),
				Story.then(checkJob, new GhRelayJobQueued({ context: ctxCheck })),
				Story.then(
					checkJob,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.call(GhLintSandbox.runTool, {
					repository: REPO,
					tool: "oxfmt",
					paths: ["packages/**", "!packages/legacy/**"],
					network: "none",
				}),
				Story.succeed(GhLintSandbox.runTool, {
					passed: true,
					summary: NonEmptyReason.make("passed"),
					findingCount: NonNegativeCount.make(0),
				}),
				Story.call(GhLintSandbox.runTool, {
					repository: REPO,
					tool: "zizmor",
					paths: ["packages/**", "!packages/legacy/**"],
					network: "none",
				}),
				Story.succeed(GhLintSandbox.runTool, {
					passed: true,
					summary: NonEmptyReason.make("passed"),
					findingCount: NonNegativeCount.make(0),
				}),
				Story.call(GhRunnerProtocol.answerJob, {
					jobId: checkJob.id,
					conclusion: "succeeded",
					runnerLabel: null,
				}),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: true }),
				Story.then(
					checkJob,
					new GhRelayCheckCompleted({
						passed: true,
						annotations: [
							NonEmptyReason.make(
								'Pull request title "feat: add 7-tool lint" is valid.',
							),
							NonEmptyReason.make("oxfmt: passed"),
							NonEmptyReason.make("zizmor: passed"),
						],
						summary: NonEmptyReason.make("All relay checks passed."),
					}),
				),
				Story.view(GhRelayActivityView, checkJob, {
					_tag: "CheckPassed",
					accountId: ACCOUNT,
					repository: REPO,
					summary: NonEmptyReason.make("All relay checks passed."),
					annotations: [
						NonEmptyReason.make(
							'Pull request title "feat: add 7-tool lint" is valid.',
						),
						NonEmptyReason.make("oxfmt: passed"),
						NonEmptyReason.make("zizmor: passed"),
					],
				}),
			),
		);
	});

	it("validates GhRunnerProtocol and GhLintSandbox ExternalSystem conformance and schema boundaries", async () => {
		const validProtocol: Layer.Layer<
			Layer.Success<ReturnType<typeof GhRunnerProtocol.toLayer>>
		> = GhRunnerProtocol.toLayer(
			Effect.succeed({
				answerJob: () => Effect.succeed({ accepted: true }),
				rerunFailedJobs: () => Effect.succeed({ triggered: true }),
			}),
		);
		const validSandbox: Layer.Layer<
			Layer.Success<ReturnType<typeof GhLintSandbox.toLayer>>
		> = GhLintSandbox.toLayer(
			Effect.succeed({
				runTool: () =>
					Effect.succeed({
						passed: true,
						summary: NonEmptyReason.make("passed"),
						findingCount: NonNegativeCount.make(0),
					}),
			}),
		);

		const protoReply = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* GhRunnerProtocol;
				return yield* client.rerunFailedJobs({
					accountId: ACCOUNT,
					repository: REPO,
					runId: PositiveRunId.make(42),
				});
			}).pipe(Effect.provide(validProtocol)),
		);
		expect(protoReply).toEqual({ triggered: true });

		const sandboxReply = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* GhLintSandbox;
				return yield* client.runTool({
					repository: REPO,
					tool: "zizmor",
					paths: [],
					network: "none",
				});
			}).pipe(Effect.provide(validSandbox)),
		);
		expect(sandboxReply.passed).toBe(true);

		const invalidSandbox = GhLintSandbox.toLayer(
			// @ts-expect-error empty string violates NonEmptyReason schema at ExternalSystem boundary
			Effect.succeed({
				runTool: () =>
					Effect.succeed({
						passed: true,
						summary: "",
						findingCount: NonNegativeCount.make(0),
					}),
			}),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const client = yield* GhLintSandbox;
				return yield* client.runTool({
					repository: REPO,
					tool: "zizmor",
					paths: [],
					network: "none",
				});
			}).pipe(Effect.provide(invalidSandbox)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("rereads routing on any GhMachineSlotUnavailable after acquire and re-acquires before a routed reread answer", () => {
		const machineId = GhMachineId.make("m-toctou");
		const jobId = GhRelayJobId.make("job-toctou");
		const fillerId = GhRelayJobId.make("job-toctou-filler");
		const ctx = jobContext({
			runsOn: [GhRunnerLabel.make("hobo/machine=self-hosted")],
		});
		const machineOnlyOrder = {
			steps: [
				{
					key: "machine" as const,
					minutesLimitPercent: null,
					spendLimitCents: null,
				},
			],
			skipUnhealthy: true,
			autoSizeVcpus: 2,
			retry: {
				enabled: false,
				target: "other" as const,
				maxRetries: 1 as const,
			},
		} satisfies GhRunnerOrderConfig;
		const machineSnapshot = (busy: number) => ({
			machineId,
			name: "studio",
			runsOnLabel: GhRunnerLabel.make("hobo-machine-m-toctou"),
			labels: [GhRunnerLabel.make("self-hosted")],
			slots: PositiveSlots.make(1),
			busy: NonNegativeCount.make(busy),
			paused: false,
			online: true,
			sharing: "only_me" as const,
			ownerId: ACTOR_OWNER,
			ownerCanRead: true,
			isolatedContainer: false,
			adopted: false,
		});
		const routerState = {
			orders: [{ repository: REPO, order: machineOnlyOrder }],
			minutesUsed: null,
			minutesIncluded: NonNegativeMinutes.make(2_000),
			burnPerHour: null,
			providerSpend: [],
			providerHealth: [],
			retries: [],
		};
		const routed = GhRelayRouter.predict(
			routerState,
			new RouteGhJob({
				jobId,
				context: ctx,
				machines: [machineSnapshot(0)],
				fleet: DEFAULT_ROUTE_FACTS.fleet,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(routed._tag).toBe("Accepted");
		if (routed._tag === "Accepted") {
			expect(
				routed.events.find((event) => event._tag === "GhRouteDecisionRecorded"),
			).toMatchObject({ outcome: "routed", step: "machine", machineId });
		}
		const acquireRace = GhMachinePool.predict(
			{
				machines: [
					{
						machineId,
						name: "studio",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-toctou"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						activeJobIds: [fillerId],
						paused: false,
						online: true,
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-race"),
						isolatedContainer: false,
						adopted: false,
						lastSeenMs: T0,
					},
				],
			},
			new AcquireGhMachineSlot({
				machineId,
				jobId,
				actorId: ACTOR_OWNER,
				ownerCanRead: true,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(acquireRace).toMatchObject({
			_tag: "Rejected",
			rejection: new GhMachineSlotUnavailable({
				machineId,
				reason: "machine_full",
			}),
		});
		const waiting = GhRelayRouter.predict(
			routerState,
			new RouteGhJob({
				jobId,
				context: ctx,
				machines: [machineSnapshot(1)],
				fleet: DEFAULT_ROUTE_FACTS.fleet,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(waiting._tag).toBe("Accepted");
		if (waiting._tag === "Accepted") {
			expect(
				waiting.events.find(
					(event) => event._tag === "GhRouteDecisionRecorded",
				),
			).toMatchObject({ outcome: "waiting", step: "machine", machineId });
		}
		const slotReopened = GhRelayRouter.predict(
			routerState,
			new RouteGhJob({
				jobId,
				context: ctx,
				machines: [machineSnapshot(0)],
				fleet: DEFAULT_ROUTE_FACTS.fleet,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(slotReopened._tag).toBe("Accepted");
		if (slotReopened._tag === "Accepted") {
			expect(
				slotReopened.events.find(
					(event) => event._tag === "GhRouteDecisionRecorded",
				),
			).toMatchObject({ outcome: "routed", step: "machine", machineId });
		}
		const acquireAfterReread = GhMachinePool.predict(
			{
				machines: [
					{
						machineId,
						name: "studio",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-toctou"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						activeJobIds: [],
						paused: false,
						online: true,
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-race"),
						isolatedContainer: false,
						adopted: false,
						lastSeenMs: T0,
					},
				],
			},
			new AcquireGhMachineSlot({
				machineId,
				jobId,
				actorId: ACTOR_OWNER,
				ownerCanRead: true,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(acquireAfterReread._tag).toBe("Accepted");
		if (acquireAfterReread._tag === "Accepted") {
			expect(
				acquireAfterReread.events.find(
					(event) => event._tag === "GhMachineSlotAcquired",
				),
			).toMatchObject({ jobId, machineId });
		}
		const pausedRace = GhMachinePool.predict(
			{
				machines: [
					{
						machineId,
						name: "studio",
						runsOnLabel: GhRunnerLabel.make("hobo-machine-m-toctou"),
						labels: [GhRunnerLabel.make("self-hosted")],
						slots: PositiveSlots.make(1),
						activeJobIds: [fillerId],
						paused: true,
						online: true,
						sharing: "only_me",
						ownerId: ACTOR_OWNER,
						advertKeyId: GhAdvertKeyId.make("key-race"),
						isolatedContainer: false,
						adopted: false,
						lastSeenMs: T0,
					},
				],
			},
			new AcquireGhMachineSlot({
				machineId,
				jobId,
				actorId: ACTOR_OWNER,
				ownerCanRead: true,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(pausedRace).toMatchObject({
			_tag: "Rejected",
			rejection: new GhMachineSlotUnavailable({
				machineId,
				reason: "paused",
			}),
		});
	});

	it("fails closed when runner order is not configured for the repository", () => {
		const jobId = GhRelayJobId.make("job-unconfigured-1");
		const ctx = jobContext({
			runsOn: [GhRunnerLabel.make("hobo/github=ubuntu-24.04")],
		});
		const prediction = GhRelayRouter.predict(
			{
				orders: [],
				minutesUsed: null,
				minutesIncluded: NonNegativeMinutes.make(2_000),
				burnPerHour: null,
				providerSpend: [],
				providerHealth: [],
				retries: [],
			},
			new RouteGhJob({
				jobId,
				context: ctx,
				machines: [],
				fleet: null,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(prediction._tag).toBe("Accepted");
		if (prediction._tag === "Accepted") {
			const recorded = prediction.events.find(
				(event) => event._tag === "GhRouteDecisionRecorded",
			);
			expect(recorded).toMatchObject({
				outcome: "failed",
				skipped: [{ step: "github", reason: "not_configured" }],
			});
		}
	});

	it("rejects runner labels that inject runs-on separators", () => {
		expect(isGhRunnerLabelToken("self-hosted")).toBe(true);
		expect(isGhRunnerLabelToken("evil,github=ubuntu-24.04")).toBe(false);
		expect(isGhRunnerLabelToken("evil/github=ubuntu-24.04")).toBe(false);
		expect(isGhRunnerLabelToken("evil=ubuntu-24.04")).toBe(false);
		expect(
			parseGhRelayInputs({
				github: "ubuntu-24.04,depot=auto",
			}),
		).toMatchObject({
			ok: false,
		});
	});

	it("matches hosted provider labels exactly, not by prefix", () => {
		expect(isGhProviderLabel("depot", "depot-ubuntu-24.04")).toBe(true);
		expect(isGhProviderLabel("depot", "depot-ubuntu-24.04-impostor")).toBe(
			false,
		);
		expect(isGhProviderLabel("boat", "boat")).toBe(true);
		expect(isGhProviderLabel("boat", "boat-impostor")).toBe(false);
	});

	it("replies on idempotent acquire with the holding machine runs-on label", () => {
		const machineId = GhMachineId.make("m-idem");
		const jobId = GhRelayJobId.make("job-idem");
		const connected = {
			machines: [
				{
					machineId,
					name: "primary",
					runsOnLabel: GhRunnerLabel.make("hobo-machine-m-idem"),
					labels: [GhRunnerLabel.make("self-hosted")],
					slots: PositiveSlots.make(1),
					activeJobIds: [jobId],
					paused: false,
					online: true,
					sharing: "only_me" as const,
					ownerId: ACTOR_OWNER,
					advertKeyId: GhAdvertKeyId.make("key"),
					isolatedContainer: false,
					adopted: false,
					lastSeenMs: T0,
				},
				{
					machineId: GhMachineId.make("m-other"),
					name: "other",
					runsOnLabel: GhRunnerLabel.make("hobo-machine-m-other"),
					labels: [GhRunnerLabel.make("self-hosted")],
					slots: PositiveSlots.make(1),
					activeJobIds: [],
					paused: false,
					online: true,
					sharing: "only_me" as const,
					ownerId: ACTOR_OWNER,
					advertKeyId: GhAdvertKeyId.make("key-2"),
					isolatedContainer: false,
					adopted: false,
					lastSeenMs: T0,
				},
			],
		};
		const prediction = GhMachinePool.predict(
			connected,
			new AcquireGhMachineSlot({
				machineId,
				jobId,
				actorId: ACTOR_OWNER,
				ownerCanRead: true,
			}),
			{ id: ACCOUNT, now: PREDICT_NOW },
		);
		expect(prediction._tag).toBe("Accepted");
		if (prediction._tag === "Accepted") {
			const acquired = prediction.events.find(
				(event) => event._tag === "GhMachineSlotAcquired",
			);
			expect(acquired).toMatchObject({
				runsOnLabel: GhRunnerLabel.make("hobo-machine-m-idem"),
			});
		}
	});

	it("refuses auto-retry when runner order is not configured", async () => {
		await Effect.runPromise(
			story(
				Story.when(
					routerRef,
					new RequestGhJobAutoRetry({
						repository: REPO,
						runId: PositiveRunId.make(90),
						jobName: "test",
						deliveryId: GhDeliveryId.make("del-nc"),
					}),
				),
				Story.rejected(new GhRetryDisabled({ repository: REPO })),
			),
		);
	});

	it("rejects protocol answers GitHub did not accept", async () => {
		const refusedJob = GhRelayJob.ref(
			GhRelayJobId.make("job-refused-protocol"),
		);
		const ctx = jobContext({
			runsOn: [GhRunnerLabel.make("hobo-relay")],
			checkSteps: [
				{ check: "pr-title", types: ["feat"], tools: [], paths: [] },
			],
			pullRequestTitle: "feat: ok",
		});
		await Effect.runPromise(
			story(
				Story.when(refusedJob, new QueueGhRelayJob({ context: ctx })),
				Story.then(refusedJob, new GhRelayJobQueued({ context: ctx })),
				Story.then(
					refusedJob,
					new GhRelayJobClaimed({
						accountId: ACCOUNT,
						repository: REPO,
						nodeId: NODE_ID,
					}),
				),
				Story.call(GhRunnerProtocol.answerJob, { jobId: refusedJob.id }),
				Story.succeed(GhRunnerProtocol.answerJob, { accepted: false }),
				Story.saga(AnswerGhRelayJob, refusedJob, {
					_tag: "Rejected",
					rejection: new GhProtocolRejected({
						reason: NonEmptyReason.make("GitHub refused the relay job answer."),
					}),
				}),
				Story.then(
					refusedJob,
					new GhRelayJobFailed({
						reason: NonEmptyReason.make("GhProtocolRejected"),
						annotations: [NonEmptyReason.make("GhProtocolRejected")],
					}),
				),
			),
		);
	});
});
