#!/usr/bin/env node
import { createHoboMcpServer, createSecretCaptureApp } from "@hobo/mcp";

import { createComposedHoboCli } from "../cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "../credentials-opensesame.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
	secretCaptureProjectDir,
} from "../mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	serveMcpStdio,
} from "../mcp-stdio.js";
import { removeOwnedDirsOnSignals } from "../owned-temp-dir.js";

// The runnable MCP control surface (docs/plans/0006 item 3-3): the composed
// hobo CLI (default LOCAL/MOCKED lane; live lanes stay credential-gated by
// env) exposed over MCP stdio. Every tool call dispatches through the same
// command registry as the `hobo` binary — one surface, two transports.
async function serve(): Promise<number> {
	// The default runtime's throwaway event store is removed on exit; as the
	// entry point, this process has it removed on a signal too.
	removeOwnedDirsOnSignals();
	const server = createHoboMcpServer({ cli: createComposedHoboCli() });
	// The secret-capture MCP App (ADR-0179 amendment "Deploy secrets captured
	// by an MCP App into the secret store"): values the owner types go from
	// the form to this process to the store the relay's binding names, and
	// never into a tool result. URL elicitation completion is the one
	// notification this server sends.
	const capture = createSecretCaptureApp({
		specs: RELAY_SECRET_CAPTURE_SPECS,
		connector: createInfisicalCaptureConnector({
			projectDir: secretCaptureProjectDir(process.cwd(), process.env),
		}),
		notify: (method, params) => {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	try {
		await serveMcpStdio({
			server,
			auth: localOperatorAuth(),
			input: process.stdin,
			output: process.stdout,
			session: createMcpStdioSession(capture),
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
