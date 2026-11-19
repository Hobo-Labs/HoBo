import type { CommandModule, CommandResult } from "@hobo/cli";
import { isJsonString } from "./json.js";
import {
	followLocalDeploymentLog,
	readLocalDeploymentLog,
} from "./local-deployment-log.js";

export interface LogsCommandDeps {
	readonly readLog?: typeof readLocalDeploymentLog;
	readonly signal?: AbortSignal;
	readonly pollIntervalMs?: number;
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage_error", code: "HOBO_CLI_USAGE", message };
}

export function createLogsCommand(deps: LogsCommandDeps = {}): CommandModule {
	return {
		run: async ({ context, flags, args, emitProgress }) => {
			if (args.length > 0)
				return usage("hobo logs takes no positional arguments.");
			const rawLimit = flags.subcommandOptions?.lines;
			const limit =
				rawLimit === undefined
					? 200
					: isJsonString(rawLimit) && /^[1-9]\d*$/u.test(rawLimit)
						? Number(rawLimit)
						: NaN;
			if (!Number.isSafeInteger(limit) || limit > 10_000)
				return usage("--lines must be an integer from 1 to 10000.");
			const follow = flags.subcommandOptions?.follow === true;
			if (follow && (flags.json || flags.quiet))
				return usage("--follow cannot be combined with --json or -q.");
			const projectDir = context.projectDir ?? context.cwd;
			const log = await (deps.readLog ?? readLocalDeploymentLog)(
				projectDir,
				limit,
			);
			if (!follow)
				return {
					ok: true,
					status: log.exists ? "tailed" : "no_history",
					code: "HOBO_OK",
					message: log.exists
						? log.lines.join("\n")
						: "No local deployment logs found. Run hobo up to start a deployment.",
					data: {
						command: "logs",
						projectDir,
						lines: log.lines,
						truncated: log.truncated,
					},
				};

			const initialLines = log.partial ? log.lines.slice(0, -1) : log.lines;
			for (const line of initialLines) emitProgress(line);
			if (!log.exists) emitProgress("Waiting for local deployment logs.");
			const controller = new AbortController();
			const stop = () => controller.abort();
			if (!deps.signal) {
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			}
			try {
				await followLocalDeploymentLog({
					projectDir,
					cursor: log.cursor,
					signal: deps.signal ?? controller.signal,
					onLine: emitProgress,
					...(deps.pollIntervalMs === undefined
						? undefined
						: { pollIntervalMs: deps.pollIntervalMs }),
				});
			} finally {
				process.off("SIGINT", stop);
				process.off("SIGTERM", stop);
			}
			return {
				ok: true,
				status: "tailed",
				code: "HOBO_OK",
				data: { command: "logs", projectDir, followed: true },
			};
		},
	};
}
