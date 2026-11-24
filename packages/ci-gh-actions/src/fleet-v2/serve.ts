import { pathToFileURL } from "node:url";
import {
	allowsLoopbackHttp,
	serveRelayUntilSignalled,
	startRelayFromEnvironment,
} from "../main.js";
import { createStrictFleetRuntime } from "./runtime.js";

export async function startStrictFleetRelayFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
) {
	const strictFleet = await createStrictFleetRuntime(env, {
		requirePostgres: !allowsLoopbackHttp(env),
	});
	let running: Awaited<ReturnType<typeof startRelayFromEnvironment>>;
	try {
		running = await startRelayFromEnvironment(
			env,
			strictFleet ? { strictFleet } : {},
		);
	} catch (error) {
		await strictFleet?.close();
		throw error;
	}
	let stopping: Promise<{ drained: boolean }> | undefined;
	return {
		...running,
		stop() {
			stopping ??= (async () => {
				try {
					return await running.stop();
				} finally {
					await strictFleet?.close();
				}
			})();
			return stopping;
		},
	};
}

const entry = process.argv[1];
if (
	process.env.HOBO_CI_RELEASE_BUILD !== "1" &&
	entry &&
	import.meta.url === pathToFileURL(entry).href
)
	serveRelayUntilSignalled(() => startStrictFleetRelayFromEnvironment());
