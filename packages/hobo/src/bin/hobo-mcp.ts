#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { isRemoteBox } from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";

import { createComposedHoboCli } from "../cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "../credentials-opensesame.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
} from "../mcp-owner-channel.js";
import {
	createInfisicalCaptureConnector,
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
	// The session exists once the transport starts; prompts go through it.
	let session: McpStdioSession | undefined;
	const owner = createMcpOwnerChannel({
		// A link the owner must open while a run waits (Vercel's device
		// code): the host's own link prompt, since no progress line reaches
		// them through MCP. Not awaited: the run keeps polling meanwhile.
		show: async (url, message) => {
			const request = session?.request;
			if (request === undefined) return;
			await request("elicitation/create", {
				mode: "url",
				elicitationId: `hobo-${randomUUID()}`,
				url,
				message,
			});
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
process.exitCode = wantsOpenSesameRelaunch(process.env)
	? await relaunchMcpUnderOpenSesame(relaunchInputFor(process))
	: await reportingCredentialRefusals(serve);
