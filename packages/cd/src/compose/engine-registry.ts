import type { PublisherPort, Realizer } from "../ports.js";
import { ComposeError } from "./errors.js";

export type CdEngineFlowKind =
	| "gitops-pull"
	| "gitops-pr-pull"
	| "agent-pull"
	| "conductor-direct"
	| "release-orchestrator";

export interface CdEngineRegistration {
	readonly name: string;
	readonly provider: string;
	readonly supportedFlows: readonly CdEngineFlowKind[];
	readonly pullBased: boolean;
	readonly publisher?: PublisherPort;
	readonly realizer?: Realizer;
}

export interface CdEngineRegistry {
	register(engine: CdEngineRegistration): void;
	get(name: string): CdEngineRegistration | undefined;
	require(name: string): CdEngineRegistration;
	requireForFlow(name: string, flowKind: CdEngineFlowKind): CdEngineRegistration;
	list(): readonly CdEngineRegistration[];
	listByFlow(flowKind: CdEngineFlowKind): readonly CdEngineRegistration[];
}

const ENGINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function createCdEngineRegistry(
	initial: readonly CdEngineRegistration[] = [],
): CdEngineRegistry {
	const engines = new Map<string, CdEngineRegistration>();

	const register = (engine: CdEngineRegistration): void => {
		if (!ENGINE_NAME_PATTERN.test(engine.name)) {
			throw new ComposeError(
				"compose-engine-missing",
				`invalid CD engine name '${engine.name}'`,
				engine.name,
			);
		}
		if (engine.supportedFlows.length === 0) {
			throw new ComposeError(
				"compose-engine-missing",
				`CD engine '${engine.name}' must declare at least one supported flow`,
				engine.name,
			);
		}
		if (engines.has(engine.name)) {
			throw new ComposeError(
				"compose-engine-duplicate",
				`CD engine '${engine.name}' is already registered`,
				engine.name,
			);
		}
		engines.set(engine.name, {
			...engine,
			supportedFlows: [...new Set(engine.supportedFlows)],
		});
	};

	for (const engine of initial) {
		register(engine);
	}

	return {
		register,
		get(name) {
			return engines.get(name);
		},
		require(name) {
			const engine = engines.get(name);
			if (engine === undefined) {
				throw new ComposeError(
					"compose-engine-missing",
					`CD engine '${name}' is not registered`,
					name,
				);
			}
			return engine;
		},
		requireForFlow(name, flowKind) {
			const engine = engines.get(name);
			if (engine === undefined) {
				throw new ComposeError(
					"compose-engine-missing",
					`CD engine '${name}' is not registered for flow '${flowKind}'`,
					name,
				);
			}
			if (!engine.supportedFlows.includes(flowKind)) {
				throw new ComposeError(
					"compose-engine-missing",
					`CD engine '${name}' does not support flow '${flowKind}'`,
					name,
				);
			}
			return engine;
		},
		list() {
			return [...engines.values()].sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
			);
		},
		listByFlow(flowKind) {
			return [...engines.values()]
				.filter((engine) => engine.supportedFlows.includes(flowKind))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},
	};
}
