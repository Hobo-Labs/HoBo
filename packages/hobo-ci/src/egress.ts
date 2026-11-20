import { readFileSync } from "node:fs";
import { getCACertificates } from "node:tls";
import {
	Agent,
	Dispatcher,
	EnvHttpProxyAgent,
	setGlobalDispatcher,
} from "undici";

import { type ProxyUrl, parseProxyUrl } from "./parsed-values.js";
import { withoutSecretEnv } from "./secret-custody.js";

/**
 * How this run reaches the internet, read once and deterministically from
 * its environment before anything connects: an HTTP(S) proxy the
 * environment requires (an agent's sandbox, a corporate network), the hosts
 * that bypass it, and the CA bundle that trusts it. Every outbound piece of a
 * ceremony honours it, so nothing discovers the proxy by failing:
 *
 * - this process's own requests go through `egressFetch` (Node's `fetch`
 *   does not read HTTPS_PROXY on its own);
 * - a tunnel CLI is started with the proxy and CA settings (and no secret
 *   variables), and a receiver whose CLI cannot tunnel through an HTTP proxy
 *   is not started at all when one is required: the caller goes straight to
 *   the owner's hand-off.
 */

export interface Egress {
	/** The proxy every https request must use, or none (direct). */
	readonly proxy: ProxyUrl | undefined;
	/** Hosts that bypass the proxy, as the environment lists them. */
	readonly noProxy: string | undefined;
	/** The CA bundle that trusts the proxy's certificates, if any. */
	readonly caFile: string | undefined;
}

function first(
	env: Readonly<Record<string, string | undefined>>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = env[name];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

/** The environment's egress: proxy, bypass list and CA bundle. */
export function egressFrom(
	env: Readonly<Record<string, string | undefined>>,
): Egress {
	return {
		proxy: (() => {
			const text = first(env, [
				"HTTPS_PROXY",
				"https_proxy",
				"ALL_PROXY",
				"all_proxy",
			]);
			// Parsed where it enters: a malformed proxy is refused up front.
			return text === undefined
				? undefined
				: parseProxyUrl("HTTPS_PROXY", text);
		})(),
		noProxy: first(env, ["NO_PROXY", "no_proxy"]),
		caFile: first(env, [
			"NODE_EXTRA_CA_CERTS",
			"SSL_CERT_FILE",
			"REQUESTS_CA_BUNDLE",
		]),
	};
}

/** The dispatcher the egress requires, or none when the defaults serve. */
function egressDispatcher(
	egress: Egress,
): Agent | EnvHttpProxyAgent | undefined {
	const tls =
		egress.caFile === undefined
			? undefined
			: {
					ca: [
						...getCACertificates("default"),
						readFileSync(egress.caFile, "utf8"),
					],
				};
	if (egress.proxy === undefined && tls === undefined) return undefined;
	return egress.proxy === undefined
		? new Agent(tls === undefined ? undefined : { connect: tls })
		: new EnvHttpProxyAgent({
				httpProxy: egress.proxy,
				httpsProxy: egress.proxy,
				// An absent bypass list is an empty snapshot, not permission to
				// inherit a different NO_PROXY from the ambient process.
				noProxy: egress.noProxy ?? "",
				...(tls !== undefined
					? { connect: tls, requestTls: tls, proxyTls: tls }
					: undefined),
			});
}

/** A `fetch` that goes through the required proxy, honouring its bypass list. */
export function egressFetch(egress: Egress): typeof fetch {
	return fetchWithDispatcher(egressDispatcher(egress));
}

export function isolatedOwnerEgressFetch(
	egress: Egress,
	allowedOrigin: string,
): typeof fetch {
	const target = egressDispatcher(egress) ?? new Agent();
	return fetchWithDispatcher(new OriginDispatcher(target, allowedOrigin));
}

function fetchWithDispatcher(dispatcher: Dispatcher | undefined): typeof fetch {
	if (dispatcher === undefined) return fetch;
	return (input, init) => {
		const routed: RequestInit & { readonly dispatcher: Dispatcher } = {
			...init,
			dispatcher,
		};
		return fetch(input, routed);
	};
}

class OriginDispatcher extends Dispatcher {
	readonly #inner: Dispatcher;
	readonly #allowedOrigin: string;
	constructor(inner: Dispatcher, allowedOrigin: string) {
		super();
		this.#inner = inner;
		this.#allowedOrigin = allowedOrigin;
	}
	override dispatch(
		options: Dispatcher.DispatchOptions,
		handler: Dispatcher.DispatchHandler,
	): boolean {
		if (
			options.origin === undefined ||
			new URL(options.origin).origin !== this.#allowedOrigin
		)
			throw new Error("Private owner redirect was refused.");
		return this.#inner.dispatch(options, handler);
	}
	override async close(): Promise<void> {
		await this.#inner.close();
	}
	override async destroy(): Promise<void> {
		await this.#inner.destroy();
	}
}

/**
 * Apply the environment's egress to the whole process, once, before anything
 * connects: Node's global fetch (and anything built on it) then honours the
 * proxy, its bypass list and its CA, wherever a call site forgot to route
 * through `egressFetch`. Node's built-in fetch reads the dispatcher undici
 * installs globally.
 */
export function applyEgressToProcess(
	env: Readonly<Record<string, string | undefined>>,
): void {
	const egress = egressFrom(env);
	if (egress.proxy === undefined && egress.caFile === undefined) return;
	setGlobalDispatcher(new LazyEgressDispatcher(egress));
}

/**
 * The egress dispatcher, built on the first request: the CA bundle is opened
 * only when something connects, so a run configured with a CA it never uses
 * still starts, and a bad path fails the requests that need it.
 */
class LazyEgressDispatcher extends Dispatcher {
	#inner: Dispatcher | undefined;
	readonly #egress: Egress;
	constructor(egress: Egress) {
		super();
		this.#egress = egress;
	}
	#target(): Dispatcher {
		if (this.#inner === undefined)
			try {
				this.#inner = egressDispatcher(this.#egress) ?? new Agent();
			} catch (error) {
				// The egress cannot be built (an unreadable CA bundle): every
				// connection fails with that reason, through undici's own error
				// path, so each request rejects with it as the cause.
				const failure =
					error instanceof Error ? error : new Error("egress unavailable");
				this.#inner = new Agent({
					connect: (_options, callback) => callback(failure, null),
				});
			}
		return this.#inner;
	}
	override dispatch(
		options: Dispatcher.DispatchOptions,
		handler: Dispatcher.DispatchHandler,
	): boolean {
		return this.#target().dispatch(options, handler);
	}
	override async close(): Promise<void> {
		await this.#inner?.close();
	}
	override async destroy(): Promise<void> {
		await this.#inner?.destroy();
	}
}

/** Snapshot egress now, but open the CA bundle only if a request is made. */
export function lazyEgressFetch(
	env: Readonly<Record<string, string | undefined>>,
): typeof fetch {
	const egress = egressFrom(env);
	let send: typeof fetch | undefined;
	return (input, init) => {
		send ??= egressFetch(egress);
		return send(input, init);
	};
}

/**
 * The environment a tunnel CLI starts with: this process's, minus every
 * secret variable, plus the proxy and CA settings in each spelling the CLIs
 * read.
 */
export function childEgressEnv(
	env: Readonly<Record<string, string | undefined>>,
	egress: Egress,
): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(withoutSecretEnv(env)))
		if (value !== undefined) out[name] = value;
	if (egress.proxy !== undefined)
		for (const name of [
			"HTTPS_PROXY",
			"https_proxy",
			"HTTP_PROXY",
			"http_proxy",
		])
			out[name] = egress.proxy;
	if (egress.noProxy !== undefined) {
		out.NO_PROXY = egress.noProxy;
		out.no_proxy = egress.noProxy;
	}
	if (egress.caFile !== undefined) {
		out.SSL_CERT_FILE = egress.caFile;
		out.NODE_EXTRA_CA_CERTS = egress.caFile;
	}
	return out;
}
