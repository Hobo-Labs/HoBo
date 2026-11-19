import { create, toJson } from "@bufbuild/protobuf";
import type { CommandModule, CommandResult } from "@hobo/cli";
import { LocalLogRecordSchema } from "./_generated/composition_pb.js";
import { isJsonString } from "./json.js";
import {
	followLocalDeploymentLog,
	localLogResourceNames,
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
			if (args.length > 1)
				return usage("hobo logs accepts at most one resource name.");
			const resource = args[0];
			const linesLimit = flags.subcommandOptions?.lines;
			const tailLimit = flags.subcommandOptions?.tail;
			if (linesLimit !== undefined && tailLimit !== undefined)
				return usage("Use either --lines or --tail, not both.");
			const rawLimit = linesLimit ?? tailLimit;
			const limit =
				rawLimit === undefined
					? 200
					: isJsonString(rawLimit) && /^[1-9]\d*$/u.test(rawLimit)
						? Number(rawLimit)
						: NaN;
			if (!Number.isSafeInteger(limit) || limit > 10_000)
				return usage("--lines and --tail must be an integer from 1 to 10000.");
			const follow = flags.subcommandOptions?.follow === true;
			if (follow && flags.quiet)
				return usage("--follow cannot be combined with -q.");
			const projectDir = context.projectDir ?? context.cwd;
			if (
				resource !== undefined &&
				!(await localLogResourceNames(projectDir)).includes(resource)
			)
				return usage(`Unknown local log resource: ${resource}`);
			const log = await (deps.readLog ?? readLocalDeploymentLog)(
				projectDir,
				limit,
				resource,
			);
			if (!follow)
				return {
					ok: true,
					status: log.exists ? "tailed" : "no_history",
					code: "HOBO_OK",
					message: log.exists
						? log.lines.join("\n")
						: resource === undefined
							? "No local deployment logs found. Run hobo up to start a deployment."
							: `No logs for local resource ${resource}.`,
					data: {
						command: "logs",
						projectDir,
						lines: log.lines,
						records: log.lines.map((message) =>
							toJson(
								LocalLogRecordSchema,
								create(LocalLogRecordSchema, {
									type: "log",
									message,
									resource,
								}),
							),
						),
						truncated: log.truncated,
					},
				};

			const emitLine = (message: string) =>
				emitProgress(
					flags.json
						? JSON.stringify(
								toJson(
									LocalLogRecordSchema,
									create(LocalLogRecordSchema, {
										type: "log",
										message,
										resource,
									}),
								),
							)
						: message,
				);
			const emitGap = (reason: "rotated" | "truncated") =>
				emitProgress(
					flags.json
						? JSON.stringify(
								toJson(
									LocalLogRecordSchema,
									create(LocalLogRecordSchema, { type: "gap", reason }),
								),
							)
						: `[log gap possible: source ${reason}]`,
				);
			const initialLines = log.partial ? log.lines.slice(0, -1) : log.lines;
			for (const line of initialLines) emitLine(line);
			if (!log.exists && !flags.json)
				emitProgress("Waiting for local deployment logs.");
			const controller = new AbortController();
			const stop = () => controller.abort();
			if (!deps.signal) {
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			}
			try {
				await followLocalDeploymentLog({
					projectDir,
					resource,
					cursor: log.cursor,
					signal: deps.signal ?? controller.signal,
					onLine: emitLine,
					onGap: emitGap,
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
