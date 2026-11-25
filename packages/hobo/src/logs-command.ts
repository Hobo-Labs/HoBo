import type { CommandModule, DevRuntime } from "@hobo/cli";
import { bootLocalCamp, deploymentIdFor } from "@hobo/cli";

import { createDefaultDevRuntime } from "./compose.js";

export interface LogsCommandDeps {
	// Factory for the runtime-local Camp whose Streamer this command tails.
	// Defaults to the offline hello-bindle DevRuntime.
	readonly runtimeFactory?: () => DevRuntime;
}

// `hobo logs` — live-tail the Camp runtime streams. It boots the runtime-local
// Camp, serves the probe to exercise the component host, and returns the
// component-host event tail mirrored through the Streamer (the frames a live
// `hobo dev` session would print). Read-only and offline — no cloud call, no
// credential. Unlike `hobo dev` (which serves and holds the loop open), this
// captures the current stream tail and returns it.
export function createLogsCommand(deps: LogsCommandDeps = {}): CommandModule {
	return {
		run: async ({ context, flags, emitProgress }) => {
			const factory = deps.runtimeFactory ?? createDefaultDevRuntime;
			const runtime = factory();
			const projectDir = context.projectDir ?? flags.cwd ?? context.cwd;
			const deploymentId = deploymentIdFor(projectDir);

			const boot = await bootLocalCamp(runtime, { deploymentId, emitProgress });
			const lines = boot.events.map((event) => event.type);

			return {
				ok: true,
				status: "tailed",
				code: "HOBO_OK",
				message: `hobo logs: ${lines.length} runtime event(s), ${boot.streamedFrames} streamed frame(s) from ${boot.runtime} (offline)`,
				data: {
					command: "logs",
					deploymentId,
					runtime: boot.runtime,
					offline: boot.offline,
					streamedFrames: boot.streamedFrames,
					events: lines,
					served: boot.served,
				},
			};
		},
	};
}
