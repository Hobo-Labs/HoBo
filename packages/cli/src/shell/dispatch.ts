import { createBuildCommand } from "../commands/build.js";
import { createCodegenCommand } from "../commands/codegen.js";
import { createCollectCommand } from "../commands/collect.js";
import { createDevCommand } from "../commands/dev.js";
import { createDownCommand } from "../commands/down.js";
import { createLoginCommand } from "../commands/login.js";
import { createNewCommand } from "../commands/new.js";
import { createPlanCommand } from "../commands/plan.js";
import { createStubCommand } from "../commands/stub.js";
import { createUpCommand } from "../commands/up.js";
import type { CliContext, CliEnvelope } from "../types/envelope.js";
import { buildEnvelope } from "../types/envelope.js";
import { type ContextFactory, defaultContextFactory } from "./context.js";
import { assertKnownVerb, parseArgv } from "./parse.js";
import {
	type CommandModule,
	type CommandRegistry,
	createCommandRegistry,
} from "./registry.js";
import { type CliRunResult, renderError, renderSuccess } from "./render.js";
import { helpText, projectScopedVerbs, verbHelpText } from "./verbs.js";

export interface CommandInvocation {
	readonly verb: string;
	readonly args: readonly string[];
	readonly flags: ReturnType<typeof parseArgv>["flags"];
	readonly context: CliContext;
}

export interface CreateHoboCliOptions {
	readonly commands?: Record<string, CommandModule>;
	readonly contextFactory?: ContextFactory;
	readonly registry?: CommandRegistry;
}

export interface HoboCli {
	readonly run: (
		argv: readonly string[],
		runOptions?: RunOptions,
	) => Promise<CliRunResult>;
	readonly dispatchCommand: (
		invocation: CommandInvocation,
	) => Promise<CliEnvelope>;
}

export interface RunOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly onProgress?: (message: string) => void;
}

function okText(stdout: string, exitCode = 0): CliRunResult {
	return { exitCode, stdout, stderr: "" };
}

// Default progress renderer: plain lines on stderr (no spinner dependency).
function defaultProgressSink(message: string): void {
	process.stderr.write(`${message}\n`);
}

export function createHoboCli(options: CreateHoboCliOptions = {}): HoboCli {
	const registry =
		options.registry ??
		createCommandRegistry({
			new: createNewCommand(),
			build: createBuildCommand(),
			codegen: createCodegenCommand(),
			collect: createCollectCommand(),
			dev: createDevCommand(),
			stub: createStubCommand(),
			login: createLoginCommand(),
			plan: createPlanCommand(),
			up: createUpCommand(),
			down: createDownCommand(),
			...options.commands,
		});
	const contextFactory = options.contextFactory ?? defaultContextFactory;

	const dispatchCommand = async (
		invocation: CommandInvocation,
		onProgress: (message: string) => void = defaultProgressSink,
	): Promise<CliEnvelope> => {
		assertKnownVerb(invocation.verb);
		const command = registry.get(invocation.verb);
		const result = await command.run({
			context: invocation.context,
			flags: invocation.flags,
			args: invocation.args,
			verb: invocation.verb,
			// Progress lines go to stderr; machine lanes (-q/--json) stay silent.
			emitProgress: (message) => {
				if (invocation.flags.quiet || invocation.flags.json) {
					return;
				}
				onProgress(message);
			},
		});
		return buildEnvelope({
			verb: invocation.verb,
			context: invocation.context,
			result,
		});
	};

	return {
		dispatchCommand,
		async run(argv, runOptions = {}) {
			let request: ReturnType<typeof parseArgv>;
			try {
				request = parseArgv(
					argv,
					runOptions.cwd === undefined ? {} : { cwd: runOptions.cwd },
				);
			} catch (error) {
				return renderError(error, {
					verb: null,
					flags: {
						json: false,
						camp: null,
						cwd: runOptions.cwd ?? process.cwd(),
						verbose: false,
						quiet: false,
						help: false,
						to: null,
						rollback: false,
						seed: false,
						restore: null,
						strategy: null,
						target: null,
						check: false,
						last: false,
						offline: false,
						template: null,
						force: false,
						hold: false,
						runtime: null,
						config: null,
						policies: null,
						request: null,
						init: false,
						once: false,
						serve: false,
						port: null,
						home: null,
						host: null,
						broker: null,
						brokerUri: null,
						anonymous: false,
						temporary: false,
						token: null,
						demo: false,
						demoSeed: null,
						region: null,
						subcommandOptions: {},
					},
				});
			}

			try {
				if ((request.help && !request.verb) || !request.verb) {
					return okText(helpText());
				}

				assertKnownVerb(request.verb);

				if (request.help) {
					return okText(
						verbHelpText(request.verb, {
							implemented: registry.isImplemented(request.verb),
						}),
					);
				}

				const context = await contextFactory({
					cwd: request.cwd,
					env: runOptions.env ?? process.env,
					flags: request.flags,
					verb: request.verb,
					args: request.args,
					requiresProject: projectScopedVerbs.has(request.verb),
				});

				const envelope = await dispatchCommand(
					{
						verb: request.verb,
						args: request.args,
						flags: request.flags,
						context,
					},
					runOptions.onProgress ?? defaultProgressSink,
				);

				return renderSuccess({
					verb: request.verb,
					flags: request.flags,
					context,
					result: envelope,
				});
			} catch (error) {
				return renderError(error, {
					verb: request.verb,
					flags: request.flags,
				});
			}
		},
	};
}

export async function runHobo(
	argv: readonly string[],
	options: RunOptions = {},
): Promise<CliRunResult> {
	return createHoboCli().run(argv, options);
}

export async function dispatchCommand(
	invocation: CommandInvocation,
	options: CreateHoboCliOptions = {},
): Promise<CliEnvelope> {
	return createHoboCli(options).dispatchCommand(invocation);
}
