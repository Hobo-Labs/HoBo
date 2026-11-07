/**
 * `hobo-code session serve` without `--host`: the resident session browser,
 * on loopback, as the hobo-code bin and the interactive shell both run it.
 * The caller says where it is (`banner`) and closes it.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preferNamedEndpoint } from "./occupancy-endpoints.js";
import { startSessionControlServer } from "./session-control-server.js";

/** The CLI's serve-sessions action: where the sessions are, and the port. */
export interface ServeSessionsAction {
	readonly hoboHome?: string;
	readonly projectRoot?: string;
	readonly port?: number;
}

export interface ServedSessions {
	/** Where the browser, the Evidence report and its controls are. */
	readonly banner: string;
	close(): Promise<void>;
}

export async function serveSessionsLocally(
	action: ServeSessionsAction,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): Promise<ServedSessions> {
	const hoboHome =
		action.hoboHome ??
		(env.HOBO_HOME && env.HOBO_HOME.length > 0
			? env.HOBO_HOME
			: join(env.HOME ?? tmpdir(), ".hobo"));
	const requestedPort =
		action.port ?? Number.parseInt(env.HOBO_CODE_SESSION_PORT ?? "0", 10);
	const server = await startSessionControlServer({
		hoboHome,
		projectRoot: action.projectRoot ?? cwd,
		port:
			Number.isSafeInteger(requestedPort) && requestedPort > 0
				? requestedPort
				: 0,
	});
	const browser = preferNamedEndpoint(server.url, "evidence");
	const report = preferNamedEndpoint(server.reportUrl, "evidence");
	const controls = preferNamedEndpoint(server.controlsUrlTemplate, "evidence");
	return {
		banner: `browser: ${browser}\nevidence report: ${report}\nevidence controls: ${controls}\nhobo dev: HOBO_CODE_EVIDENCE_CONTROLS_URL=${controls}?parentOrigin=<app-origin>\nremote: forward ${new URL(browser).host} through a declared Station machine; the server never binds publicly\n`,
		close: () => server.close(),
	};
}
