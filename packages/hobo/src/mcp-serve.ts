import { applyEgressToProcess, isRemoteBox } from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";

import { createComposedHoboCli } from "./cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "./credentials-opensesame.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
} from "./mcp-owner-channel.js";
import {
	createInfisicalCaptureConnector,
	secretCaptureProjectDir,
} from "./mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	type McpStdioSession,
	serveMcpStdio,
} from "./mcp-stdio.js";
import { createStoreChoiceApp } from "./mcp-store-choice.js";
import { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";

/**
 * The full `hobo-mcp` server, loaded by `bin/hobo-mcp.ts` once it has
 * answered the host's `initialize` (see mcp-handshake.ts).
 */

// The runnable MCP control surface: the composed
// hobo CLI (default LOCAL/MOCKED lane; live lanes stay credential-gated by
// env) exposed over MCP stdio. Every tool call dispatches through the same
// command registry as the `hobo` binary — one surface, two transports.
export async function serveHoboMcp(
	io: {
		readonly input: NodeJS.ReadableStream;
		readonly output: NodeJS.WritableStream;
	} = { input: process.stdin, output: process.stdout },
): Promise<number> {
	// The default runtime's throwaway event store is removed on exit; as the
	// entry point, this process has it removed on a signal too.
	removeOwnedDirsOnSignals();
	// The box's egress (proxy, bypass list, CA), for every fetch in this
	// process, before anything connects.
	applyEgressToProcess(process.env);
	// The owner's channel: what they hand over through the capture form waits
	// here, in memory, for the ceremony run through this server.
	// The session exists once the transport starts; prompts go through it.
	let session: McpStdioSession | undefined;
	const owner = createMcpOwnerChannel({
		// Prompts go through the session; the run keeps going meanwhile.
		prompt: async (params) => {
			await session?.request?.("elicitation/create", params);
		},
		notify: (method, params) => {
			io.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	const server = createHoboMcpServer({
		cli: createComposedHoboCli({ ownerChannel: owner }),
	});
	// The secret-capture MCP App (ADR-0179 amendment "Deploy secrets captured
	// by an MCP App into the secret store"): values the owner types go from
	// the form to this process to the store the relay's binding names, and
	// never into a tool result. URL elicitation completion is the one
	// notification this server sends.
	const capture = createOwnerCaptureApp({
		owner,
		remote: isRemoteBox(),
		elicit: (params) => {
			const request = session?.request;
			if (request === undefined)
				return Promise.reject(new Error("the transport is not connected"));
			return request("elicitation/create", params);
		},
		connector: createInfisicalCaptureConnector({
			projectDir: secretCaptureProjectDir(process.cwd(), process.env),
		}),
		notify: (method, params) => {
			io.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	session = createMcpStdioSession(capture, createStoreChoiceApp());
	try {
		await serveMcpStdio({
			server,
			auth: localOperatorAuth(),
			input: io.input,
			output: io.output,
			session,
		});
	} finally {
		// Closes open captures, stops the page and revokes the writer token,
		// and stops any step still waiting on the owner.
		owner.jobs.close();
		await capture.close();
	}
	return 0;
}

// HOBO_CREDENTIALS=opensesame (ADR-0170): its tools run the same verbs as
// `hobo`, `up` among them, so it relaunches under OpenSesame as `hobo` does,
// stdin and stdout passing through to the relaunched server; it needs
// OPENSESAME_STORE_PASSWORD for that (credentials-opensesame.ts says why). A
// credential refusal when the server is composed is one `hobo:` line and 1.
export async function runHoboMcp(): Promise<number> {
	return wantsOpenSesameRelaunch(process.env)
		? await relaunchMcpUnderOpenSesame(relaunchInputFor(process))
		: await reportingCredentialRefusals(serveHoboMcp);
}

/** The full server on the given streams, reporting a credential refusal as `hobo:` and 1. */
export function serveHoboMcpOn(io: {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
}): Promise<number> {
	return reportingCredentialRefusals(() => serveHoboMcp(io));
}
