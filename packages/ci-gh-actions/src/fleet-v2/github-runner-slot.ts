import type { RunnerSlot, RunnerSlotState } from "@hobo/ci/fleet-v2";
import { z } from "zod";
import type { GithubTransport } from "../github.js";

export interface RunnerSlotStore {
	runnerSlot(id: string): Promise<RunnerSlot | undefined>;
	transitionRunnerSlot(
		id: string,
		expected: RunnerSlotState,
		next: RunnerSlotState,
		externalRunnerId?: string,
	): Promise<RunnerSlot>;
	quarantineRunnerSlot(
		id: string,
		expected: RunnerSlotState,
	): Promise<RunnerSlot>;
}

const runnerList = z.strictObject({
	runners: z.array(
		z
			.strictObject({
				id: z.number().int().positive(),
				name: z.string(),
				labels: z.array(z.object({ name: z.string() }).passthrough()),
			})
			.passthrough(),
	),
});

const jitConfiguration = z.strictObject({
	encoded_jit_config: z.string().min(1),
	runner: z.strictObject({
		id: z.number().int().positive(),
		name: z.string().min(1),
	}),
});

const repository = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u);
const identifier = z.string().trim().min(1).max(200);

export type GithubRunnerSlotScope = Readonly<{
	installationId: number;
	repository: string;
	runnerGroupId: number;
	labels: readonly string[];
}>;

export type GithubRunnerSlotResult =
	| Readonly<{
			kind: "created";
			runnerId: number;
			encodedJitConfig: string;
	  }>
	| Readonly<{ kind: "adopted"; runnerId: number }>;

export type GithubRunnerSlotErrorCode =
	| "invalid-scope"
	| "slot-not-found"
	| "slot-state"
	| "runner-foreign"
	| "runner-unavailable"
	| "registration-rejected"
	| "registration-uncertain";

export class GithubRunnerSlotError extends Error {
	constructor(readonly code: GithubRunnerSlotErrorCode) {
		super(code);
		this.name = "GithubRunnerSlotError";
	}
}

type GithubRunner = z.infer<typeof runnerList>["runners"][number];

function parseScope(scope: GithubRunnerSlotScope): GithubRunnerSlotScope {
	const parsed = z
		.strictObject({
			installationId: z.number().int().positive(),
			repository,
			runnerGroupId: z.number().int().positive(),
			labels: z.array(identifier).min(1).max(32),
		})
		.safeParse(scope);
	if (!parsed.success) throw new GithubRunnerSlotError("invalid-scope");
	const labels = parsed.data.labels.map((label) => label.toLowerCase());
	if (new Set(labels).size !== labels.length)
		throw new GithubRunnerSlotError("invalid-scope");
	return parsed.data;
}

async function matchingRunners(
	github: GithubTransport,
	scope: GithubRunnerSlotScope,
	runnerName: string,
): Promise<readonly GithubRunner[]> {
	const response = await github.request(
		scope.installationId,
		`/repos/${scope.repository}/actions/runners?name=${encodeURIComponent(runnerName)}&per_page=100`,
	);
	if (!response.ok) throw new GithubRunnerSlotError("runner-unavailable");
	return runnerList
		.parse(await response.json())
		.runners.filter((runner) => runner.name === runnerName);
}

function runnerMatches(
	runner: GithubRunner,
	slot: RunnerSlot,
	labels: readonly string[],
): boolean {
	if (String(runner.id) !== slot.externalRunnerId) return false;
	const present = new Set(
		runner.labels.map((label) => label.name.toLowerCase()),
	);
	return labels.every((label) => present.has(label.toLowerCase()));
}

async function runnerCollision(
	github: GithubTransport,
	scope: GithubRunnerSlotScope,
	runnerName: string,
): Promise<boolean | undefined> {
	try {
		return (await matchingRunners(github, scope, runnerName)).length > 0;
	} catch {
		return undefined;
	}
}

function runnerSlotState(state: string): RunnerSlotState | undefined {
	const parsed = z
		.enum([
			"reserved",
			"provisioning",
			"registered",
			"bound",
			"draining",
			"released",
			"uncertain",
		])
		.safeParse(state);
	return parsed.success ? parsed.data : undefined;
}

async function quarantine(
	store: RunnerSlotStore,
	slot: RunnerSlot,
	code: "runner-foreign" | "registration-uncertain",
): Promise<never> {
	const state = runnerSlotState(slot.state);
	if (!state) throw new GithubRunnerSlotError("slot-state");
	if (state !== "uncertain" && state !== "released")
		await store.quarantineRunnerSlot(slot.id, state);
	throw new GithubRunnerSlotError(code);
}

async function slotFor(
	store: RunnerSlotStore,
	slotId: string,
): Promise<RunnerSlot> {
	const slot = await store.runnerSlot(slotId);
	if (!slot) throw new GithubRunnerSlotError("slot-not-found");
	return slot;
}

export async function reconcileGithubRunnerSlot(options: {
	store: RunnerSlotStore;
	github: GithubTransport;
	slotId: string;
	scope: GithubRunnerSlotScope;
}): Promise<GithubRunnerSlotResult> {
	const scope = parseScope(options.scope);
	const slot = await slotFor(options.store, options.slotId);
	if (
		slot.state !== "provisioning" &&
		slot.state !== "registered" &&
		slot.state !== "bound" &&
		slot.state !== "draining"
	)
		throw new GithubRunnerSlotError("slot-state");
	let runners: readonly GithubRunner[];
	try {
		runners = await matchingRunners(options.github, scope, slot.runnerName);
	} catch {
		return quarantine(options.store, slot, "registration-uncertain");
	}
	const [runner] = runners;
	if (slot.state === "provisioning") {
		if (!slot.externalRunnerId)
			return quarantine(options.store, slot, "registration-uncertain");
		if (
			!runner ||
			runners.length !== 1 ||
			!runnerMatches(runner, slot, scope.labels)
		)
			return quarantine(options.store, slot, "runner-foreign");
		await options.store.transitionRunnerSlot(
			slot.id,
			"provisioning",
			"registered",
			slot.externalRunnerId,
		);
		return { kind: "adopted", runnerId: runner.id };
	}
	if (
		!runner ||
		runners.length !== 1 ||
		!runnerMatches(runner, slot, scope.labels)
	)
		return quarantine(options.store, slot, "runner-foreign");
	return { kind: "adopted", runnerId: runner.id };
}

export async function provisionGithubRunnerSlot(options: {
	store: RunnerSlotStore;
	github: GithubTransport;
	slotId: string;
	scope: GithubRunnerSlotScope;
}): Promise<GithubRunnerSlotResult> {
	const scope = parseScope(options.scope);
	const reserved = await slotFor(options.store, options.slotId);
	if (reserved.state !== "reserved")
		throw new GithubRunnerSlotError("slot-state");
	const slot = await options.store.transitionRunnerSlot(
		reserved.id,
		"reserved",
		"provisioning",
	);
	let existing: readonly GithubRunner[];
	try {
		existing = await matchingRunners(options.github, scope, slot.runnerName);
	} catch {
		return quarantine(options.store, slot, "registration-uncertain");
	}
	if (existing.length > 0)
		return quarantine(options.store, slot, "runner-foreign");

	let response: Response;
	try {
		response = await options.github.request(
			scope.installationId,
			`/repos/${scope.repository}/actions/runners/generate-jitconfig`,
			"POST",
			JSON.stringify({
				name: slot.runnerName,
				runner_group_id: scope.runnerGroupId,
				labels: scope.labels,
				work_folder: "_hobo_work",
			}),
		);
	} catch {
		return quarantine(options.store, slot, "registration-uncertain");
	}
	if (response.status !== 201) {
		if (
			response.status >= 400 &&
			response.status < 500 &&
			response.status !== 408 &&
			response.status !== 429
		) {
			const collision = await runnerCollision(
				options.github,
				scope,
				slot.runnerName,
			);
			if (collision === undefined)
				return quarantine(options.store, slot, "registration-uncertain");
			if (collision) return quarantine(options.store, slot, "runner-foreign");
			await options.store.transitionRunnerSlot(
				slot.id,
				"provisioning",
				"released",
			);
			throw new GithubRunnerSlotError("registration-rejected");
		}
		return quarantine(options.store, slot, "registration-uncertain");
	}

	let created: z.infer<typeof jitConfiguration>;
	try {
		created = jitConfiguration.parse(await response.json());
	} catch {
		return quarantine(options.store, slot, "registration-uncertain");
	}
	if (created.runner.name !== slot.runnerName)
		return quarantine(options.store, slot, "runner-foreign");
	try {
		await options.store.transitionRunnerSlot(
			slot.id,
			"provisioning",
			"registered",
			String(created.runner.id),
		);
	} catch {
		let current: RunnerSlot;
		try {
			current = await slotFor(options.store, slot.id);
		} catch {
			throw new GithubRunnerSlotError("registration-uncertain");
		}
		if (
			current.state !== "registered" ||
			current.externalRunnerId !== String(created.runner.id)
		)
			return quarantine(options.store, current, "registration-uncertain");
	}
	return {
		kind: "created",
		runnerId: created.runner.id,
		encodedJitConfig: created.encoded_jit_config,
	};
}
