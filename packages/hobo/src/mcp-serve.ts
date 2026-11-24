import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileSettingsStore } from "@hobo/connect-ui";
import { createTrustedVault } from "@hobo/core";
import type { DeviceClock } from "@hobo/hobo-cd";
import {
	applyEgressToProcess,
	machineRunner,
	scopeRunVault,
	secretStoreLocatorPath,
	whichOnPath,
} from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import { ownerSecretStoreBindingStore } from "./ci-secret-store.js";
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
import { createOwnerPages } from "./mcp-owner-page.js";
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
import {
	createOwnerStoreSessions,
	type OwnerSignIn,
	ownerChannelRelayFolder,
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
}) {
	// The owner's channel: what they hand over through the capture form waits
	// here, in memory, for the ceremony run through this server.
	// The session exists once the transport starts; prompts go through it.
	let session: McpStdioSession | undefined;
	let capture: ReturnType<typeof createOwnerCaptureApp> | undefined;
	const forms = () =>
		session?.support.formElicitation === true && options.remote
			? session
			: undefined;
	const canonical = (cwd: string) => {
		const absolute = path.resolve(cwd);
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	};
	const scope = (family: "ci" | "cd", cwd: string) =>
		`${family}\u0000${canonical(cwd)}`;
	const sessionSettings = new Map<string, Readonly<Record<string, string>>>();
	const sessionChoices = new Set<string>();
	const generations = new Map<string, number>();
	const selectionControllers = new Map<string, AbortController>();
	const pendingWrites = new Map<string, number>();
	const writeQueues = new Map<string, Promise<void>>();
	const writeScope = new AsyncLocalStorage<ReadonlySet<string>>();
	const uncertainWrites = new Set<string>();
	const familyVaults = new Map<string, ReturnType<typeof createTrustedVault>>();
	let closed = false;
	const storeSettingsFor = (family: "ci" | "cd", cwd: string) => {
		const key = scope(family, cwd);
		const generation = generations.get(key) ?? 0;
		let controller = selectionControllers.get(key);
		if (!controller) {
			controller = new AbortController();
			selectionControllers.set(key, controller);
		}
		const assertCurrent = () => {
			if (closed || (generations.get(key) ?? 0) !== generation)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			if (uncertainWrites.has(key))
				throw new Error(
					"A store operation has an uncertain outcome; reconcile it before retrying.",
				);
		};
		return {
			assertCurrent,
			selectionSignal: controller.signal,
			hasPendingWrites: () => (pendingWrites.get(key) ?? 0) > 0,
			markUncertainWrite: () => uncertainWrites.add(key),
			runStoreWrite: async <T>(write: () => Promise<T>): Promise<T> => {
				assertCurrent();
				if (writeScope.getStore()?.has(key)) return write();
				const previous = writeQueues.get(key) ?? Promise.resolve();
				let release: () => void = () => undefined;
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				const queued = previous.then(() => held);
				writeQueues.set(key, queued);
				pendingWrites.set(key, (pendingWrites.get(key) ?? 0) + 1);
				try {
					await previous;
					assertCurrent();
					return await writeScope.run(
						new Set([...(writeScope.getStore() ?? []), key]),
						write,
					);
				} finally {
					release();
					if (writeQueues.get(key) === queued) writeQueues.delete(key);
					const remaining = (pendingWrites.get(key) ?? 1) - 1;
					if (remaining > 0) pendingWrites.set(key, remaining);
					else pendingWrites.delete(key);
				}
			},
			hasSessionChoice: () => sessionChoices.has(key),
			onOwnerChoice: () => {
				assertCurrent();
				if ((pendingWrites.get(key) ?? 0) > 0)
					throw new Error("The selected store is saving a change.");
				familyVaults.get(key)?.clear();
				familyVaults.delete(key);
				controller.abort();
				selectionControllers.delete(key);
				owner.cancelScope(family, cwd);
				sessionChoices.add(key);
				generations.set(key, generation + 1);
			},
			read: async () => {
				if (closed) return {};
				assertCurrent();
				const values =
					sessionSettings.get(key) ??
					(await fileSettingsStore(
						secretStoreLocatorPath(canonical(cwd)),
					).read());
				assertCurrent();
				return values;
			},
			write: async (values: Readonly<Record<string, string>>) => {
				assertCurrent();
				sessionSettings.set(key, { ...values });
			},
		};
	};
	const owner = createMcpOwnerChannel({
		storeSettingsFor,
		scopeKey: scope,
		requireScope: true,
		vaultFor: (family, cwd) => {
			if (closed) throw new Error("The owner session is closed.");
			const key = scope(family, cwd);
			let vault = familyVaults.get(key);
			if (!vault) {
				vault = scopeRunVault(createTrustedVault());
				familyVaults.set(key, vault);
			}
			return vault;
		},
		// Every step that needs the owner is a form in their host, asked in
		// the call that needs it: nothing is relayed through the agent.
		form: (params) =>
			forms()?.request?.("elicitation/create", params) ?? undefined,
		canConfirm: () => forms()?.request !== undefined,
		ask: async (name) => {
			const host = forms();
			if (host === undefined || capture === undefined) return false;
			const outcome = await capture.callTool(
				"capture_secret",
				{ name },
				{ ...host.support, apps: false },
			);
			return outcome.kind === "result" && outcome.result.isError !== true;
		},
		notify: (method, params) => {
			options.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	const scopedOwner = (family: "ci" | "cd", cwd: string) => ({
		...(owner.forScope?.(family, cwd) ?? owner),
		...(owner.vaultFor ? { vault: owner.vaultFor(family, cwd) } : undefined),
		...(owner.storeSettingsFor
			? { storeSettings: owner.storeSettingsFor(family, cwd) }
			: undefined),
	});
	const sessions = createOwnerStoreSessions({
		signIn:
			options.ownerSignIn ??
			((input) =>
				ownerChannelSignIn({
					owner: scopedOwner("cd", input.cwd),
					deps: {
						runCommand: machineRunner(),
						which: (bin) => whichOnPath(bin),
					},
				})(input)),
		relayFolder: (input) =>
			ownerChannelRelayFolder({
				owner: scopedOwner("ci", input.cwd),
				deps: {
					runCommand: machineRunner(),
					which: (bin) => whichOnPath(bin),
				},
			})(input),
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
			const request = session?.request;
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
	session = createMcpStdioSession(
		capture,
		createStoreChoiceApp({
			sessions,
			pages: createOwnerPages(),
			deposit: (name, value) => owner.deposit(name, value),
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
			closed = true;
			sessionSettings.clear();
			sessionChoices.clear();
			generations.clear();
			for (const controller of selectionControllers.values())
				controller.abort();
			selectionControllers.clear();
			pendingWrites.clear();
			writeQueues.clear();
			uncertainWrites.clear();
			for (const vault of familyVaults.values()) vault.clear();
			familyVaults.clear();
			owner.vault?.clear();
			owner.close();
			owner.jobs.close();
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
		remote: true,
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
