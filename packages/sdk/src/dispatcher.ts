import {
	createDispatcherRegistry,
	type DispatcherRegistry,
	type DispatchProviderInput,
} from "@hobo/dispatcher";

import {
	deepFreeze,
	requireNonEmptyString,
	requireRecord,
	SdkDeclarationError,
} from "./errors.js";
import { DISPATCHER_DECLARATION_SCHEMA, RUNNER_SCHEMA } from "./schema.js";

export type RunnerKind = "self-hosted" | "github" | "depot" | "blacksmith";

export interface RunnerDeclaration {
	readonly schema: string;
	readonly kind: RunnerKind;
	readonly providerId: string;
	readonly category: "runner";
	readonly behind?: "relay";
	readonly listUnitCost: number;
	readonly switchingCost: number;
}

export interface RunnerOptions {
	id?: string;
	listUnitCost?: number;
	switchingCost?: number;
}

export interface ParsedRunnerOptions {
	id?: string;
	listUnitCost: number;
	switchingCost: number;
}

export interface SelfHostedRunnerOptions extends RunnerOptions {
	behind?: "relay";
}

export type DispatcherObjective = "min-cost" | "maximize-credits";

export interface DispatcherOptions {
	objective: DispatcherObjective;
}

export interface DispatcherDeclaration {
	readonly schema: string;
	readonly objective: DispatcherObjective;
	readonly engineObjective: "maximize-credits";
	readonly runners: readonly RunnerDeclaration[];
	readonly registry: DispatcherRegistry;
}

function nonNegative(
	declaration: string,
	path: string,
	value: RunnerOptions["listUnitCost"],
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) {
		throw new SdkDeclarationError(
			declaration,
			path,
			"must be a non-negative number",
		);
	}
	return value;
}

export function parseRunnerOptions(
	options: RunnerOptions,
): ParsedRunnerOptions {
	requireRecord("runner", "options", options);
	const id =
		options.id === undefined
			? undefined
			: requireNonEmptyString("runner", "options.id", options.id);
	const parsed: ParsedRunnerOptions = {
		listUnitCost: nonNegative(
			"runner",
			"options.listUnitCost",
			options.listUnitCost,
			0,
		),
		switchingCost: nonNegative(
			"runner",
			"options.switchingCost",
			options.switchingCost,
			0,
		),
	};
	if (id !== undefined) parsed.id = id;
	return parsed;
}

function makeRunner(
	kind: RunnerKind,
	options: RunnerOptions = {},
	behind?: "relay",
): RunnerDeclaration {
	const parsed = parseRunnerOptions(options);
	const providerId = parsed.id ?? `runner.${kind}`;
	const declaration = {
		schema: RUNNER_SCHEMA,
		kind,
		providerId,
		category: "runner" as const,
		listUnitCost: parsed.listUnitCost,
		switchingCost: parsed.switchingCost,
	};
	return behind === undefined
		? deepFreeze(declaration)
		: deepFreeze({ ...declaration, behind });
}

export const runner = Object.freeze({
	selfHosted(options: SelfHostedRunnerOptions = {}): RunnerDeclaration {
		requireRecord("runner.selfHosted", "options", options);
		if (options.behind !== undefined && options.behind !== "relay") {
			throw new SdkDeclarationError(
				"runner.selfHosted",
				"options.behind",
				'must be "relay" when a relay transport is requested',
			);
		}
		return makeRunner("self-hosted", options, options.behind);
	},
	github: (options: RunnerOptions = {}): RunnerDeclaration =>
		makeRunner("github", options),
	depot: (options: RunnerOptions = {}): RunnerDeclaration =>
		makeRunner("depot", options),
	blacksmith: (options: RunnerOptions = {}): RunnerDeclaration =>
		makeRunner("blacksmith", options),
});

export function dispatcher(
	options: DispatcherOptions,
	runners: RunnerDeclaration[],
): DispatcherDeclaration {
	const record = requireRecord("dispatcher", "options", options);
	const objective = requireNonEmptyString(
		"dispatcher",
		"options.objective",
		record.objective,
	);
	if (objective !== "min-cost" && objective !== "maximize-credits") {
		throw new SdkDeclarationError(
			"dispatcher",
			"options.objective",
			'must be "min-cost" or "maximize-credits"',
		);
	}
	if (!Array.isArray(runners) || runners.length === 0) {
		throw new SdkDeclarationError(
			"dispatcher",
			"runners",
			"must be a non-empty array of runner declarations",
		);
	}
	const inputs: DispatchProviderInput[] = runners.map((declaration, index) => {
		if (declaration?.schema !== RUNNER_SCHEMA) {
			throw new SdkDeclarationError(
				"dispatcher",
				`runners[${index}]`,
				"must be authored with the runner.* factories",
			);
		}
		return {
			id: declaration.providerId,
			providerId: declaration.providerId,
			category: "runner",
			registered: true,
			listUnitCost: declaration.listUnitCost,
			switchingCost: declaration.switchingCost,
		};
	});
	const registry = createDispatcherRegistry(inputs);

	return Object.freeze({
		schema: DISPATCHER_DECLARATION_SCHEMA,
		objective,
		engineObjective: "maximize-credits" as const,
		runners: Object.freeze([...runners]),
		registry,
	});
}
