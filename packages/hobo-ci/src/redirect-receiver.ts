import { type ChildProcess, spawn } from "node:child_process";

import { childEgressEnv, type Egress, egressFrom } from "./egress.js";
import {
	type PublicOrigin,
	parsePublicOrigin,
	SettingParseError,
} from "./parsed-values.js";

/**
 * How a provider's browser redirect (GitHub's App manifest code, an OAuth
 * code) reaches the owner's own run when that run is on a box the owner's
 * browser cannot reach, such as an agent's remote session.
 *
 * Outbound only. The run listens on 127.0.0.1, never on a public port. A
 * receiver is a dev-server reverse proxy the owner runs with their own CLI
 * and account (Cloudflare Tunnel `cloudflared`, ngrok, localtunnel,
 * Microsoft Dev Tunnels `devtunnel`, Pangolin's `newt`, or any command that
 * prints a public https URL): its client dials out to the provider's edge,
 * which carries the browser's request back over that connection. What it
 * reaches is the caller's one listener, which answers only under an
 * unguessable path, accepts one callback that passes its state check, and
 * closes; the tunnel ends with it. HoBo runs no receiver and brokers
 * nothing: the owner's chosen edge sees the redirect in transit, as for any
 * dev tunnel, and nothing else.
 *
 * With no receiver configured there is none, and the caller falls back to
 * the owner's hand-off (they carry the one-time code back, or put the result
 * in their store themselves).
 */

// public-contract: the non-secret setting naming the owner's redirect receiver.
export const REDIRECT_RECEIVER_SETTING = "HOBO_REDIRECT_RECEIVER";
// public-contract: the redirect receivers HoBo can start, each with the owner's own tunnel CLI.
export const REDIRECT_RECEIVERS = [
	"cloudflared",
	"ngrok",
	"localtunnel",
	"devtunnel",
	"pangolin",
	"command",
] as const;
export type RedirectReceiverId = (typeof REDIRECT_RECEIVERS)[number];

/**
 * Whether each receiver's client can reach its edge through an HTTP(S)
 * proxy. cloudflared dials Cloudflare's edge directly (QUIC or HTTP/2 on
 * 7844, found by DNS SRV), localtunnel opens raw TCP to its server, and
 * Pangolin's newt uses WireGuard over UDP: none can use an HTTP proxy. ngrok
 * and devtunnel connect over HTTPS/WebSocket on 443 and honour HTTPS_PROXY;
 * a `command` receiver is the owner's own and is given the proxy settings.
 */
export const RECEIVER_THROUGH_PROXY: ReadonlyMap<RedirectReceiverId, boolean> =
	new Map([
		["cloudflared", false],
		["ngrok", true],
		["localtunnel", false],
		["devtunnel", true],
		["pangolin", false],
		["command", true],
	]);

/** A running tunnel: its public origin, ended with the run. */
export interface OpenTunnel {
	readonly publicOrigin: PublicOrigin;
	readonly close: () => Promise<void>;
}

/** A receiver: starts the owner's tunnel to a local port. */
export interface RedirectReceiver {
	readonly id: RedirectReceiverId;
	readonly open: (localPort: number) => Promise<OpenTunnel>;
}

export class RedirectReceiverError extends Error {
	readonly code:
		| "HOBO_REDIRECT_RECEIVER_UNKNOWN"
		| "HOBO_REDIRECT_RECEIVER_MISSING"
		| "HOBO_REDIRECT_RECEIVER_FAILED"
		| "HOBO_REDIRECT_RECEIVER_UNSAFE"
		| "HOBO_REDIRECT_RECEIVER_EGRESS";
	constructor(code: RedirectReceiverError["code"], message: string) {
		super(message);
		this.name = "RedirectReceiverError";
		this.code = code;
	}
}

/** How a tunnel CLI is started and where it prints its public URL. */
export interface TunnelCommand {
	readonly command: string;
	readonly args: readonly string[];
	/** The public HTTPS origin, matched in the CLI's output (group 1 or whole). */
	readonly urlPattern: RegExp;
	/** A fixed public origin, for tunnels whose address is configured, not printed. */
	readonly fixedOrigin?: PublicOrigin;
}

/** The tunnel CLI each receiver runs, from non-secret settings only. */
export function tunnelCommand(
	id: RedirectReceiverId,
	localPort: number,
	settings: Readonly<Record<string, string | undefined>>,
): TunnelCommand {
	const local = `http://127.0.0.1:${localPort}`;
	switch (id) {
		case "cloudflared":
			// A quick tunnel needs no account; a named tunnel (HOBO_CLOUDFLARED_TUNNEL)
			// runs the owner's own, already routed to HOBO_REDIRECT_PUBLIC_ORIGIN.
			return settings.HOBO_CLOUDFLARED_TUNNEL
				? {
						command: "cloudflared",
						args: [
							"tunnel",
							"--no-autoupdate",
							"run",
							"--url",
							local,
							settings.HOBO_CLOUDFLARED_TUNNEL,
						],
						urlPattern: /$^/u,
						...originSetting(settings),
					}
				: {
						command: "cloudflared",
						args: ["tunnel", "--no-autoupdate", "--url", local],
						urlPattern: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/u,
					};
		case "ngrok":
			// The owner's ngrok agent, signed in with their own `ngrok config add-authtoken`.
			return {
				command: "ngrok",
				args: [
					"http",
					local,
					"--log",
					"stdout",
					"--log-format",
					"logfmt",
					...(settings.HOBO_NGROK_DOMAIN
						? ["--url", settings.HOBO_NGROK_DOMAIN]
						: []),
				],
				urlPattern: /url=(https:\/\/[A-Za-z0-9.-]+)/u,
			};
		case "localtunnel":
			return {
				command: "lt",
				args: ["--port", String(localPort), "--local-host", "127.0.0.1"],
				urlPattern: /your url is: (https:\/\/[A-Za-z0-9.-]+)/iu,
			};
		case "devtunnel":
			// The owner's Microsoft Dev Tunnel, signed in with `devtunnel user login`.
			// Anonymous access is needed: the provider's redirect carries no cookie.
			return {
				command: "devtunnel",
				args: ["host", "-p", String(localPort), "--allow-anonymous"],
				urlPattern: /(https:\/\/[a-z0-9-]+\.[a-z0-9]+\.devtunnels\.ms)/u,
			};
		case "pangolin":
			// Newt connects to the owner's Pangolin server, whose resource already
			// routes HOBO_REDIRECT_PUBLIC_ORIGIN to this port; the address is configured.
			return {
				command: "newt",
				args: settings.HOBO_PANGOLIN_ENDPOINT
					? ["--endpoint", settings.HOBO_PANGOLIN_ENDPOINT]
					: [],
				urlPattern: /$^/u,
				...originSetting(settings),
			};
		case "command": {
			const line = settings.HOBO_REDIRECT_COMMAND ?? "";
			const [command, ...args] = line
				.replaceAll("{port}", String(localPort))
				.split(/\s+/u)
				.filter(Boolean);
			if (command === undefined)
				throw new RedirectReceiverError(
					"HOBO_REDIRECT_RECEIVER_MISSING",
					"HOBO_REDIRECT_COMMAND names no command; give the tunnel command, with {port} for the local port.",
				);
			return {
				command,
				args,
				urlPattern: /(https:\/\/[A-Za-z0-9.-]+(?::\d+)?)/u,
				...(settings.HOBO_REDIRECT_PUBLIC_ORIGIN
					? originSetting(settings)
					: undefined),
			};
		}
	}
}

/** A tunnel whose public address is configured, not printed. */
interface FixedOrigin {
	readonly fixedOrigin: PublicOrigin;
}

function originSetting(
	settings: Readonly<Record<string, string | undefined>>,
): FixedOrigin {
	const origin = settings.HOBO_REDIRECT_PUBLIC_ORIGIN;
	if (!origin)
		throw new RedirectReceiverError(
			"HOBO_REDIRECT_RECEIVER_MISSING",
			"This tunnel's public address is configured, not printed: set HOBO_REDIRECT_PUBLIC_ORIGIN to the https origin routed to it.",
		);
	// Parsed when the receiver is built: a bad origin never reaches a tunnel.
	return { fixedOrigin: safePublicOrigin(origin) };
}

/** Only a public https origin with no path, query or credentials. */
export function safePublicOrigin(text: string): PublicOrigin {
	try {
		return parsePublicOrigin("the tunnel's public address", text);
	} catch (error) {
		if (!(error instanceof SettingParseError)) throw error;
		throw new RedirectReceiverError(
			"HOBO_REDIRECT_RECEIVER_UNSAFE",
			error.message,
		);
	}
}

export interface ReceiverDeps {
	/** The run's egress; read from the settings (environment) by default. */
	readonly egress?: Egress;
	/** The environment a tunnel CLI inherits, minus secrets; this process's by default. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly spawn?: (
		command: string,
		args: readonly string[],
		env: NodeJS.ProcessEnv,
	) => Pick<ChildProcess, "stdout" | "stderr" | "kill" | "once">;
	readonly timeoutMs?: number;
}

/**
 * The receiver the owner configured (`HOBO_REDIRECT_RECEIVER`), or none: the
 * caller then falls back to the owner's hand-off.
 */
export function redirectReceiverFrom(
	settings: Readonly<Record<string, string | undefined>>,
	deps: ReceiverDeps = {},
): RedirectReceiver | undefined {
	const chosen = settings[REDIRECT_RECEIVER_SETTING];
	if (chosen === undefined || chosen === "" || chosen === "none")
		return undefined;
	const id = REDIRECT_RECEIVERS.find((candidate) => candidate === chosen);
	if (id === undefined)
		throw new RedirectReceiverError(
			"HOBO_REDIRECT_RECEIVER_UNKNOWN",
			`${REDIRECT_RECEIVER_SETTING} must be one of ${REDIRECT_RECEIVERS.join(", ")} or none.`,
		);
	const egress = deps.egress ?? egressFrom(settings);
	return {
		id,
		async open(localPort) {
			// Checked before anything starts: a client that cannot use the
			// required proxy would print an address it can never serve.
			if (egress.proxy !== undefined && RECEIVER_THROUGH_PROXY.get(id) !== true)
				throw new RedirectReceiverError(
					"HOBO_REDIRECT_RECEIVER_EGRESS",
					`This environment requires an HTTPS proxy, and ${id} cannot reach its edge through one; it was not started.`,
				);
			return openTunnel(tunnelCommand(id, localPort, settings), {
				...deps,
				egress,
			});
		},
	};
}

/** Start the tunnel CLI and wait for its public origin. */
export async function openTunnel(
	tunnel: TunnelCommand,
	deps: ReceiverDeps = {},
): Promise<OpenTunnel> {
	// Validate a configured address before starting any subprocess.
	const fixedOrigin =
		tunnel.fixedOrigin === undefined
			? undefined
			: safePublicOrigin(tunnel.fixedOrigin);
	const start =
		deps.spawn ??
		((command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
			spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env }));
	// The proxy and CA settings the environment requires, never a secret.
	const env = childEgressEnv(
		deps.env ?? process.env,
		deps.egress ?? egressFrom(process.env),
	);
	let child: ReturnType<typeof start>;
	try {
		child = start(tunnel.command, tunnel.args, env);
	} catch {
		throw new RedirectReceiverError(
			"HOBO_REDIRECT_RECEIVER_MISSING",
			`${tunnel.command} could not be started; install it and sign in with your own account.`,
		);
	}
	const close = async () => {
		child.kill("SIGTERM");
	};
	try {
		if (fixedOrigin !== undefined) {
			// A fixed address is not evidence that the CLI started: spawn errors
			// arrive asynchronously, after spawn() has returned its child.
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new RedirectReceiverError(
								"HOBO_REDIRECT_RECEIVER_FAILED",
								`${tunnel.command} did not start in time.`,
							),
						),
					deps.timeoutMs ?? 60_000,
				);
				child.once("spawn", () => {
					clearTimeout(timer);
					resolve();
				});
				child.once("error", () => {
					clearTimeout(timer);
					reject(
						new RedirectReceiverError(
							"HOBO_REDIRECT_RECEIVER_MISSING",
							`${tunnel.command} is not installed or could not start; install it and sign in with your own account.`,
						),
					);
				});
				child.once("exit", () => {
					clearTimeout(timer);
					reject(
						new RedirectReceiverError(
							"HOBO_REDIRECT_RECEIVER_FAILED",
							`${tunnel.command} exited before it started.`,
						),
					);
				});
			});
			return { publicOrigin: fixedOrigin, close };
		}
		const origin = await new Promise<string>((resolve, reject) => {
			let seen = "";
			const timer = setTimeout(
				() =>
					reject(
						new RedirectReceiverError(
							"HOBO_REDIRECT_RECEIVER_FAILED",
							`${tunnel.command} printed no public address in time.`,
						),
					),
				deps.timeoutMs ?? 60_000,
			);
			const read = (chunk: Buffer | string) => {
				seen = (seen + String(chunk)).slice(-16_384);
				const match = tunnel.urlPattern.exec(seen);
				if (match) {
					clearTimeout(timer);
					resolve(match[1] ?? match[0]);
				}
			};
			child.stdout?.on("data", read);
			child.stderr?.on("data", read);
			child.once("error", () => {
				clearTimeout(timer);
				reject(
					new RedirectReceiverError(
						"HOBO_REDIRECT_RECEIVER_MISSING",
						`${tunnel.command} is not installed or could not start; install it and sign in with your own account.`,
					),
				);
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(
					new RedirectReceiverError(
						"HOBO_REDIRECT_RECEIVER_FAILED",
						`${tunnel.command} exited before it printed a public address.`,
					),
				);
			});
		});
		return { publicOrigin: safePublicOrigin(origin), close };
	} catch (error) {
		await close();
		throw error;
	}
}
