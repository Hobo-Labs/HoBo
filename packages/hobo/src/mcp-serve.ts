import type { DeviceClock } from "@hobo/hobo-cd";
import {
	applyEgressToProcess,
	isRemoteBox,
	machineRunner,
	whichOnPath,
} from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";

import { createComposedHoboCli } from "./cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "./credentials-opensesame.js";
import { ownerSecretStoreBindingStore } from "./ci-secret-store.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
	OWNER_HANDOFF_SPECS,
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
import { createFormHealth, createStoreChoiceApp } from "./mcp-store-choice.js";
import { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";
import { createOwnerLinkChannel, type OwnerLinkChannel } from "./owner-link.js";
import {
	createOwnerStoreSessions,
	type OwnerSignIn,
	ownerChannelSignIn,
} from "./owner-store-session.js";

/**
 * The full `hobo-mcp` server, loaded by `bin/hobo-mcp.ts` once it has
 * answered the host's `initialize` (see mcp-handshake.ts).
 */

/**
 * The HoBo MCP server's parts, wired once for the binary and its evals: the
 * owner channel, whose every step is a form in the owner's host asked in the
 * call that needs it; the composed CLI on that channel; the secret capture
 * and store choice apps; and the session they share.
 */
export function composeHoboMcp(options: {
	/** Where the server writes (its notifications go here too). */
	readonly output: NodeJS.WritableStream;
	/** Where the capture connector keeps its non-secret state. */
	readonly projectDir: string;
	/** The owner is not at this machine (a remote dev box). */
	readonly remote: boolean;
	/** The device grant's clock (evals pass a virtual one). */
	readonly clock?: DeviceClock;
	readonly ownerSignIn?: OwnerSignIn;
	readonly ownerLink?: OwnerLinkChannel;
}) {
	// The owner's channel: what they hand over through the capture form waits
	// here, in memory, for the ceremony run through this server.
	// The session exists once the transport starts; prompts go through it.
	let session: McpStdioSession | undefined;
	let capture: ReturnType<typeof createOwnerCaptureApp> | undefined;
	const formHealth = createFormHealth();
	const watchedRequest = () => {
		const request = session?.request;
		return request === undefined ? undefined : formHealth.watch(request);
	};
	/**
	 * The host's forms, when it said at initialize that it shows them and a
	 * capture would really be one: an MCP Apps host gets HoBo's App, and an
	 * owner at this machine the local page, neither of which the run's own
	 * call can show, so the run refuses and the agent's capture shows them.
	 */
	const forms = () =>
		session?.support.formElicitation === true &&
		session.support.apps !== true &&
		options.remote
			? session
			: undefined;
	const owner = createMcpOwnerChannel({
		// Every step that needs the owner is a form in their host, asked in
		// the call that needs it: nothing is relayed through the agent.
		form: (params) =>
			forms() === undefined
				? undefined
				: watchedRequest()?.("elicitation/create", params),
		ask: async (name) => {
			const host = forms();
			if (host === undefined || capture === undefined) return false;
			const outcome = await capture.callTool(
				"capture_secret",
				{ name },
				host.support,
			);
			return outcome.kind === "result" && outcome.result.isError !== true;
		},
		// Prompts go through the session; the run keeps going meanwhile.
		prompt: async (params) => {
			await session?.request?.("elicitation/create", params);
		},
		notify: (method, params) => {
			options.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	const sessions = createOwnerStoreSessions({
		signIn:
			options.ownerSignIn ??
			ownerChannelSignIn({
				owner,
				deps: {
					runCommand: machineRunner(),
					which: (bin) => whichOnPath(bin),
				},
			}),
		...(owner.vault !== undefined ? { kept: owner.vault } : undefined),
	});
	const server = createHoboMcpServer({
		cli: createComposedHoboCli({
			ownerChannel: owner,
			ownerSession: sessions,
			...(options.clock !== undefined ? { clock: options.clock } : undefined),
		}),
	});
	// The secret-capture MCP App (ADR-0179 amendment "Deploy secrets captured
	// by an MCP App into the secret store"): values the owner types go from
	// the form to this process to the store the relay's binding names, and
	// never into a tool result. URL elicitation completion is the one
	// notification this server sends.
	capture = createOwnerCaptureApp({
		owner,
		remote: options.remote,
		elicit: (params) => {
			const request = watchedRequest();
			if (request === undefined)
				return Promise.reject(new Error("the transport is not connected"));
			return request("elicitation/create", params);
		},
		connector: createInfisicalCaptureConnector({
			bindingStore: ownerSecretStoreBindingStore(
				sessions.entries(options.projectDir),
			),
		}),
		notify: (method, params) => {
			options.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	const link = options.ownerLink ?? createOwnerLinkChannel();
	session = createMcpStdioSession(
		capture,
		createStoreChoiceApp({
			sessions,
			link,
			formHealth,
			handOver: (name, value) => {
				const spec = OWNER_HANDOFF_SPECS.find((entry) => entry.name === name);
				const bytes = Buffer.byteLength(value, "utf8");
				if (
					spec === undefined ||
					bytes < spec.minBytes ||
					bytes > spec.maxBytes ||
					/[\r\n]/u.test(value) ||
					(spec.pattern !== undefined && !spec.pattern.test(value))
				)
					return;
				owner.deposit(name, value);
			},
		}),
	);
	const ready = capture;
	return {
		owner,
		server,
		session,
		sessions,
		/** Stop whatever still waits on the owner and close open captures. */
		async close() {
			owner.jobs.close();
			link.close();
			sessions.close();
			await ready.close();
		},
	};
}

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
	const composed = composeHoboMcp({
		output: io.output,
		projectDir: secretCaptureProjectDir(process.cwd(), process.env),
		remote: isRemoteBox(),
	});
	try {
		await serveMcpStdio({
			server: composed.server,
			auth: localOperatorAuth(),
			input: io.input,
			output: io.output,
			session: composed.session,
		});
	} finally {
		// Closes open captures, stops the page and revokes the writer token,
		// and stops any step still waiting on the owner.
		await composed.close();
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
