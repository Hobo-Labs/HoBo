/**
 * Records for the view tests, built through the same `@hobo/ci` parsers the
 * dashboard reads them with.
 */
import type { MachineAdvert, RunFact, RunnerRouteEvent } from "@hobo/ci";
import {
	parseMachineAdvert,
	parseRunFact,
	parseRunnerOrder,
	parseRunnerRouteEvent,
} from "@hobo/ci/runner-order";
import type { OrderReply } from "../../src/index.js";

export const NOW = 1_794_916_800_000;
export const REPOSITORY = "octo/app";
const MINUTE = 60_000;

export function machine(
	fields: Readonly<{
		id: string;
		name?: string;
		labels?: readonly string[];
		slots?: number;
		busy?: number;
		paused?: boolean;
		lastSeenMs?: number;
		isolation?: "container" | "host";
		signerKeyId?: string;
		sharing?: "only_me" | "anyone";
	}>,
): MachineAdvert {
	return parseMachineAdvert(
		JSON.stringify({
			id: fields.id,
			accountId: "acct-a",
			name: fields.name ?? fields.id,
			runsOn: `hobo-machine-${fields.id}`,
			labels: fields.labels ?? ["self-hosted", "Linux", "X64"],
			os: "linux",
			arch: "x64",
			slots: fields.slots ?? 2,
			busy: fields.busy ?? 0,
			paused: fields.paused ?? false,
			sharing: fields.sharing ?? "anyone",
			ownerId: "42",
			ownerLogin: "octocat",
			lastSeenMs: fields.lastSeenMs ?? NOW - 10_000,
			signerKeyId: fields.signerKeyId ?? "key-1",
			isolation: fields.isolation ?? "container",
		}),
	);
}

export function decided(
	fields: Readonly<{
		minutesAgo: number;
		step: string;
		runner: string;
		outcome?: "routed" | "waiting" | "none";
		reason?: string;
		skipped?: readonly Readonly<{
			key: string;
			reason: string;
			detail?: string;
		}>[];
		inputs?: readonly Readonly<{ key: string; labels: readonly string[] }>[];
		unhealthyFallback?: boolean;
	}>,
): RunnerRouteEvent {
	return parseRunnerRouteEvent(
		JSON.stringify({
			type: "runner.route.Decided",
			accountId: "acct-a",
			atMs: NOW - fields.minutesAgo * MINUTE,
			request: {
				repository: REPOSITORY,
				private: true,
				event: "push",
				runId: 9000 + fields.minutesAgo,
				runAttempt: 1,
				job: "route",
				actorId: "42",
				triggeringActorId: "42",
				inputs: fields.inputs ?? [
					{ key: "machine", labels: ["self-hosted"] },
					{ key: "github", labels: ["ubuntu-24.04"] },
				],
			},
			decision: {
				outcome: fields.outcome ?? "routed",
				runner: fields.runner,
				step: fields.step,
				reason: fields.reason ?? "",
				skipped: (fields.skipped ?? []).map((entry) => ({
					key: entry.key,
					reason: entry.reason,
					detail: entry.detail ?? "",
				})),
				unhealthyFallback: fields.unhealthyFallback ?? false,
			},
			mode: "relay",
			node: "relay-1",
			jobId: `job-${fields.minutesAgo}`,
		}),
	);
}

export function order(json: string, problem = ""): OrderReply {
	return {
		repository: REPOSITORY,
		ref: undefined,
		order: parseRunnerOrder(json),
		problem,
	};
}

/** A failed run attempt whose test step failed, and one that passed. */
export function failedRun(): RunFact {
	return parseRunFact(
		JSON.stringify({
			id: 300,
			attempt: 2,
			repository: REPOSITORY,
			workflow: "CI",
			workflowPath: ".github/workflows/ci.yml",
			event: "pull_request",
			branch: "feature",
			defaultBranch: "main",
			headSha: "a".repeat(40),
			actor: "octocat",
			conclusion: "failure",
			createdAtMs: NOW - 30 * MINUTE,
			completedAtMs: NOW - 20 * MINUTE,
			jobs: [
				{
					id: 3001,
					name: "unit tests",
					labels: ["ubuntu-24.04"],
					runnerName: "GitHub Actions 7",
					conclusion: "failure",
					queuedAtMs: NOW - 30 * MINUTE,
					startedAtMs: NOW - 29 * MINUTE,
					completedAtMs: NOW - 20 * MINUTE,
					billed: true,
					steps: [
						{
							name: "Set up job",
							number: 1,
							conclusion: "success",
							startedAtMs: NOW - 29 * MINUTE,
							completedAtMs: NOW - 29 * MINUTE + 2000,
						},
						{
							name: "Run vitest",
							number: 2,
							conclusion: "failure",
							startedAtMs: NOW - 29 * MINUTE + 2000,
							completedAtMs: NOW - 20 * MINUTE,
						},
					],
				},
				{
					id: 3002,
					name: "lint",
					labels: ["hobo-machine-m-a"],
					conclusion: "success",
					queuedAtMs: NOW - 30 * MINUTE,
					startedAtMs: NOW - 30 * MINUTE + 1000,
					completedAtMs: NOW - 29 * MINUTE,
					billed: false,
					steps: [],
				},
			],
		}),
	);
}
