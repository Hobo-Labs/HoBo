import type { CommandModule } from "@hobo/cli";
import { readLocalDeploymentLog } from "./local-deployment-log.js";

export interface LogsCommandDeps {
	readonly readLog?: typeof readLocalDeploymentLog;
}

export function createLogsCommand(deps: LogsCommandDeps = {}): CommandModule {
	return {
		run: async ({ context }) => {
			const projectDir = context.projectDir ?? context.cwd;
			const log = await (deps.readLog ?? readLocalDeploymentLog)(projectDir);
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
		},
	};
}
