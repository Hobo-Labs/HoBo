import { stubResult } from "../cloud/stub.js";
import type { CliContext, CommandResult } from "../types/envelope.js";
import { UsageError } from "./errors.js";
import { CANONICAL_VERBS, verbNames } from "./verbs.js";

export interface CommandRunInput {
	readonly context: CliContext;
	readonly flags: {
		readonly json: boolean;
		readonly camp: string | null;
		readonly cwd: string;
		readonly verbose: boolean;
		readonly quiet: boolean;
		readonly help: boolean;
		readonly to: string | null;
		readonly rollback: boolean;
		readonly seed: boolean;
		readonly restore: string | null;
		readonly strategy: string | null;
		readonly target: string | null;
		readonly check: boolean;
		readonly last: boolean;
		readonly offline: boolean;
		readonly template: string | null;
		readonly force: boolean;
		readonly hold: boolean;
		readonly runtime: string | null;
		readonly config: string | null;
		readonly policies: string | null;
		readonly request: string | null;
		readonly init: boolean;
		readonly once: boolean;
		readonly serve: boolean;
		readonly port: string | null;
		readonly home: string | null;
		readonly host: string | null;
		readonly broker: string | null;
		readonly brokerUri: string | null;
		readonly anonymous: boolean;
		readonly temporary: boolean;
		readonly token: string | null;
		readonly demo: boolean;
		readonly demoSeed: string | null;
		readonly region: string | null;
		readonly budgetId?: string | null;
	};
	readonly args: readonly string[];
	readonly verb: string;
	readonly emitProgress: (message: string) => void;
}

export interface CommandModule {
	readonly run: (input: CommandRunInput) => Promise<CommandResult>;
	// false when the module is (or behaves as) the registry stub — e.g. a
	// cloud-lane command constructed without an injected runtime. Absent
	// means implemented: an override wired by a composition root is real.
	readonly implemented?: boolean;
}

export interface CommandRegistry {
	readonly get: (verb: string) => CommandModule;
	readonly listVerbs: () => readonly string[];
	readonly isImplemented: (verb: string) => boolean;
}

export function createCommandRegistry(
	overrides: Record<string, CommandModule> = {},
): CommandRegistry {
	const registry = new Map<string, CommandModule>();
	for (const verb of CANONICAL_VERBS) {
		registry.set(verb.name, stubCommand(verb.name));
	}

	for (const [name, command] of Object.entries(overrides)) {
		if (!verbNames.has(name)) {
			throw new UsageError(`Cannot register unknown HoBo verb "${name}".`, [
				"Register only verbs from docs/design/cli-spec.md.",
			]);
		}
		registry.set(name, command);
	}

	return {
		get(verb: string) {
			const command = registry.get(verb);
			if (!command) {
				throw new UsageError(`Cannot dispatch unknown HoBo verb "${verb}".`);
			}
			return command;
		},
		listVerbs() {
			return CANONICAL_VERBS.map((verb) => verb.name);
		},
		isImplemented(verb: string) {
			return registry.get(verb)?.implemented !== false;
		},
	};
}

function stubCommand(verb: string): CommandModule {
	return {
		implemented: false,
		run: async () => stubResult(verb),
	};
}
