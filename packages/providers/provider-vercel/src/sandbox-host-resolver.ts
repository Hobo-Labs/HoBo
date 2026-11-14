/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this resolver validates the untrusted Sandbox workload, provider responses and proof at its boundary. */
/** Attach CI to Vercel Sandbox, without creating a VM during deployment. */

import { parseSecretRef } from "@hobo/bindings";
import {
	guardTransport,
	type HttpTransport,
	parseResolveOutcome,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
} from "@hobo/core";
import {
	isJsonArray,
	isJsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import type { VercelResolverOptions } from "./resolvers.js";

// public-contract: versioned attach-only Vercel Sandbox host product identifier.
export const VERCEL_SANDBOX_HOST_PRODUCT_ID = "vercel.sandbox-host/v1";

/** The representative Broker lease, covering the guest and its proxy VM. */
export type VercelSandboxWorkload = Readonly<{
	guestDurationMs: number;
	proxyDurationMs: number;
	guestVcpus: number;
	guestMemoryMb: number;
	proxyVcpus: number;
	proxyMemoryMb: number;
	guestNetworkBytes: number;
	proxyNetworkBytes: number;
	maxControlCalls: number;
}>;

export type VercelSandboxHostScope = Readonly<{
	teamId: string;
	projectId: string;
	organization: string;
	repository: string;
	revision: string;
	environment: "production" | "preview";
	minimumSlots: number;
	workload: VercelSandboxWorkload;
}>;

/** Issued by a trusted host adapter, not by the untrusted app declaration.
 * The verifier must check the Vercel runtime identity, scoped permission,
 * current capacity, provider pricing and the actual Broker lease/offer. */
export type VercelSandboxHostProof = Readonly<{
	scope: VercelSandboxHostScope;
	workloadIdentityVerified: true;
	createAuthorized: true;
	availableSlots: number;
	/** Separate proof, bound to this same scope, that the hosting credential
	 * and Git installation may perform the planned repository link. */
	gitLinkAuthorization?: Readonly<{
		authorized: true;
		observedAtMs: number;
		expiresAtMs: number;
		evidenceRef: string;
	}>;
	quote: Readonly<{
		currency: "USD";
		totalMicros: number;
		includesComputeAndMemory: true;
		includesNetwork: true;
		includesFixedCosts: true;
		includesAllowances: true;
	}>;
	observedAtMs: number;
	expiresAtMs: number;
	evidenceRef: string;
}>;

export type VercelSandboxHostEvidence = Readonly<{
	projectId: string;
	teamId: string;
	projectLink: "linked" | "requires-link";
	gitLinkAuthorization: "verified" | "not-required" | "not-observed";
	sandboxRead: "verified";
	workloadIdentity: "verified" | "not-observed";
	createAuthorization: "verified" | "not-observed";
	capacity: "verified" | "not-observed";
	quote?: VercelSandboxHostProof["quote"];
	evidenceRef?: string;
	expiresAtMs?: number;
}>;

function refuse(message: string): never {
	throw new ResolverError(
		"RESOLVER_PRODUCT_UNSUPPORTED",
		message,
		VERCEL_SANDBOX_HOST_PRODUCT_ID,
	);
}
function providerError(message: string): never {
	throw new ResolverError(
		"RESOLVER_PROVIDER_REJECTED",
		message,
		VERCEL_SANDBOX_HOST_PRODUCT_ID,
	);
}
function plain(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
	);
}
function count(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}
function scope(raw: unknown): VercelSandboxHostScope {
	const value = parseJsonValue(JSON.stringify(raw));
	if (!isJsonObject(value) || !isJsonObject(value.workload))
		return refuse("Sandbox host requires an approved workload envelope");
	const {
		teamId,
		projectId,
		organization,
		repository,
		revision,
		environment,
		minimumSlots,
		workload,
	} = value;
	const workloadKeys = [
		"guestDurationMs",
		"proxyDurationMs",
		"guestVcpus",
		"guestMemoryMb",
		"proxyVcpus",
		"proxyMemoryMb",
		"guestNetworkBytes",
		"proxyNetworkBytes",
		"maxControlCalls",
	];
	if (
		Object.keys(workload).length !== workloadKeys.length ||
		workloadKeys.some((key) => !Object.hasOwn(workload, key))
	)
		return refuse("Sandbox workload envelope contains unsupported fields");
	if (
		!plain(teamId) ||
		!plain(projectId) ||
		!projectId.startsWith("prj_") ||
		!plain(organization) ||
		!plain(repository) ||
		typeof revision !== "string" ||
		!/^[a-f0-9]{40}$/u.test(revision) ||
		(environment !== "production" && environment !== "preview") ||
		!count(minimumSlots, 2)
	)
		return refuse("Sandbox host requires an exact scoped project and revision");
	const {
		guestDurationMs,
		proxyDurationMs,
		guestVcpus,
		guestMemoryMb,
		proxyVcpus,
		proxyMemoryMb,
		guestNetworkBytes,
		proxyNetworkBytes,
		maxControlCalls,
	} = workload;
	if (
		!count(guestDurationMs, 1) ||
		!count(proxyDurationMs, guestDurationMs) ||
		!count(guestVcpus, 1) ||
		!count(guestMemoryMb, 1) ||
		!count(proxyVcpus, 1) ||
		!count(proxyMemoryMb, 1) ||
		!count(guestNetworkBytes, 0) ||
		!count(proxyNetworkBytes, 0) ||
		!count(maxControlCalls, 0)
	)
		return refuse(
			"Sandbox host requires a bounded guest and proxy workload envelope",
		);
	return {
		teamId,
		projectId,
		organization,
		repository,
		revision,
		environment,
		minimumSlots,
		workload: {
			guestDurationMs,
			proxyDurationMs,
			guestVcpus,
			guestMemoryMb,
			proxyVcpus,
			proxyMemoryMb,
			guestNetworkBytes,
			proxyNetworkBytes,
			maxControlCalls,
		},
	};
}
function sameScope(
	left: VercelSandboxHostScope,
	right: VercelSandboxHostScope,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
function evidenceRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value)
	);
}

/** Read-only evidence. A successful Sandbox listing proves read access only;
 * actual VM-creation authority and capacity require a separate host proof. */
export async function preflightVercelSandboxHost(
	input: VercelSandboxHostScope & { readonly credentialRef: string },
	options: VercelResolverOptions,
	transport: HttpTransport,
): Promise<VercelSandboxHostEvidence> {
	const expected = scope(input);
	if (options.teamId !== expected.teamId)
		return refuse("Sandbox host differs from the verified Vercel team");
	try {
		parseSecretRef(input.credentialRef);
	} catch {
		return refuse("Sandbox provider credential must be a custody locator");
	}
	let token: string;
	try {
		token = await options.resolveCredential(input.credentialRef);
	} catch {
		return providerError("Sandbox provider credential is unavailable");
	}
	if (!token.trim())
		return providerError("Sandbox provider credential is unavailable");
	const guarded = guardTransport(transport, {
		allowedHosts: ["api.vercel.com", "vercel.com"],
		allowedPathPrefixes: ["/v9/projects", "/api/v2/sandboxes"],
		maxTimeoutMs: 15000,
		maxResponseBytes: 524288,
	});
	const get = async (url: string) => {
		try {
			return await guarded({
				method: "GET",
				url,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
				},
				timeoutMs: 15000,
				maxResponseBytes: 524288,
			});
		} catch {
			return providerError("Sandbox provider read failed");
		}
	};
	const query = new URLSearchParams({ teamId: expected.teamId });
	const [projectResponse, listResponse] = await Promise.all([
		get(
			`https://api.vercel.com/v9/projects/${encodeURIComponent(expected.projectId)}?${query}`,
		),
		get(
			`https://vercel.com/api/v2/sandboxes?${new URLSearchParams({ teamId: expected.teamId, project: expected.projectId, limit: "1" })}`,
		),
	]);
	if (projectResponse.status !== 200 || listResponse.status !== 200)
		return providerError(
			`Sandbox provider read failed (project HTTP ${projectResponse.status}, Sandbox HTTP ${listResponse.status})`,
		);
	const project = parseJsonValue(projectResponse.body),
		list = parseJsonValue(listResponse.body);
	if (
		!isJsonObject(project) ||
		project.id !== expected.projectId ||
		project.accountId !== expected.teamId ||
		!isJsonObject(list) ||
		!isJsonArray(list.sandboxes)
	)
		return providerError(
			"Sandbox provider response does not prove the scoped project and API",
		);
	if (
		project.link !== undefined &&
		project.link !== null &&
		!isJsonArray(project.link) &&
		!isJsonObject(project.link)
	)
		return providerError("Sandbox project Git linkage is invalid");
	const links = isJsonArray(project.link)
		? project.link
		: isJsonObject(project.link)
			? [project.link]
			: [];
	if (
		links.length > 0 &&
		(links.length !== 1 ||
			!isJsonObject(links[0]) ||
			!["github", "github-limited"].includes(String(links[0].type)) ||
			links[0].org !== expected.organization ||
			links[0].repo !== expected.repository ||
			links[0].sourceless === true)
	)
		return refuse("Sandbox project is linked to a different repository");
	const projectLink: "linked" | "requires-link" = links.length
		? "linked"
		: "requires-link";
	const base = {
		teamId: expected.teamId,
		projectId: expected.projectId,
		projectLink,
		sandboxRead: "verified" as const,
	};
	if (!options.verifySandboxHost)
		return {
			...base,
			gitLinkAuthorization:
				projectLink === "linked" ? "not-required" : "not-observed",
			workloadIdentity: "not-observed",
			createAuthorization: "not-observed",
			capacity: "not-observed",
		};
	if (!options.sandboxNowMs)
		return refuse("Sandbox host proof requires an injected clock");
	let proof: VercelSandboxHostProof;
	try {
		proof = await options.verifySandboxHost(expected);
	} catch {
		return providerError(
			"Sandbox authorization, capacity and quote could not be verified",
		);
	}
	let now: number;
	try {
		now = options.sandboxNowMs();
	} catch {
		return providerError("Sandbox evidence clock is unavailable");
	}
	let proofScope: VercelSandboxHostScope;
	try {
		proofScope = scope(proof.scope);
	} catch {
		return providerError("Sandbox host evidence has an invalid scope");
	}
	if (
		!sameScope(expected, proofScope) ||
		proof.workloadIdentityVerified !== true ||
		proof.createAuthorized !== true ||
		!count(proof.availableSlots, expected.minimumSlots) ||
		!proof.quote ||
		proof.quote.currency !== "USD" ||
		!count(proof.quote.totalMicros, 0) ||
		proof.quote.includesComputeAndMemory !== true ||
		proof.quote.includesNetwork !== true ||
		proof.quote.includesFixedCosts !== true ||
		proof.quote.includesAllowances !== true ||
		!count(now, 0) ||
		!count(proof.observedAtMs, 0) ||
		!count(proof.expiresAtMs, 1) ||
		proof.observedAtMs > now ||
		now - proof.observedAtMs > 60000 ||
		proof.expiresAtMs <= now ||
		proof.expiresAtMs > proof.observedAtMs + 300000 ||
		!evidenceRef(proof.evidenceRef)
	)
		return providerError(
			"Sandbox host evidence is incomplete, expired or does not match the approved workload",
		);
	const link = proof.gitLinkAuthorization;
	if (
		link &&
		(link.authorized !== true ||
			!count(link.observedAtMs, 0) ||
			!count(link.expiresAtMs, 1) ||
			link.observedAtMs > now ||
			now - link.observedAtMs > 60000 ||
			link.expiresAtMs <= now ||
			link.expiresAtMs > link.observedAtMs + 300000 ||
			!evidenceRef(link.evidenceRef))
	)
		return providerError(
			"Vercel Git link authorization evidence is incomplete or expired",
		);
	return {
		...base,
		gitLinkAuthorization:
			projectLink === "linked"
				? "not-required"
				: link
					? "verified"
					: "not-observed",
		workloadIdentity: "verified",
		createAuthorization: "verified",
		capacity: "verified",
		quote: proof.quote,
		evidenceRef: proof.evidenceRef,
		expiresAtMs:
			projectLink === "requires-link" && link
				? Math.min(proof.expiresAtMs, link.expiresAtMs)
				: proof.expiresAtMs,
	};
}

/** This resource adopts a scoped host; individual VM lifecycle belongs to the CI controller. */
export function createVercelSandboxHostResolver(
	options: VercelResolverOptions,
): ResourceResolver {
	const parse = (raw: ResolveRequest) => {
		const request = parseResolveRequest(parseJsonObject(JSON.stringify(raw)));
		const approved = scope(request.desired);
		if (
			request.ref.productId !== VERCEL_SANDBOX_HOST_PRODUCT_ID ||
			request.ref.slot !== "service" ||
			(request.ref.physicalId !== undefined &&
				request.ref.physicalId !== approved.projectId)
		)
			return refuse("Sandbox attachment differs from its approved identity");
		return { request, approved };
	};
	const observe = async (
		raw: ResolveRequest,
		transport: HttpTransport,
		reading = false,
	) => {
		const { request, approved } = parse(raw);
		const evidence = await preflightVercelSandboxHost(
			{ ...approved, credentialRef: request.credentialRef },
			options,
			transport,
		);
		if (
			evidence.projectLink !== "linked" ||
			evidence.workloadIdentity !== "verified" ||
			evidence.createAuthorization !== "verified" ||
			evidence.capacity !== "verified" ||
			!evidence.quote ||
			!evidence.evidenceRef ||
			!evidence.expiresAtMs
		)
			return refuse(
				"Sandbox attachment requires the linked project and fresh workload, authorization, capacity and cost evidence",
			);
		return parseResolveOutcome({
			contract: RESOLVER_CONTRACT,
			action: reading || request.ref.physicalId ? "noop" : "adopt",
			physicalId: approved.projectId,
			outputs: {
				teamId: approved.teamId,
				projectId: approved.projectId,
				revision: approved.revision,
				environment: approved.environment,
				minimumSlots: approved.minimumSlots,
				quoteMicros: evidence.quote.totalMicros,
				quoteCurrency: evidence.quote.currency,
				evidenceRef: evidence.evidenceRef,
				expiresAtMs: evidence.expiresAtMs,
			},
			diagnostics: [
				"Sandbox host observed; Broker admission and per-job reservation remain required",
			],
		});
	};
	return Object.freeze({
		providerId: "vercel",
		productId: VERCEL_SANDBOX_HOST_PRODUCT_ID,
		reconcile: (request: ResolveRequest, transport: HttpTransport) =>
			observe(request, transport),
		read: (request: ResolveRequest, transport: HttpTransport) =>
			observe(request, transport, true),
		async delete(raw: ResolveRequest) {
			const { request, approved } = parse(raw);
			if (!request.ref.physicalId)
				return refuse(
					"Sandbox attachment retirement requires an observed identity",
				);
			if (!options.retireSandboxHost)
				return refuse(
					"Sandbox attachment retirement requires a durable admission fence and drained sessions",
				);
			let retired: Awaited<
				ReturnType<NonNullable<VercelResolverOptions["retireSandboxHost"]>>
			>;
			try {
				retired = await options.retireSandboxHost(approved);
			} catch {
				return providerError("Sandbox host retirement could not be verified");
			}
			if (
				retired.drained !== true ||
				retired.fencedUntilDetached !== true ||
				!evidenceRef(retired.evidenceRef)
			)
				return refuse(
					"Sandbox attachment retirement requires a durable admission fence and drained sessions",
				);
		},
	});
}
