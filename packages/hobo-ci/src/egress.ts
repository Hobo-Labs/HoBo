import { readFileSync } from "node:fs";
import { getCACertificates } from "node:tls";
import { Agent, EnvHttpProxyAgent } from "undici";

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
	readonly proxy: string | undefined;
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
		proxy: first(env, ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]),
		noProxy: first(env, ["NO_PROXY", "no_proxy"]),
		caFile: first(env, [
			"NODE_EXTRA_CA_CERTS",
			"SSL_CERT_FILE",
			"REQUESTS_CA_BUNDLE",
		]),
	};
}

/** A `fetch` that goes through the required proxy, honouring its bypass list. */
export function egressFetch(egress: Egress): typeof fetch {
	const tls =
		egress.caFile === undefined
			? undefined
			: {
					ca: [
						...getCACertificates("default"),
						readFileSync(egress.caFile, "utf8"),
					],
				};
	if (egress.proxy === undefined && tls === undefined) return fetch;
	const dispatcher =
		egress.proxy === undefined
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
	// Node's fetch is undici's and takes its dispatcher as a request option.
	return (input, init) => {
		const routed: RequestInit & {
			readonly dispatcher: Agent | EnvHttpProxyAgent;
		} = {
			...init,
			dispatcher,
		};
		return fetch(input, routed);
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
