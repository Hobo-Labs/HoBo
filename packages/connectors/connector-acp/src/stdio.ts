import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { type AgentSandboxPosture, scrubEnvironment } from "./sandbox.js";
import type {
	AcpAgentConnection,
	AcpPermissionRequest,
	AcpPromptContent,
	AcpSessionNotification,
	GovernedAcpClient,
} from "./types.js";

// The stdio transport lane: spawn a vendor agent binary (`claude-code-acp`,
// `gemini --experimental-acp`, ...) under the Executor sandbox posture and
// speak REAL ACP to it over `@agentclientprotocol/sdk`'s ClientSideConnection
// + ndJsonStream. The SDK import is LAZY with a typed gate so the replay
// lane never needs the binary or the wire.

// public-contract: typed gate when @agentclientprotocol/sdk cannot load.
export const ACP_SDK_MISSING = "ACP_SDK_MISSING";
// public-contract: typed failure when the agent subprocess cannot spawn.
export const ACP_AGENT_SPAWN_FAILED = "ACP_AGENT_SPAWN_FAILED";

export class AcpSdkMissingError extends Error {
	readonly code = ACP_SDK_MISSING;
	constructor(cause: string) {
		super(
			`connector-acp: @agentclientprotocol/sdk is not loadable (${cause}) — install it to use the stdio lane.`,
		);
		this.name = "AcpSdkMissingError";
	}
}

export class AcpAgentSpawnError extends Error {
	readonly code = ACP_AGENT_SPAWN_FAILED;
	constructor(command: string, cause: string) {
		super(`connector-acp: failed to spawn agent \`${command}\`: ${cause}`);
		this.name = "AcpAgentSpawnError";
	}
}

type AcpSdk = typeof import("@agentclientprotocol/sdk");
type NdJsonPair = {
	input: Parameters<AcpSdk["ndJsonStream"]>[0];
	output: Parameters<AcpSdk["ndJsonStream"]>[1];
};

async function loadAcpSdk() {
	try {
		return await import("@agentclientprotocol/sdk");
	} catch (error) {
		throw new AcpSdkMissingError(
			error instanceof Error ? error.message : String(error),
		);
	}
}

export interface StdioAgentOptions {
	readonly command: string;
	readonly args?: readonly string[];
	// The parse-enforced sandbox posture — the spawn scrubs the environment
	// to its allowlist and chdirs into the workspace root.
	readonly sandbox: AgentSandboxPosture;
	// The governed client the SDK routes agent callbacks into.
	readonly client: GovernedAcpClient;
}

export interface StdioAgentHandle {
	readonly connection: AcpAgentConnection;
	dispose(): void;
}

// Spawn the agent under the sandbox posture and wire the real ACP client
// connection over its stdio. The returned connection is the same structural
// seam the fixture implements — vendor adapters and conformance tests are
// interchangeable above it.
export async function connectAcpAgentOverStdio(
	options: StdioAgentOptions,
): Promise<StdioAgentHandle> {
	const sdk = await loadAcpSdk();
	const child = spawn(options.command, [...(options.args ?? [])], {
		cwd: options.sandbox.filesystem.root,
		env: scrubEnvironment(options.sandbox),
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (!child.stdin || !child.stdout) {
		throw new AcpAgentSpawnError(options.command, "no stdio pipes");
	}
	child.on("error", () => {
		// Surfaced on the next protocol call as a stream failure; the typed
		// spawn error covers the synchronous cases below.
	});

	const rawPair = {
		input: Writable.toWeb(child.stdin),
		output: Readable.toWeb(child.stdout),
	};
	// SAFETY: Node web streams satisfy the ACP SDK ndJsonStream pair.
	const pair = rawPair as NdJsonPair;
	const stream = sdk.ndJsonStream(pair.input, pair.output);
	const connection = new sdk.ClientSideConnection(
		(_agent) => ({
			requestPermission: (params: AcpPermissionRequest) =>
				options.client.requestPermission(params),
			sessionUpdate: (params: AcpSessionNotification) =>
				options.client.sessionUpdate(params),
		}),
		stream,
	);

	const facade: AcpAgentConnection = {
		initialize: (params) => connection.initialize(params),
		newSession: (params) => connection.newSession(params),
		prompt: (params: { sessionId: string; prompt: AcpPromptContent[] }) =>
			connection.prompt(params),
		cancel: (params) => connection.cancel(params),
	};

	return {
		connection: facade,
		dispose() {
			child.kill("SIGTERM");
		},
	};
}
