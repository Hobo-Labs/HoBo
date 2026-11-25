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

// `dispatcher()` WRAPS @hobo/dispatcher: runner declarations lower onto
// `DispatchProviderInput` records and the declaration carries the engine's own
// parsed registry (`createDispatcherRegistry`), so `decideDispatch` consumes an
// SDK-authored fleet directly and records `dispatch.Decided` as usual. The
// engine's ranking objective is credit-first cost minimization
// ("maximize-credits"); the SDK accepts the walkthrough's "min-cost" spelling
// and pins the engine objective alongside it.

export type RunnerKind = "self-hosted" | "github" | "depot" | "blacksmith";

// domain-view: authored CI-runner declaration; wire form is RunnerDeclaration in data-models/sdk.proto.
export interface RunnerDeclaration {
	readonly schema: string;
	readonly kind: RunnerKind;
	readonly providerId: string;
	readonly category: "runner";
	/** Optional outbound relay; omitted for direct local self-hosted execution. */
	readonly behind?: "relay";
	readonly listUnitCost: number;
	readonly switchingCost: number;
}

export interface RunnerOptions {
	id?: string;
	listUnitCost?: number;
	switchingCost?: number;
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
	/** The objective spelling @hobo/dispatcher's decideDispatch accepts. */
	readonly engineObjective: "maximize-credits";
	readonly runners: readonly RunnerDeclaration[];
	/** Parsed candidate registry from @hobo/dispatcher — feed it to decideDispatch. */
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

function makeRunner(
	kind: RunnerKind,
	options: RunnerOptions = {},
	behind?: "relay",
): RunnerDeclaration {
	requireRecord("runner", "options", options);
	const providerId =
		options.id !== undefined
			? requireNonEmptyString("runner", "options.id", options.id)
			: `runner.${kind}`;
	const declaration = {
		schema: RUNNER_SCHEMA,
		kind,
		providerId,
		category: "runner" as const,
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
