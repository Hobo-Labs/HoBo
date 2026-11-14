import { createHash } from "node:crypto";
import { parseSecretRef } from "@hobo/bindings";
import {
	guardTransport,
	type HttpTransport,
	parseResolveRequest,
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
	ResolverError,
	type ResourceResolver,
	type TransportMethod,
	type TransportResponse,
} from "@hobo/core";
import { vercelPreviewBranch } from "./git-branch.js";
import { parseVercelGitEnvironment } from "./git-deployment-environment.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
	parseJsonValue,
} from "./json.js";
import type { VercelResolverOptions } from "./resolvers.js";

/** A Git-built function deployment, staged without assigning production domains. */
// public-contract: versioned Vercel Git function deployment product.
export const VERCEL_GIT_FUNCTION_PRODUCT_ID = "vercel.function/v1";
const API = "https://api.vercel.com";
const MAX_PAGES = 25;

function refuse(message: string): never {
	throw new ResolverError("RESOLVER_PRODUCT_UNSUPPORTED", message);
}
function invalid(message: string): never {
	throw new ResolverError("RESOLVER_OUTPUT_UNPARSEABLE", message);
}
function field(value: JsonObject, key: string): string {
	const item = value[key];
	if (!isJsonString(item) || !item)
		return refuse(`Vercel Git deployment requires ${key}`);
	return item;
}
function identifier(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))
		return refuse("Vercel Git deployment requires a plain scoped identity");
	return value;
}
function body(response: TransportResponse): JsonObject {
	const value = parseJsonValue(response.body);
	if (!isJsonObject(value))
		return invalid("Vercel returned an invalid JSON object");
	return value;
}
function check(response: TransportResponse, statuses: readonly number[]): void {
	if (!statuses.includes(response.status))
		throw new ResolverError(
			"RESOLVER_PROVIDER_REJECTED",
			`Vercel Git deployment API returned HTTP ${response.status}`,
		);
}
function parse(raw: ResolveRequest): ResolveRequest {
	const request = parseResolveRequest(parseJsonObject(JSON.stringify(raw)));
	if (request.ref.productId !== VERCEL_GIT_FUNCTION_PRODUCT_ID)
		return refuse("Vercel Git deployment product differs from request");
	if (request.desired.source === true && !request.ref.physicalId)
		return refuse(
			"Vercel source deployment requires its exact approved native identity",
		);
	return request;
}
function desired(request: ResolveRequest) {
	const record = request.desired;
	const project = identifier(field(record, "project"));
	const projectId = record.projectId;
	if (
		projectId !== undefined &&
		(!isJsonString(projectId) || !identifier(projectId))
	)
		return refuse(
			"Vercel Git deployment requires a valid pinned project identity",
		);
	const organization = identifier(field(record, "organization"));
	const repository = identifier(field(record, "repository"));
	const revision = field(record, "revision");
	if (!/^[a-f0-9]{40}$/u.test(revision))
		return refuse("Vercel Git deployment requires a full Git SHA");
	const rootDirectory = field(record, "rootDirectory");
	if (
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(rootDirectory) ||
		rootDirectory.split("/").some((part) => part === "." || part === "..")
	)
		return refuse("Vercel Git deployment requires a safe repository root");
	const buildCommand = field(record, "buildCommand");
	if (buildCommand.length > 256)
		return refuse("Vercel build command exceeds its bound");
	const installCommand = record.installCommand;
	if (
		installCommand !== undefined &&
		(!isJsonString(installCommand) ||
			!installCommand ||
			installCommand.length > 256)
	)
		return refuse("Vercel install command must be a non-empty bounded string");
	const operationId = field(record, "operationId");
	const environment = record.environment ?? "production";
	if (environment !== "production" && environment !== "preview")
		return refuse(
			"Vercel Git deployment requires production or preview environment",
		);
	const previewBranch =
		record.previewBranch === undefined
			? undefined
			: vercelPreviewBranch(record.previewBranch);
	if (previewBranch !== undefined && environment !== "preview")
		return refuse(
			"Vercel preview branch is only valid for a preview deployment",
		);
	let environmentVariables: ReturnType<typeof parseVercelGitEnvironment> = [];
	if (record.environmentVariables !== undefined) {
		if (!isJsonString(projectId))
			return refuse(
				"Vercel deployment environment requires a pinned project identity",
			);
		environmentVariables = parseVercelGitEnvironment(
			record.environmentVariables,
			{ teamId: field(record, "teamId"), projectId, revision },
		);
		if (request.desired.source === true && environmentVariables.length)
			return refuse(
				"Vercel source adoption cannot establish the approved deployment environment",
			);
	}
	return {
		project,
		...(isJsonString(projectId) ? { projectId } : undefined),
		organization,
		repository,
		revision,
		rootDirectory,
		buildCommand,
		...(isJsonString(installCommand) ? { installCommand } : undefined),
		operationId,
		...(previewBranch ? { previewBranch } : undefined),
		...(environmentVariables.length ? { environmentVariables } : undefined),
		// Keep the existing production operation marker stable. Vercel represents
		// preview by omitting target when creating and as null when observing.
		...(environment === "preview" ? { environment } : undefined),
	};
}
function marker(request: ResolveRequest): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(desired(request)))
		.digest("hex")}`;
}
function outcome(
	action: "create" | "adopt" | "noop",
	outputs: JsonObject,
): ResolveOutcome {
	return {
		contract: RESOLVER_CONTRACT,
		action,
		physicalId: field(outputs, "id"),
		outputs,
		diagnostics: [],
	};
}

/** The host supplies an independent build attestation; a Git SHA is not a hash
 * of Vercel's built output and an operation marker is not content evidence. */
export function createVercelGitFunctionResolver(
	options: VercelResolverOptions,
): ResourceResolver {
	const team = options.teamId ? identifier(options.teamId) : "";
	const verifyEnvironment = async (request: ResolveRequest): Promise<void> => {
		const d = desired(request);
		if (!d.environmentVariables?.length) return;
		if (!d.projectId || !options.verifyGitDeploymentEnvironment)
			return refuse(
				"Vercel deployment environment requires trusted host verification",
			);
		let verified = false;
		try {
			verified = await options.verifyGitDeploymentEnvironment({
				teamId: team,
				projectId: d.projectId,
				revision: d.revision,
				environment: d.environment === "preview" ? "preview" : "production",
				variables: d.environmentVariables,
			});
		} catch {
			/* do not expose verifier errors */
		}
		if (!verified)
			return refuse(
				"Vercel deployment environment did not match the approved host context",
			);
	};
	const query = (params: Record<string, string> = {}) =>
		`?${new URLSearchParams({ ...params, teamId: team })}`;
	const caller = async (request: ResolveRequest, transport: HttpTransport) => {
		if (!team)
			return refuse("Vercel Git deployments require an explicit team scope");
		if (field(request.desired, "teamId") !== team)
			return refuse("Vercel Git target differs from the verified team scope");
		try {
			parseSecretRef(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_NOT_A_REF",
				"Vercel credential must be a scoped custody locator",
			);
		}
		let token: string;
		try {
			token = await options.resolveCredential(request.credentialRef);
		} catch {
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Vercel credential custody could not resolve the scoped reference",
			);
		}
		if (!token.trim())
			throw new ResolverError(
				"RESOLVER_CREDENTIAL_MISSING",
				"Vercel credential custody returned no material",
			);
		const send = guardTransport(transport, {
			allowedHosts: ["api.vercel.com"],
			allowedPathPrefixes: [
				"/v9/projects",
				"/v7/deployments",
				"/v13/deployments",
			],
			maxTimeoutMs: 15000,
			maxResponseBytes: 524288,
		});
		return async (method: TransportMethod, path: string, data?: JsonObject) => {
			const serialized = data === undefined ? undefined : JSON.stringify(data);
			const outbound = {
				method,
				url: API + path,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					...(serialized === undefined
						? undefined
						: { "content-type": "application/json" }),
				},
				timeoutMs: 15000,
				maxResponseBytes: 524288,
				...(serialized === undefined ? undefined : { body: serialized }),
			};
			if (method === "GET") {
				try {
					return await send(outbound);
				} catch {
					throw new ResolverError(
						"RESOLVER_PROVIDER_REJECTED",
						"Vercel API read failed",
					);
				}
			}
			const journal = options.mutationJournal;
			if (journal?.persistence !== "durable-cas")
				return refuse("Vercel mutations require a durable mutation journal");
			const mutationId = JSON.stringify([
				"vercel-git",
				team,
				desired(request).project,
				desired(request).operationId,
				method,
				path,
			]);
			const requestDigest = `sha256:${createHash("sha256")
				.update(JSON.stringify({ url: outbound.url, body: serialized ?? "" }))
				.digest("hex")}`;
			if (
				(await journal.claim({ mutationId, requestDigest })).status !==
				"claimed"
			)
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					"Vercel mutation was already attempted; observe the existing result",
				);
			try {
				const response = await send(outbound);
				if (response.status >= 200 && response.status < 300)
					await journal.acknowledge(mutationId, requestDigest);
				else await journal.uncertain(mutationId, requestDigest);
				return response;
			} catch {
				await journal.uncertain(mutationId, requestDigest);
				throw new ResolverError(
					"RESOLVER_PROVIDER_REJECTED",
					"Vercel API mutation outcome is uncertain",
				);
			}
		};
	};
	type Caller = Awaited<ReturnType<typeof caller>>;
	const project = async (
		request: ResolveRequest,
		send: Caller,
	): Promise<JsonObject | undefined> => {
		const d = desired(request);
		const response = await send(
			"GET",
			`/v9/projects/${encodeURIComponent(d.project)}${query()}`,
		);
		if (response.status === 404) return undefined;
		check(response, [200]);
		const record = body(response);
		if (
			record.name !== d.project ||
			record.accountId !== team ||
			!isJsonString(record.id) ||
			(d.projectId !== undefined && record.id !== d.projectId)
		)
			return invalid(
				"Vercel project identity or account differs from the approved scope",
			);
		return record;
	};
	const projectReady = (request: ResolveRequest, record: JsonObject) => {
		const d = desired(request);
		return (
			record.rootDirectory === d.rootDirectory &&
			record.buildCommand === d.buildCommand &&
			(d.installCommand === undefined ||
				record.installCommand === d.installCommand)
		);
	};
	const observe = async (
		request: ResolveRequest,
		transport: HttpTransport,
		verifyArtifact = true,
		requireOwnership = false,
	): Promise<JsonObject | undefined> => {
		const d = desired(request),
			send = await caller(request, transport),
			p = await project(request, send);
		if (!p) return undefined;
		const projectId = identifier(field(p, "id"));
		let id = request.ref.physicalId;
		if (!id) {
			const found: string[] = [];
			let until = "";
			const seen = new Set<string>();
			for (let page = 0; page < MAX_PAGES; page++) {
				const response = await send(
					"GET",
					`/v7/deployments${query({ projectId, limit: "100", ...(until ? { until } : undefined) })}`,
				);
				check(response, [200]);
				const list = body(response);
				if (!isJsonArray(list.deployments))
					return invalid("Vercel returned an invalid deployment list");
				for (const item of list.deployments) {
					if (!isJsonObject(item))
						return invalid("Vercel returned an invalid deployment list entry");
					if (
						isJsonObject(item.meta) &&
						item.meta.hoboOperation === marker(request)
					)
						found.push(isJsonString(item.uid) ? item.uid : field(item, "id"));
				}
				const next = isJsonObject(list.pagination)
					? list.pagination.next
					: undefined;
				if (next === null || next === undefined) {
					if (found.length > 1)
						return invalid(
							"multiple Vercel deployments claim the same operation",
						);
					id = found[0];
					break;
				}
				if (!(isJsonNumber(next) || isJsonString(next)))
					return invalid("invalid Vercel pagination cursor");
				until = String(next);
				if (seen.has(until))
					return invalid("Vercel repeated its deployment pagination cursor");
				seen.add(until);
				if (page === MAX_PAGES - 1)
					return invalid("Vercel deployment discovery exceeded its bound");
			}
			if (!id) return undefined;
		}
		const response = await send(
			"GET",
			`/v13/deployments/${encodeURIComponent(identifier(id))}${query({ withGitRepoInfo: "true" })}`,
		);
		if (response.status === 404 || response.status === 410) return undefined;
		check(response, [200]);
		const record = body(response),
			meta = record.meta;
		const observedProject = isJsonString(record.projectId)
			? record.projectId
			: isJsonObject(record.project)
				? record.project.id
				: undefined;
		if (
			record.id !== id ||
			observedProject !== projectId ||
			(isJsonObject(record.team) && record.team.id !== team) ||
			!isJsonObject(meta) ||
			(request.desired.source !== true &&
				meta.hoboOperation !== marker(request)) ||
			meta.githubCommitSha !== d.revision ||
			meta.githubOrg !== d.organization ||
			meta.githubRepo !== d.repository ||
			(d.previewBranch !== undefined &&
				meta.githubCommitRef !== d.previewBranch) ||
			record.target !== (d.environment === "preview" ? null : "production")
		)
			return invalid(
				"Vercel deployment identity, scope, revision or operation differs from the approved artifact",
			);
		// Adopting a source for reading is not ownership: destroying it needs
		// the HoBo operation marker, never only a matching Git revision.
		if (requireOwnership && meta.hoboOperation !== marker(request))
			return refuse(
				"Vercel deletion requires the HoBo operation marker; an adopted deployment HoBo did not create is never destroyed",
			);
		const state = field(record, "readyState"),
			terminal = ["READY", "ERROR", "CANCELED"].includes(state);
		let artifact: JsonObject = {};
		if (state === "READY" && verifyArtifact) {
			if (!projectReady(request, p))
				return invalid(
					"Vercel project build settings differ from the approved configuration",
				);
			const rawUrl = field(record, "url"),
				url = new URL(
					rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`,
				);
			if (
				url.protocol !== "https:" ||
				!url.hostname.endsWith(".vercel.app") ||
				url.username ||
				url.password ||
				url.port ||
				url.pathname !== "/" ||
				url.search ||
				url.hash
			)
				return invalid("Vercel immutable deployment URL is invalid");
			if (!options.observeGitArtifact)
				return refuse(
					"Vercel Git deployment requires independent build artifact evidence",
				);
			const observed = await options.observeGitArtifact({
				teamId: team,
				projectId,
				deploymentId: id,
				revision: d.revision,
				repository: `${d.organization}/${d.repository}`,
				endpoint: url.origin,
			});
			if (!/^sha256:[a-f0-9]{64}$/u.test(observed))
				return invalid("Vercel build artifact evidence is invalid");
			artifact = { artifactDigest: observed, servingEndpoint: url.origin };
		}
		return {
			id,
			projectId,
			state,
			ready: state === "READY",
			operationConfirmed: terminal,
			lifecycleStatus:
				state === "READY" ? "ready" : terminal ? "failed" : "pending",
			...artifact,
		};
	};
	const retirementProof = async (
		request: ResolveRequest,
		projectId: string,
	) => {
		if (!request.ref.physicalId || !options.verifyGitRetirement)
			return refuse(
				"Vercel deployment retirement requires verified queue drain and producer fences",
			);
		const d = desired(request);
		let proof:
			| Awaited<
					ReturnType<NonNullable<VercelResolverOptions["verifyGitRetirement"]>>
			  >
			| undefined;
		try {
			proof = await options.verifyGitRetirement({
				teamId: team,
				projectId,
				deploymentId: request.ref.physicalId,
				revision: d.revision,
				repository: `${d.organization}/${d.repository}`,
			});
		} catch {
			/* Do not expose custody or provider details. */
		}
		if (
			!proof?.queuesDrained ||
			!proof.fencedUntilRetired ||
			!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(proof.evidenceRef)
		)
			return refuse(
				"Vercel deployment retirement requires verified queue drain and producer fences",
			);
	};
	/** Absence is a scoped, authorized inventory observation, never a 404. */
	const observeAbsence = async (
		request: ResolveRequest,
		transport: HttpTransport,
	): Promise<boolean> => {
		const d = desired(request),
			deploymentId = request.ref.physicalId;
		if (!deploymentId || !d.projectId || !options.verifyGitInventoryAccess)
			return refuse(
				"Vercel deployment absence requires a pinned project, native deployment and verified inventory access",
			);
		identifier(deploymentId);
		const nowMs = options.gitInventoryNowMs ?? Date.now;
		const verifyAccess = async () => {
			const at = nowMs();
			if (!Number.isSafeInteger(at) || at < 0)
				return refuse("Vercel deployment inventory clock is invalid");
			let proof:
				| Awaited<
						ReturnType<
							NonNullable<VercelResolverOptions["verifyGitInventoryAccess"]>
						>
				  >
				| undefined;
			try {
				proof = await options.verifyGitInventoryAccess?.({
					teamId: team,
					projectId: d.projectId ?? "",
					deploymentId,
					credentialRef: request.credentialRef,
				});
			} catch {
				/* Do not expose custody or provider details. */
			}
			if (
				!proof ||
				proof.teamId !== team ||
				proof.projectId !== d.projectId ||
				proof.deploymentId !== deploymentId ||
				proof.credentialRef !== request.credentialRef ||
				!proof.readDeployment ||
				!proof.enumerateAllDeployments ||
				!Number.isSafeInteger(proof.observedAtMs) ||
				proof.observedAtMs > at ||
				at - proof.observedAtMs > 300_000 ||
				!Number.isSafeInteger(proof.expiresAtMs) ||
				proof.expiresAtMs <= at ||
				proof.expiresAtMs - proof.observedAtMs > 900_000 ||
				!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(proof.evidenceRef)
			)
				return refuse(
					"Vercel deployment inventory permission is unavailable or out of scope",
				);
		};
		const send = await caller(request, transport);
		const p = await project(request, send);
		if (!p || p.id !== d.projectId)
			return refuse("Vercel deployment project scope is unavailable");
		await verifyAccess();
		const first = await send(
			"GET",
			`/v13/deployments/${encodeURIComponent(deploymentId)}${query({ withGitRepoInfo: "true" })}`,
		);
		if (first.status === 200) {
			const record = body(first);
			const owner = isJsonString(record.projectId)
				? record.projectId
				: isJsonObject(record.project)
					? record.project.id
					: undefined;
			if (
				record.id !== deploymentId ||
				owner !== d.projectId ||
				(isJsonObject(record.team) && record.team.id !== team)
			)
				return invalid(
					"Vercel deployment identity differs from the approved scope",
				);
			return false;
		}
		if (first.status !== 404 && first.status !== 410) check(first, [200]);
		const seen = new Set<string>();
		let until = "",
			complete = false;
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = await send(
				"GET",
				`/v7/deployments${query({ projectId: d.projectId, limit: "100", ...(until ? { until } : undefined) })}`,
			);
			check(response, [200]);
			const record = body(response);
			if (
				!isJsonArray(record.deployments) ||
				!isJsonObject(record.pagination) ||
				!("next" in record.pagination)
			)
				return invalid("Vercel deployment inventory is incomplete");
			for (const row of record.deployments) {
				if (!isJsonObject(row))
					return invalid("Vercel deployment inventory entry is invalid");
				const id = isJsonString(row.uid)
					? row.uid
					: isJsonString(row.id)
						? row.id
						: undefined;
				if (
					!id ||
					!identifier(id) ||
					(row.projectId !== undefined && row.projectId !== d.projectId) ||
					(isJsonObject(row.team) && row.team.id !== team)
				)
					return invalid(
						"Vercel deployment inventory entry is outside the approved project",
					);
				if (id === deploymentId) return false;
			}
			const next = record.pagination.next;
			if (next === null) {
				complete = true;
				break;
			}
			if (!(isJsonString(next) || isJsonNumber(next)))
				return invalid("Vercel deployment inventory cursor is invalid");
			until = String(next);
			if (!/^\d{1,20}$/u.test(until) || seen.has(until))
				return invalid(
					"Vercel deployment inventory cursor is repeated or invalid",
				);
			seen.add(until);
		}
		if (!complete)
			return invalid("Vercel deployment inventory exceeded its bound");
		await verifyAccess();
		await retirementProof(request, d.projectId);
		const finalProject = await project(request, send);
		if (!finalProject || finalProject.id !== d.projectId)
			return refuse(
				"Vercel deployment project scope changed during retirement observation",
			);
		const final = await send(
			"GET",
			`/v13/deployments/${encodeURIComponent(deploymentId)}${query({ withGitRepoInfo: "true" })}`,
		);
		if (final.status === 200) return false;
		if (final.status !== 404 && final.status !== 410) check(final, [200]);
		await verifyAccess();
		return true;
	};
	return {
		providerId: "vercel",
		productId: VERCEL_GIT_FUNCTION_PRODUCT_ID,
		async read(raw, transport) {
			const request = parse(raw);
			await verifyEnvironment(request);
			const found = await observe(request, transport);
			return found ? outcome("noop", found) : undefined;
		},
		async reconcile(raw, transport) {
			const request = parse(raw);
			await verifyEnvironment(request);
			const existing = await observe(request, transport);
			if (existing)
				return outcome(request.ref.physicalId ? "noop" : "adopt", existing);
			if (request.ref.physicalId)
				return refuse(
					"known Vercel deployment is absent; a fresh deployment needs a new approved intent",
				);
			if (!options.observeGitArtifact)
				return refuse(
					"Vercel Git deployment requires independent build artifact evidence",
				);
			const d = desired(request),
				send = await caller(request, transport);
			let p = await project(request, send);
			let createdHere = false;
			if (!p) {
				if (d.projectId)
					return refuse(
						"the approved Vercel project is absent; a new project requires a new approved intent",
					);
				const created = await send("POST", `/v9/projects${query()}`, {
					name: d.project,
					rootDirectory: d.rootDirectory,
					buildCommand: d.buildCommand,
					...(d.installCommand
						? { installCommand: d.installCommand }
						: undefined),
				});
				check(created, [200, 201]);
				p = await project(request, send);
				if (!p)
					return invalid("Vercel project creation lacks independent readback");
				createdHere = true;
			}
			if (!projectReady(request, p)) {
				// A name match is not ownership: only a pinned project or one this
				// reconcile created may have its build settings rewritten.
				if (!d.projectId && !createdHere)
					return refuse(
						"Vercel project matched by name differs from the approved build settings and HoBo did not create it; pin its projectId to approve rewriting it",
					);
				const updated = await send(
					"PATCH",
					`/v9/projects/${encodeURIComponent(identifier(field(p, "id")))}${query()}`,
					{
						rootDirectory: d.rootDirectory,
						buildCommand: d.buildCommand,
						...(d.installCommand
							? { installCommand: d.installCommand }
							: undefined),
					},
				);
				check(updated, [200]);
				p = await project(request, send);
				if (!p || !projectReady(request, p))
					return invalid("Vercel project settings lack independent readback");
			}
			const response = await send("POST", `/v13/deployments${query()}`, {
				name: d.project,
				project: identifier(field(p, "id")),
				projectSettings: {
					rootDirectory: d.rootDirectory,
					buildCommand: d.buildCommand,
					...(d.installCommand
						? { installCommand: d.installCommand }
						: undefined),
					framework: null,
					sourceFilesOutsideRootDirectory: true,
				},
				gitSource: {
					type: "github",
					org: d.organization,
					repo: d.repository,
					ref: d.previewBranch ?? d.revision,
					sha: d.revision,
				},
				...(d.environment === "preview" ? undefined : { target: "production" }),
				autoAssignCustomDomains: false,
				...(d.environmentVariables?.length
					? {
							env: Object.fromEntries(
								d.environmentVariables.map(({ name, value }) => [name, value]),
							),
						}
					: undefined),
				meta: { hoboOperation: marker(request) },
			});
			check(response, [200, 201]);
			const id = identifier(field(body(response), "id"));
			const result = await observe(
				{ ...request, ref: { ...request.ref, physicalId: id } },
				transport,
			);
			if (!result)
				return invalid(
					"Vercel deployment acknowledgment lacks independent readback",
				);
			return outcome("create", result);
		},
		async delete(raw, transport) {
			const request = parse(raw);
			if (!request.ref.physicalId)
				return refuse("Vercel deletion requires an observed physical identity");
			const existing = await observe(request, transport, false, true);
			if (!existing) {
				if (await observeAbsence(request, transport)) return;
				return refuse("Vercel deployment retirement remains unconfirmed");
			}
			await retirementProof(request, field(existing, "projectId"));
			const send = await caller(request, transport);
			check(
				await send(
					"DELETE",
					`/v13/deployments/${encodeURIComponent(identifier(request.ref.physicalId))}${query()}`,
				),
				[200, 204, 404, 410],
			);
		},
		async observeAbsence(raw, transport) {
			return observeAbsence(parse(raw), transport);
		},
	};
}
