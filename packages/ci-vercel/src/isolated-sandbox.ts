import { Sandbox, type Session } from "@vercel/sandbox";
import { validateSandboxDomains } from "./sandbox-domains.js";
import {
	prepareSandboxRunner,
	sandboxRunnerBootstrapPort,
	startSandboxRunner,
} from "./sandbox-runner-bootstrap.js";

/** A bounded, caller-supplied destination list. A catch-all is deliberately forbidden:
 * Vercel documents that domain-less traffic bypasses forwarding under `*`. */
export interface IsolatedSandboxConfiguration {
	name: string;
	timeoutMs: number;
	vcpus: number;
	plan: "hobby" | "pro" | "enterprise";
	region?: string;
	forwardUrl: string;
	allowedDomains: readonly string[];
}

export type SandboxCreateParameters = {
	name: string;
	persistent: false;
	image: "vercel/sandbox/node:24";
	resources: { vcpus: number };
	timeout: number;
	ports: number[];
	region?: string;
	networkPolicy: { allow: Record<string, { forwardURL: string }[]> };
};

export function sandboxCreateParameters(
	config: IsolatedSandboxConfiguration,
): SandboxCreateParameters {
	if (!/^hobo-[a-f0-9-]{36}$/.test(config.name))
		throw new Error("invalid sandbox name");
	const limit = config.plan === "hobby" ? 45 * 60_000 : 24 * 60 * 60_000;
	if (
		!Number.isSafeInteger(config.timeoutMs) ||
		config.timeoutMs < 60_000 ||
		config.timeoutMs > limit
	)
		throw new Error("sandbox timeout exceeds plan limit");
	const maxVcpus = config.plan === "hobby" ? 4 : config.plan === "pro" ? 8 : 32;
	if (
		!Number.isInteger(config.vcpus) ||
		config.vcpus < 1 ||
		config.vcpus > maxVcpus ||
		(config.vcpus !== 1 && config.vcpus % 2 !== 0)
	)
		throw new Error("invalid sandbox vcpu count");
	const forward = new URL(config.forwardUrl);
	if (
		forward.protocol !== "https:" ||
		forward.username ||
		forward.password ||
		forward.search ||
		forward.hash
	)
		throw new Error("invalid sandbox forward URL");
	validateSandboxDomains(config.allowedDomains);
	const allowed: Record<string, { forwardURL: string }[]> = Object.create(null);
	for (const domain of config.allowedDomains) {
		allowed[domain] = [{ forwardURL: forward.href }];
	}
	if (config.region && !/^[a-z0-9]{3,8}$/.test(config.region))
		throw new Error("invalid sandbox region");
	const ports: number[] = [];
	const parameters: SandboxCreateParameters = {
		name: config.name,
		persistent: false,
		image: "vercel/sandbox/node:24",
		resources: { vcpus: config.vcpus },
		timeout: config.timeoutMs,
		ports,
		networkPolicy: { allow: allowed },
	};
	if (config.region) parameters.region = config.region;
	return parameters;
}

function requireCurrent(
	box: Sandbox,
	name: string,
	sessionId?: string,
): Session {
	if (box.name !== name || box.persistent)
		throw new Error("sandbox identity or persistence mismatch");
	const session = box.currentSession();
	if (sessionId !== undefined && session.sessionId !== sessionId)
		throw new Error("sandbox session changed");
	return session;
}

/** Every command targets a specific Session, not Sandbox.runCommand. The latter
 * automatically resumes stopped sandboxes and could start a second VM. */
export async function createIsolatedSandbox(
	config: IsolatedSandboxConfiguration,
) {
	const box = await Sandbox.create(sandboxCreateParameters(config));
	try {
		const session = requireCurrent(box, config.name);
		if (session.status !== "running") throw new Error("sandbox not running");
		const started = session.startedAt?.getTime();
		if (
			started === undefined ||
			!Number.isSafeInteger(started + session.timeout)
		)
			throw new Error("sandbox deadline unavailable");
		return {
			name: box.name,
			sessionId: session.sessionId,
			expiresAt: started + session.timeout,
		};
	} catch (error) {
		await box.stop().catch(() => undefined);
		throw error;
	}
}

async function runningSession(name: string, sessionId: string) {
	const box = await Sandbox.get({ name, resume: false });
	const session = requireCurrent(box, name, sessionId);
	if (session.status !== "running") throw new Error("sandbox not running");
	return session;
}

export async function prepareIsolatedSandbox(name: string, sessionId: string) {
	await prepareSandboxRunner(
		sandboxRunnerBootstrapPort(await runningSession(name, sessionId)),
	);
}

/** Caller must commit start intent before invoking; an ambiguous response is
 * never retried, and must be reconciled by stopping the session. */
export async function startIsolatedSandbox(
	name: string,
	sessionId: string,
	jit: string,
) {
	return startSandboxRunner(
		sandboxRunnerBootstrapPort(await runningSession(name, sessionId)),
		jit,
	);
}

export async function inspectIsolatedCommand(
	name: string,
	sessionId: string,
	commandId: string,
) {
	const box = await Sandbox.get({ name, resume: false });
	if (box.name !== name || box.persistent)
		throw new Error("sandbox identity or persistence mismatch");
	const page = await box.listSessions({ limit: 3 });
	if (
		page.pagination.next ||
		page.sessions.length !== 1 ||
		page.sessions[0]?.id !== sessionId
	)
		throw new Error("sandbox session history is ambiguous");
	const observed = page.sessions[0];
	if (["stopped", "failed", "aborted"].includes(observed.status))
		return { commandId, exitCode: null, terminal: true };
	if (observed.status !== "running")
		throw new Error("sandbox session state uncertain");
	const session = requireCurrent(box, name, sessionId);
	const command = await session.getCommand(commandId);
	return {
		commandId: command.cmdId,
		exitCode: command.exitCode,
		terminal: false,
	};
}

/** Stop only the expected session, and require authoritative final usage before
 * releasing its reservation. Missing metrics are an uncertain outcome. */
export async function stopIsolatedSandbox(name: string, sessionId: string) {
	const box = await Sandbox.get({ name, resume: false });
	if (box.name !== name || box.persistent)
		throw new Error("sandbox identity or persistence mismatch");
	const page = await box.listSessions({ limit: 3 });
	// A newly created ephemeral sandbox must not have multiple sessions. If it
	// has, we cannot infer that all potentially running copies are stopped.
	if (
		page.pagination.next ||
		page.sessions.length !== 1 ||
		page.sessions[0]?.id !== sessionId
	)
		throw new Error("sandbox session history is ambiguous");
	let snapshot: {
		id: string;
		status: string;
		memory: number;
		vcpus: number;
		duration?: number | undefined;
		stoppedAt?: number | undefined;
		abortedAt?: number | undefined;
		activeCpuDurationMs?: number | undefined;
		networkTransfer?: { egress: number; ingress: number } | undefined;
	} = page.sessions[0];
	if (snapshot.status === "running") {
		const current = requireCurrent(box, name, sessionId);
		snapshot = (await current.stop()).session;
	}
	if (
		snapshot.id !== sessionId ||
		!["stopped", "failed", "aborted"].includes(snapshot.status)
	)
		throw new Error("sandbox shutdown unconfirmed");
	if (
		!Number.isSafeInteger(snapshot.activeCpuDurationMs) ||
		snapshot.activeCpuDurationMs === undefined ||
		snapshot.activeCpuDurationMs < 0 ||
		!Number.isSafeInteger(snapshot.networkTransfer?.egress) ||
		snapshot.networkTransfer === undefined ||
		snapshot.networkTransfer.egress < 0 ||
		!Number.isSafeInteger(snapshot.networkTransfer.ingress) ||
		snapshot.networkTransfer.ingress < 0
	)
		throw new Error("sandbox usage unavailable");
	if (
		!Number.isSafeInteger(snapshot.duration) ||
		snapshot.duration === undefined ||
		snapshot.duration < 0 ||
		!Number.isSafeInteger(snapshot.memory) ||
		snapshot.memory <= 0 ||
		!Number.isSafeInteger(snapshot.vcpus) ||
		snapshot.vcpus <= 0
	)
		throw new Error("sandbox memory usage unavailable");
	const stoppedAt = snapshot.stoppedAt ?? snapshot.abortedAt;
	if (
		!Number.isSafeInteger(stoppedAt) ||
		stoppedAt === undefined ||
		stoppedAt < 0
	)
		throw new Error("sandbox completion time unavailable");
	return {
		cpuMs: snapshot.activeCpuDurationMs,
		egressBytes: snapshot.networkTransfer.egress,
		ingressBytes: snapshot.networkTransfer.ingress,
		durationMs: snapshot.duration,
		memoryMb: snapshot.memory,
		vcpus: snapshot.vcpus,
		creations: 1,
		stoppedAt,
	};
}

/** Recover an ambiguous create by deterministic name without ever resuming it. */
export async function discoverIsolatedSandbox(name: string) {
	const box = await Sandbox.get({ name, resume: false });
	if (box.name !== name || box.persistent)
		throw new Error("sandbox identity or persistence mismatch");
	const page = await box.listSessions({ limit: 3 });
	if (
		page.pagination.next ||
		page.sessions.length !== 1 ||
		!page.sessions[0]?.id
	)
		throw new Error("sandbox creation is ambiguous");
	return { sessionId: page.sessions[0].id };
}
