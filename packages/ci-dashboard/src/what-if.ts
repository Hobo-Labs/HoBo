import type {
	MachineAdvert,
	RunnerRouteDecision,
	RunnerRouteEvent,
} from "@hobo/ci";
import {
	decideRunnerRoute,
	HOSTED_RUNNER_PROVIDERS,
	machineCandidate,
	NO_ROUTE_FACTS,
	type ParsedRunnerOrder,
	parseRelayJobMessage,
	providerHealthKey,
	RelayRecordRejection,
	type RouteFacts,
	RUNNER_STEP_KEYS,
	type RunnerStepKey,
	relayRouteRequest,
	stepKey,
} from "@hobo/ci/runner-order";

// public-contract: how long after its last advert a machine still counts as online (MACHINE_ADVERT_TTL_MS in @hobo/ci).
export const MACHINE_ONLINE_WINDOW_MS = 90_000;

export function machineIsOnline(advert: MachineAdvert, nowMs: number): boolean {
	return nowMs - advert.lastSeenMs <= MACHINE_ONLINE_WINDOW_MS;
}

export type WhatIfQuestion = Readonly<{
	repository: string;
	labels: ReadonlyMap<RunnerStepKey, string>;
	public: boolean;
	fork: boolean;
	startedBy: string;
	fleetTaking: boolean;
	unhealthy: ReadonlySet<RunnerStepKey>;
	minutesUsedPercent: number | undefined;
}>;

export function orderStepKeys(
	order: ParsedRunnerOrder,
): readonly RunnerStepKey[] {
	return order.steps.flatMap((step) => {
		const key = stepKey(step);
		return key === undefined ? [] : [key];
	});
}

export function blankQuestion(
	repository: string,
	order: ParsedRunnerOrder,
): WhatIfQuestion {
	return {
		repository,
		labels: new Map(orderStepKeys(order).map((key) => [key, ""])),
		public: false,
		fork: false,
		startedBy: "",
		fleetTaking: true,
		unhealthy: new Set(),
		minutesUsedPercent: undefined,
	};
}

export function questionFromRoutes(
	repository: string,
	order: ParsedRunnerOrder,
	routes: readonly RunnerRouteEvent[],
): WhatIfQuestion {
	const blank = blankQuestion(repository, order);
	const latest = routes.find(
		(event) =>
			event.request !== undefined &&
			event.request.repository.toLowerCase() === repository.toLowerCase(),
	)?.request;
	if (!latest) return blank;
	const labels = new Map(blank.labels);
	for (const input of latest.inputs) {
		const key = RUNNER_STEP_KEYS.find((entry) => entry === input.key);
		if (key) labels.set(key, input.labels.join(", "));
	}
	return {
		...blank,
		labels,
		public: !latest.private,
		fork: latest.fork ?? false,
		startedBy: latest.actorId,
	};
}

const INCLUDED_MINUTES = 3000;

function facts(
	question: WhatIfQuestion,
	machines: readonly MachineAdvert[],
	nowMs: number,
): RouteFacts {
	const unhealthy = new Set<string>();
	for (const key of question.unhealthy) {
		for (const label of (question.labels.get(key) ?? "").split(","))
			if (label.trim() !== "") unhealthy.add(providerHealthKey(key, label));
	}
	return {
		...NO_ROUTE_FACTS,
		fleet: {
			enabled: true,
			taking: question.fleetTaking,
			isolated: false,
		},
		machines: machines.map((advert) =>
			machineCandidate(advert, {
				online: machineIsOnline(advert, nowMs),
				ownerCanRead: true,
			}),
		),
		minutes:
			question.minutesUsedPercent === undefined
				? undefined
				: {
						usedMinutes: (INCLUDED_MINUTES * question.minutesUsedPercent) / 100,
						includedMinutes: INCLUDED_MINUTES,
					},
		unhealthy,
	};
}

export function whatIf(
	order: ParsedRunnerOrder,
	question: WhatIfQuestion,
	machines: readonly MachineAdvert[],
	nowMs: number,
): RunnerRouteDecision {
	const message = parseRelayJobMessage(
		JSON.stringify({
			jobId: "what-if",
			planId: "what-if",
			repository: question.repository,
			runId: 1,
			runAttempt: 1,
			job: "what-if",
			event: question.fork ? "pull_request" : "push",
			actorId: question.startedBy,
			triggeringActorId: question.startedBy,
			private: !question.public,
			fork: question.fork,
			inputs: [...question.labels]
				.filter(([, value]) => value.trim() !== "")
				.map(([name, value]) => ({ name, value })),
		}),
	);
	return decideRunnerRoute(
		order,
		relayRouteRequest(message),
		facts(question, machines, nowMs),
	);
}

export type WhatIfRefusal = Readonly<{ refused: string }>;

export type WhatIfAnswer = RunnerRouteDecision | WhatIfRefusal;

export function isWhatIfRefusal(answer: WhatIfAnswer): answer is WhatIfRefusal {
	return "refused" in answer;
}

// public-contract: the GitHub user id rule of relay_job.cue (USER_ID in @hobo/ci).
const GITHUB_USER_ID = /^[0-9]{1,20}$/u;

export function answerWhatIf(
	order: ParsedRunnerOrder,
	question: WhatIfQuestion,
	machines: readonly MachineAdvert[],
	nowMs: number,
): WhatIfAnswer {
	if (question.startedBy !== "" && !GITHUB_USER_ID.test(question.startedBy))
		return {
			refused:
				"Started by must be a GitHub user id: digits only, at most 20 of them, or left blank.",
		};
	try {
		return whatIf(order, question, machines, nowMs);
	} catch (error) {
		if (error instanceof RelayRecordRejection)
			return { refused: `The relay would refuse this job: ${error.message}.` };
		throw error;
	}
}

export function isHostedStep(key: RunnerStepKey): boolean {
	return HOSTED_RUNNER_PROVIDERS.some((provider) => provider === key);
}
