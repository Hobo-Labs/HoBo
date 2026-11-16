#!/usr/bin/env node
import { isRemoteBox } from "@hobo/hobo-ci";
import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";

import { createComposedHoboCli } from "../cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "../credentials-opensesame.js";
import {
	createMcpOwnerChannel,
	OWNER_HANDOFF_SPECS,
} from "../mcp-owner-channel.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
	secretCaptureProjectDir,
} from "../mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	type McpStdioSession,
	serveMcpStdio,
} from "../mcp-stdio.js";
import { createStoreChoiceApp } from "../mcp-store-choice.js";
import { removeOwnedDirsOnSignals } from "../owned-temp-dir.js";

// The runnable MCP control surface: the composed
// hobo CLI (default LOCAL/MOCKED lane; live lanes stay credential-gated by
// env) exposed over MCP stdio. Every tool call dispatches through the same
// command registry as the `hobo` binary — one surface, two transports.
async function serve(): Promise<number> {
	// The default runtime's throwaway event store is removed on exit; as the
	// entry point, this process has it removed on a signal too.
	removeOwnedDirsOnSignals();
	// The owner's channel: what they hand over through the capture form waits
	// here, in memory, for the ceremony run through this server.
	const owner = createMcpOwnerChannel();
	const server = createHoboMcpServer({
		cli: createComposedHoboCli({ ownerChannel: owner }),
	});
	// The secret-capture MCP App (ADR-0179 amendment "Deploy secrets captured
	// by an MCP App into the secret store"): values the owner types go from
	// the form to this process to the store the relay's binding names, and
	// never into a tool result. URL elicitation completion is the one
	// notification this server sends.
	// The session exists once the transport starts; elicitation goes through it.
	let session: McpStdioSession | undefined;
	const capture = createSecretCaptureApp({
		specs: [...RELAY_SECRET_CAPTURE_SPECS, ...OWNER_HANDOFF_SPECS],
		handoff: async (secret) => owner.deposit(secret.name, secret.reveal()),
		// The owner is elsewhere: no page on this box's 127.0.0.1 for them;
		// the host's own elicitation form asks when it shows no MCP App.
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
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	session = createMcpStdioSession(capture, createStoreChoiceApp());
	try {
		await serveMcpStdio({
			server,
			auth: localOperatorAuth(),
			input: process.stdin,
			output: process.stdout,
			session,
		});
	} finally {
		// Closes open captures, stops the page and revokes the writer token.
		await capture.close();
	}
	return 0;
}

// HOBO_CREDENTIALS=opensesame (ADR-0170): its tools run the same verbs as
// `hobo`, `up` among them, so it relaunches under OpenSesame as `hobo` does,
// stdin and stdout passing through to the relaunched server; it needs
// OPENSESAME_STORE_PASSWORD for that (credentials-opensesame.ts says why). A
// credential refusal when the server is composed is one `hobo:` line and 1.
process.exitCode = wantsOpenSesameRelaunch(process.env)
	? await relaunchMcpUnderOpenSesame(relaunchInputFor(process))
	: await reportingCredentialRefusals(serve);
