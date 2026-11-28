import { createServer, type IncomingMessage, request } from "node:http";
import { type AddressInfo, connect } from "node:net";

import type { PrepareOutcome } from "@hobo/cli";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import { readOwnerTurn } from "../../src/owner-actions.js";
import type { OwnerChannel } from "../../src/owner-channel.js";

/**
 * A remote dev box's owner, simulated. They are not at the box: they have a
 * browser on their own device, the agent's chat (with the host's structured
 * asks: pickers, the credential form, the HoBo MCP App's forms) and their
 * providers' own apps. They cannot reach the box's 127.0.0.1, open its
 * terminal, set its environment variables or run anything on it.
 *
 * `driveRemoteOwner` runs a ceremony the way the agent does: run, read every
 * owner-facing line, have the owner do the one thing it asks, run again. It
 * ends ready, or at a dead end: a line the owner cannot act on from where
 * they are, a refusal with nothing they can do, or a loop that never ends.
 * A dead end fails the eval whatever the wording was.
 */

export {
	type OwnerAction,
	type OwnerStep,
	readOwnerTurn,
} from "../../src/owner-actions.js";

/** Every line a run showed: its progress, then its refusal. */
export function ownerLines(
	outcome: PrepareOutcome,
	progress: readonly string[],
): string[] {
	if (outcome.kind !== "refused") return [...progress];
	const result = outcome.result;
	return [
		...progress,
		result.code,
		result.message ?? "",
		...(result.remediation ?? []),
	];
}

/** What the simulated owner does for each action; absent means they cannot. */
export interface RemoteOwnerHands {
	readonly signIn?: (url: URL, capture: string) => Promise<void>;
	readonly capture?: (name: string) => Promise<void>;
	/** The agent switches to the HoBo MCP server's tools (they bring the owner a channel). */
	readonly useMcp?: () => Promise<void>;
	readonly chooseStore?: () => Promise<void>;
	readonly device?: (line: string) => Promise<void>;
	readonly approveBitwarden?: (line: string) => Promise<void>;
}

export type RemoteOwnerResult =
	| { readonly kind: "ready"; readonly runs: number; readonly trail: string[] }
	| {
			readonly kind: "waiting";
			readonly runs: number;
			readonly trail: string[];
	  }
	| {
			readonly kind: "blocked";
			readonly reason: string;
			readonly trail: string[];
	  }
	| {
			readonly kind: "dead-end";
			readonly reason: string;
			readonly lines: readonly string[];
			readonly trail: string[];
	  };

/** Run, read, act, run again: as the agent and the remote owner do together. */
export async function driveRemoteOwner(options: {
	readonly run: () => Promise<{
		readonly ready: boolean;
		readonly lines: readonly string[];
	}>;
	readonly hands: RemoteOwnerHands;
	readonly maxRuns?: number;
	readonly publicOrigins?: readonly string[];
}): Promise<RemoteOwnerResult> {
	const trail: string[] = [];
	const maxRuns = options.maxRuns ?? 6;
	for (let runs = 1; runs <= maxRuns; runs += 1) {
		const turn = await options.run();
		const step = readOwnerTurn(turn.ready, turn.lines, options.publicOrigins);
		if (step.kind === "ready") return { kind: "ready", runs, trail };
		if (step.kind === "dead-end") return { ...step, trail };
		if (step.kind === "blocked") return { ...step, trail };
		const action = step.action;
		trail.push(action.kind);
		if (action.kind === "wait-for-owner")
			return { kind: "waiting", runs, trail };
		const hands = options.hands;
		const done =
			action.kind === "run-again"
				? true
				: action.kind === "use-mcp"
					? await act(hands.useMcp, (f) => f())
					: action.kind === "sign-in"
						? await act(hands.signIn, (f) => f(action.url, action.capture))
						: action.kind === "capture"
							? await act(hands.capture, async (f) => {
									for (const name of action.names) await f(name);
								})
							: action.kind === "store-choice"
								? await act(hands.chooseStore, (f) => f())
								: action.kind === "device"
									? await act(hands.device, (f) => f(action.line))
									: await act(hands.approveBitwarden, (f) => f(action.line));
		if (!done)
			return {
				kind: "dead-end",
				reason: `The run asked for ${action.kind}, which this owner cannot give from where they are.`,
				lines: turn.lines,
				trail,
			};
	}
	return {
		kind: "dead-end",
		reason: `Still not ready after ${maxRuns} runs: the ceremony loops.`,
		lines: [],
		trail,
	};
}

async function act<F>(
	hand: F | undefined,
	call: (hand: F) => Promise<void>,
): Promise<boolean> {
	if (hand === undefined) return false;
	await call(hand);
	return true;
}

/**
 * The owner channel of a run behind the HoBo MCP server: what the owner
 * submits waits in memory until a run takes it, once. `restart` is the MCP
 * server (or the agent's worker) restarting: whatever was held is gone.
 */
export function heldOwnerChannel() {
	let held = new Map<string, string>();
	/** The links the run registered for its captures, in order. */
	const opened: { url: string; capture: string }[] = [];
	const channel: OwnerChannel & {
		deposit(name: string, value: string): void;
		restart(): void;
		readonly opened: typeof opened;
	} = {
		privateCaptureAllowed: true,
		opened,
		openUrl: async (url, _message, capture) => {
			opened.push({ url, capture });
		},
		holds: (name) => held.has(name),
		async captureSecret({ name }) {
			const value = held.get(name);
			held.delete(name);
			return value;
		},
		deposit(name, value) {
			held.set(name, value);
		},
		restart() {
			held = new Map();
		},
	};
	return channel;
}

/**
 * A real HTTP forward proxy on 127.0.0.1, as an enterprise network or an
 * agent sandbox requires: every request the run makes must come through it.
 * With `credentials` it answers 407 to a request without them.
 */
export async function startForwardProxy(options: {
	readonly credentials?: string;
	/** Told each tunnel's local port, so a server can tell tunnelled requests apart. */
	readonly onTunnel?: (localPort: number) => void;
}) {
	const seen: string[] = [];
	const server = createServer((incoming: IncomingMessage, outgoing) => {
		const auth = incoming.headers["proxy-authorization"];
		if (
			options.credentials !== undefined &&
			auth !== `Basic ${Buffer.from(options.credentials).toString("base64")}`
		) {
			outgoing.writeHead(407, {
				"proxy-authenticate": 'Basic realm="corp"',
				connection: "close",
			});
			outgoing.end();
			return;
		}
		const target = new URL(incoming.url ?? "");
		seen.push(`${incoming.method ?? "GET"} ${target.host}${target.pathname}`);
		const headers = { ...incoming.headers };
		delete headers["proxy-authorization"];
		const forward = request(
			target,
			{ method: incoming.method, headers },
			(answer) => {
				outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(outgoing);
			},
		);
		forward.on("error", () => {
			outgoing.writeHead(502);
			outgoing.end();
		});
		incoming.pipe(forward);
	});
	// What undici (Node's fetch) uses for every proxied request: a tunnel.
	const tunnels = new Set<{ destroy(): void }>();
	server.on("connect", (incoming: IncomingMessage, socket, head) => {
		tunnels.add(socket);
		const auth = incoming.headers["proxy-authorization"];
		if (
			options.credentials !== undefined &&
			auth !== `Basic ${Buffer.from(options.credentials).toString("base64")}`
		) {
			socket.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n',
			);
			return;
		}
		const [host, port] = (incoming.url ?? "").split(":");
		seen.push(`CONNECT ${incoming.url ?? ""}`);
		const upstream = connect(Number(port), host ?? "", () => {
			tunnels.add(upstream);
			options.onTunnel?.(upstream.localPort ?? -1);
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return {
		seen,
		url: (auth?: string) =>
			`http://${auth === undefined ? "" : `${auth}@`}127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				for (const tunnel of tunnels) tunnel.destroy();
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export function handedOverInfisicalToken(): TrustedVault {
	const vault = createTrustedVault();
	vault.put("INFISICAL_TOKEN", "fixture-handed-over-access-token");
	return vault;
}
