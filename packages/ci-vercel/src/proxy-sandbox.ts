import { Sandbox, type Session } from "@vercel/sandbox";
import { sandboxProxyBundle } from "./_generated-assets/sandbox-proxy-bundle.js";
import {
	discoverIsolatedSandbox,
	stopIsolatedSandbox,
} from "./isolated-sandbox.js";
import { validSandboxDomainPattern } from "./sandbox-domains.js";
import {
	launchSandboxProxyVm,
	ProxyStartupError,
	type ProxyVmConfig,
	probeSandboxProxyVm,
} from "./sandbox-proxy-vm.js";

export interface ProxySandboxCreate {
	name: string;
	plan: "hobby" | "pro" | "enterprise";
	region: string;
	vcpus: number;
	timeoutMs: number;
	port: number;
	relayOrigin: string;
	domains: readonly string[];
}

/** Creating the named ephemeral VM is a non-idempotent side effect. The caller
 * must persist a deterministic create intent before this function is called. */
export async function createProxySandbox(config: ProxySandboxCreate) {
	if (!/^hobo-proxy-[a-f0-9-]{36}$/.test(config.name))
		throw new Error("invalid proxy name");
	const max = config.plan === "hobby" ? 45 * 60_000 : 24 * 60 * 60_000;
	const maxCpus = config.plan === "hobby" ? 4 : config.plan === "pro" ? 8 : 32;
	if (
		!Number.isSafeInteger(config.timeoutMs) ||
		config.timeoutMs < 60_000 ||
		config.timeoutMs > max ||
		!Number.isInteger(config.vcpus) ||
		config.vcpus < 1 ||
		config.vcpus > maxCpus ||
		(config.vcpus !== 1 && config.vcpus % 2 !== 0)
	)
		throw new Error("invalid proxy resources");
	if (
		!/^[a-z0-9]{3,8}$/.test(config.region) ||
		!Number.isInteger(config.port) ||
		config.port < 1024 ||
		config.port > 65535
	)
		throw new Error("invalid proxy region or port");
	const relay = new URL(config.relayOrigin);
	if (
		relay.protocol !== "https:" ||
		relay.username ||
		relay.password ||
		relay.pathname !== "/" ||
		relay.search ||
		relay.hash
	)
		throw new Error("invalid relay origin");
	const allowed = [
		...new Set([...config.domains, relay.hostname, "oidc.vercel.com"]),
	];
	if (allowed.some((domain) => !validSandboxDomainPattern(domain)))
		throw new Error("invalid proxy network domain");
	const box = await Sandbox.create({
		name: config.name,
		image: "vercel/sandbox/node:24",
		persistent: false,
		ports: [config.port],
		resources: { vcpus: config.vcpus },
		timeout: config.timeoutMs,
		region: config.region,
		networkPolicy: { allow: allowed },
	});
	try {
		if (box.name !== config.name || box.persistent)
			throw new Error("proxy identity mismatch");
		const session = box.currentSession();
		if (
			session.status !== "running" ||
			session.vcpus !== config.vcpus ||
			session.region !== config.region ||
			!session.startedAt
		)
			throw new Error("proxy resources unconfirmed");
		const origin = new URL(session.domain(config.port));
		if (
			origin.protocol !== "https:" ||
			origin.username ||
			origin.password ||
			origin.pathname !== "/" ||
			origin.search ||
			origin.hash
		)
			throw new Error("invalid proxy endpoint");
		const expiresAt = session.startedAt.getTime() + session.timeout;
		if (!Number.isSafeInteger(expiresAt))
			throw new Error("proxy deadline unavailable");
		return {
			name: box.name,
			sessionId: session.sessionId,
			origin: origin.origin,
			expiresAt,
		};
	} catch (error) {
		await box.stop().catch(() => undefined);
		throw error;
	}
}

async function proxySession(name: string, sessionId: string): Promise<Session> {
	const box = await Sandbox.get({ name, resume: false });
	if (box.name !== name || box.persistent)
		throw new Error("proxy identity mismatch");
	const session = box.currentSession();
	if (session.sessionId !== sessionId || session.status !== "running")
		throw new Error("proxy session changed");
	return session;
}

/** A token is sent only to the separate trusted proxy VM, never to the guest. */
export async function startProxySandbox(
	name: string,
	sessionId: string,
	config: ProxyVmConfig,
) {
	const session = await proxySession(name, sessionId);
	const result = await launchSandboxProxyVm(
		session,
		Buffer.from(sandboxProxyBundle),
		config,
	);
	const probe = await probeSandboxProxyVm(
		session,
		config.port,
		result.commandId,
		result.readinessNonce,
	);
	if (probe.ready === false) throw new ProxyStartupError(probe.reason);
	return { commandId: result.commandId };
}
export const discoverProxySandbox = discoverIsolatedSandbox;
export const stopProxySandbox = stopIsolatedSandbox;

/** Bind this exact guest before it can spend any proxy quota. */
export async function bindProxySandbox(
	origin: string,
	token: string,
	sandboxId: string,
) {
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("invalid proxy origin");
	const response = await fetch(new URL("/internal/bind", url), {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ sandboxId }),
		redirect: "error",
		signal: AbortSignal.timeout(5000),
	});
	if (response.status !== 204)
		throw new Error("proxy guest binding unavailable");
}
