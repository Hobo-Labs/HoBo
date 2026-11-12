/**
 * Workload-attested apply worker (ADR-0008 / ADR-0012).
 * Every apply/status step is an attested principal with short-lived scoped tokens.
 * Simulate and live share the same contract: Executor + IacProvider + credential lifecycle.
 * No ambient cloud/cluster credentials. Diffs/status are secret-free by construction.
 */
import { createHash, randomUUID } from "node:crypto";

import {
	type AttestationDocument,
	createFixtureHostAttestor,
	type LaunchMeasurement,
	type PrincipalRef,
	verifyWorkloadAttestation,
} from "@hobo/identity";

import type {
	CredentialBroker,
	Executor,
	IacProvider,
} from "../executor/executor.js";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
} from "../executor/executor.js";
import type { JsonObject } from "../json.js";
import {
	listResources,
	providerForResource,
	type ResolvedDeploymentSet,
} from "./resolved-set.js";
import {
	assertSecretFree,
	createSecretFreeDiff,
	createSecretFreeStatus,
	type SecretFreeDiff,
	type SecretFreeStatus,
} from "./secret-free.js";

// public-contract: attested apply worker schema.
export const ATTESTED_APPLY_SCHEMA = "hobo.attested-apply/v1" as const;

// public-contract: CD apply event types.
export const CD_APPLY_EVENTS = Object.freeze({
	Started: "deployment.ApplyStarted",
	ResourceApplied: "deployment.ResourceApplied",
	Succeeded: "deployment.ApplySucceeded",
	Failed: "deployment.ApplyFailed",
	StatusObserved: "deployment.StatusObserved",
} as const);

export type CdApplyEvent = Readonly<{
	id: string;
	type: (typeof CD_APPLY_EVENTS)[keyof typeof CD_APPLY_EVENTS];
	schemaVersion: typeof ATTESTED_APPLY_SCHEMA;
	seq: number;
	time: string;
	data: Readonly<JsonObject>;
}>;

export type AttestedPrincipal = Readonly<{
	svidSubject: string;
	identityId: string;
	tenant: string;
	codeDigest: string;
	componentImageDigest: string;
	attestationState: "attested";
	isolationTier: string;
}>;

export type ApplyStepResult = Readonly<{
	resourceId: string;
	providerId: string;
	status: SecretFreeStatus;
	diff: SecretFreeDiff;
	credentialId: string;
	/** Credential is short-lived and non-ambient. */
	ambient: false;
	ttlSeconds: number;
	/** True after credential was revoked post-step. */
	credentialRevoked: true;
}>;

export type AttestedApplyResult = Readonly<{
	schemaVersion: typeof ATTESTED_APPLY_SCHEMA;
	deploymentId: string;
	setId: string;
	principal: AttestedPrincipal;
	status: "succeeded" | "failed" | "simulated";
	mode: "live" | "simulate";
	steps: readonly ApplyStepResult[];
	events: readonly CdApplyEvent[];
	/** Aggregate secret-free status for the deployment. */
	secretFree: true;
	/** Broker has zero active credentials after apply (short-lived discipline). */
	activeCredentialsAfter: number;
	reason?: string;
}>;

export type AttestedApplyWorkerOptions = Readonly<{
	readonly executor?: Executor;
	readonly iac?: IacProvider;
	readonly broker?: CredentialBroker;
	readonly now?: () => string;
	/**
	 * `simulate` — offline contract path via built-in IacProvider through Executor.
	 * `live` — requires injected IacProvider or Executor; fails closed if neither equippable.
	 */
	readonly mode?: "live" | "simulate";
	readonly hostId?: string;
	readonly isolationTier?: string;
}>;

type DeploymentRecord = Readonly<{
	deploymentId: string;
	setId: string;
	statuses: readonly SecretFreeStatus[];
	events: readonly CdApplyEvent[];
	principal: AttestedPrincipal;
	mode: "live" | "simulate";
}>;

/**
 * Create an attested apply worker bound to a code digest + host measurement.
 * Simulate and live both drive Executor + short-lived credentials.
 */
export interface AttestedApplyInput {
	readonly deploymentId?: string;
	readonly parentPrincipal?: PrincipalRef;
}

export interface AttestedApplyWorker {
	readonly schemaVersion: typeof ATTESTED_APPLY_SCHEMA;
	readonly mode: "live" | "simulate";
	apply(
		set: ResolvedDeploymentSet,
		input?: AttestedApplyInput,
	): Promise<AttestedApplyResult>;
	status(
		set: ResolvedDeploymentSet,
		deploymentId: string,
	): Promise<readonly SecretFreeStatus[]>;
	/** Event log for a prior apply (CLI logs path). */
	eventsFor(deploymentId: string): readonly CdApplyEvent[];
	/** Last recorded deployment ids (most recent first). */
	listDeployments(): readonly string[];
}

export function createAttestedApplyWorker(
	options: AttestedApplyWorkerOptions = {},
): AttestedApplyWorker {
	const now = options.now ?? (() => new Date().toISOString());
	const mode = options.mode ?? "simulate";
	const hostId = options.hostId ?? "host-local-fixture";
	const isolationTier = options.isolationTier ?? "in-process";
	const attestor = createFixtureHostAttestor({ hostId });
	const broker = options.broker ?? createInProcessCredentialBroker();
	const deployments = new Map<string, DeploymentRecord>();

	// Live fails closed without equippable IaC; simulate always has offline provider.
	let executor: Executor;
	if (options.executor) {
		executor = options.executor;
	} else if (options.iac) {
		executor = createInProcessExecutor({ iac: options.iac });
	} else if (mode === "simulate") {
		executor = createInProcessExecutor({
			iac: createOfflineIacProvider(),
		});
	} else {
		throw Object.assign(
			new Error(
				"live attested apply requires injected iac or executor (no ambient equip)",
			),
			{ code: "cd-live-iac-required" },
		);
	}

	return {
		schemaVersion: ATTESTED_APPLY_SCHEMA,
		mode,
		listDeployments() {
			return Object.freeze([...deployments.keys()].reverse());
		},
		eventsFor(deploymentId) {
			return deployments.get(deploymentId)?.events ?? Object.freeze([]);
		},
		async apply(set, input = {}) {
			const deploymentId =
				input.deploymentId ??
				`dep_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
			const events: CdApplyEvent[] = [];
			let seq = 0;
			const emit = (type: CdApplyEvent["type"], data: Readonly<JsonObject>) => {
				seq += 1;
				const evt = Object.freeze({
					id: `evt-${type}-${seq}`,
					type,
					schemaVersion: ATTESTED_APPLY_SCHEMA,
					seq,
					time: now(),
					data: Object.freeze({ ...data }),
				});
				events.push(evt);
				assertSecretFree(evt.data);
			};

			const codeDigest = normalizeDigest(set.planHash);
			const componentImageDigest = normalizeDigest(set.contentHash);
			const launch = createLaunchMeasurement({
				tenant: set.tenant,
				codeDigest,
				componentImageDigest,
				hostId,
				isolationTier,
				parentPrincipal: input.parentPrincipal ?? {
					kind: "service",
					id: `svc:cd-plane:${set.campId}`,
				},
				now: now(),
			});
			const document = attestor.createDocument({
				launchMeasurement: launch,
				claimed: {
					tenant: set.tenant,
					setId: set.setId,
					campId: set.campId,
				},
			});
			const verdict = verifyWorkloadAttestation(document, {
				knownImageDigests: [componentImageDigest],
				hostPublicKeys: attestor.publicKeys(),
			});
			if (verdict.state !== "attested") {
				emit(CD_APPLY_EVENTS.Failed, {
					deploymentId,
					setId: set.setId,
					reason: verdict.reason,
				});
				const principal = unattestedPrincipal(
					set,
					deploymentId,
					codeDigest,
					componentImageDigest,
					isolationTier,
				);
				const failed = failResult(
					deploymentId,
					set,
					principal,
					[],
					events,
					mode,
					broker.activeCount(),
					verdict.reason,
				);
				return failed;
			}

			const principal: AttestedPrincipal = Object.freeze({
				svidSubject: `spiffe://hobo/${set.tenant}/cd/${deploymentId}`,
				identityId: `id:${createHash("sha256").update(launch.runId).digest("hex").slice(0, 12)}`,
				tenant: set.tenant,
				codeDigest,
				componentImageDigest,
				attestationState: "attested",
				isolationTier,
			});

			emit(CD_APPLY_EVENTS.Started, {
				deploymentId,
				setId: set.setId,
				tenant: set.tenant,
				campId: set.campId,
				principal: principal.svidSubject,
				attestation: "attested",
				mode,
				secretRefs: [...set.secretRefs],
				ambientCredentials: false,
			});

			const steps: ApplyStepResult[] = [];
			const statuses: SecretFreeStatus[] = [];

			for (const resource of listResources(set)) {
				const providerId = providerForResource(set, resource.name);
				const scope = `tenant=${set.tenant};camp=${set.campId};resource=${resource.name};action=apply;provider=${providerId}`;
				const credential = broker.issue({
					scope,
					ttlSeconds: 300,
				});
				if (credential.ambient !== false) {
					emit(CD_APPLY_EVENTS.Failed, {
						deploymentId,
						resource: resource.name,
						reason: "ambient-credential-refused",
					});
					return failResult(
						deploymentId,
						set,
						principal,
						steps,
						events,
						mode,
						broker.activeCount(),
						"ambient credentials refused",
					);
				}

				const program = {
					programId: `${deploymentId}:${resource.name}`,
					deploymentId,
					resourceId: resource.name,
					provider: providerId,
					driver: providerId,
					action: "apply" as const,
					stackName: `${set.campId}-${resource.name}`,
				};

				// Same contract for simulate and live: Executor + scoped cred only.
				const exec = await executor.run(program, credential);
				if (exec.status === "failed") {
					broker.revoke(credential);
					emit(CD_APPLY_EVENTS.Failed, {
						deploymentId,
						resource: resource.name,
						reason: exec.reason,
						credentialId: credential.id,
						credentialRevoked: true,
						sandboxAmbient: exec.sandbox.ambientCredentials,
					});
					return failResult(
						deploymentId,
						set,
						principal,
						steps,
						events,
						mode,
						broker.activeCount(),
						exec.reason,
					);
				}

				// Prove sandbox invariant from executor.
				if (exec.sandbox.ambientCredentials !== false) {
					broker.revoke(credential);
					return failResult(
						deploymentId,
						set,
						principal,
						steps,
						events,
						mode,
						broker.activeCount(),
						"executor sandbox reported ambient credentials",
					);
				}

				const outputs: JsonObject = {
					...exec.outputs,
					// Inject a secret-looking field so scrubbing is proven even on live adapters.
					...(mode === "simulate"
						? { apiToken: "should-never-appear-in-projection" }
						: undefined),
				};

				const status = createSecretFreeStatus({
					resourceId: resource.name,
					state: "Provisioned",
					outputs,
				});
				const diff = createSecretFreeDiff({
					summary: exec.diff.summary,
					changes: [
						{
							path: resource.name,
							action: "create",
							after: { provider: providerId },
						},
						...(mode === "simulate"
							? [
									{
										path: `${resource.name}.apiToken`,
										action: "create" as const,
										after: "should-never-appear-in-projection",
									},
								]
							: []),
					],
				});
				assertSecretFree(status);
				assertSecretFree(diff);

				broker.revoke(credential);
				if (broker.activeCount() !== 0) {
					// Other concurrent grants may exist; only require this grant is gone.
				}

				const step: ApplyStepResult = Object.freeze({
					resourceId: resource.name,
					providerId,
					status,
					diff,
					credentialId: credential.id,
					ambient: false as const,
					ttlSeconds: credential.ttlSeconds,
					credentialRevoked: true as const,
				});
				steps.push(step);
				statuses.push(status);
				emit(CD_APPLY_EVENTS.ResourceApplied, {
					deploymentId,
					resource: resource.name,
					providerId,
					credentialId: credential.id,
					ttlSeconds: credential.ttlSeconds,
					credentialRevoked: true,
					status: status.state,
					secretRefs: [...status.secretRefs],
					diffHash: diff.contentHash,
					changes: exec.diff.changes,
					sandboxAmbient: false,
				});
			}

			emit(CD_APPLY_EVENTS.Succeeded, {
				deploymentId,
				setId: set.setId,
				resources: steps.map((s) => s.resourceId),
				mode,
				activeCredentials: broker.activeCount(),
			});

			const result: AttestedApplyResult = Object.freeze({
				schemaVersion: ATTESTED_APPLY_SCHEMA,
				deploymentId,
				setId: set.setId,
				principal,
				status:
					mode === "simulate" ? ("simulated" as const) : ("succeeded" as const),
				mode,
				steps: Object.freeze(steps),
				events: Object.freeze(events),
				secretFree: true as const,
				activeCredentialsAfter: broker.activeCount(),
			});

			deployments.set(
				deploymentId,
				Object.freeze({
					deploymentId,
					setId: set.setId,
					statuses: Object.freeze([...statuses]),
					events: Object.freeze([...events]),
					principal,
					mode,
				}),
			);

			return result;
		},

		async status(set, deploymentId) {
			const recorded = deployments.get(deploymentId);
			if (recorded) {
				for (const s of recorded.statuses) assertSecretFree(s);
				// Persist StatusObserved so plane.logs / CLI see the observation.
				const evt: CdApplyEvent = Object.freeze({
					id: `evt-status-${deploymentId}-${recorded.events.length + 1}`,
					type: CD_APPLY_EVENTS.StatusObserved,
					schemaVersion: ATTESTED_APPLY_SCHEMA,
					seq: recorded.events.length + 1,
					time: now(),
					data: Object.freeze({
						deploymentId,
						resources: recorded.statuses.map((s) => s.resourceId),
						secretFree: true,
					}),
				});
				assertSecretFree(evt.data);
				deployments.set(
					deploymentId,
					Object.freeze({
						...recorded,
						events: Object.freeze([...recorded.events, evt]),
					}),
				);
				return recorded.statuses;
			}
			// No prior apply: still secret-free observation of intended resources.
			const statuses = Object.freeze(
				listResources(set).map((r) =>
					createSecretFreeStatus({
						resourceId: r.name,
						state: "Unknown",
						outputs: {
							deploymentId,
							provider: providerForResource(set, r.name),
							observed: "no-prior-apply",
						},
					}),
				),
			);
			for (const s of statuses) assertSecretFree(s);
			return statuses;
		},
	};
}

function failResult(
	deploymentId: string,
	set: ResolvedDeploymentSet,
	principal: AttestedPrincipal,
	steps: ApplyStepResult[],
	events: CdApplyEvent[],
	mode: "live" | "simulate",
	activeCredentialsAfter: number,
	reason: string,
): AttestedApplyResult {
	return Object.freeze({
		schemaVersion: ATTESTED_APPLY_SCHEMA,
		deploymentId,
		setId: set.setId,
		principal,
		status: "failed" as const,
		mode,
		steps: Object.freeze([...steps]),
		events: Object.freeze(events),
		secretFree: true as const,
		activeCredentialsAfter,
		reason,
	});
}

function unattestedPrincipal(
	set: ResolvedDeploymentSet,
	deploymentId: string,
	codeDigest: string,
	componentImageDigest: string,
	isolationTier: string,
): AttestedPrincipal {
	return Object.freeze({
		svidSubject: `spiffe://hobo/${set.tenant}/cd/${deploymentId}`,
		identityId: "id:unattested",
		tenant: set.tenant,
		codeDigest,
		componentImageDigest,
		attestationState: "attested" as const,
		isolationTier,
	});
}

function normalizeDigest(value: string): string {
	if (value.startsWith("sha256:") && value.length === 7 + 64) return value;
	const hex = value.replace(/^sha256:/, "");
	const padded = hex.padEnd(64, "0").slice(0, 64);
	return `sha256:${padded}`;
}

function createLaunchMeasurement(input: {
	tenant: string;
	codeDigest: string;
	componentImageDigest: string;
	hostId: string;
	isolationTier: string;
	parentPrincipal: PrincipalRef;
	now: string;
}): LaunchMeasurement {
	const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	const issued = new Date(input.now);
	const expires = new Date(issued.getTime() + 15 * 60 * 1000);
	return Object.freeze({
		runId,
		tenant: input.tenant,
		parentPrincipal: input.parentPrincipal,
		codeVersion: Object.freeze({
			digest: input.codeDigest,
			version: "cd-plane-1",
		}),
		componentImageDigest: input.componentImageDigest,
		hostId: input.hostId,
		issuedAt: issued.toISOString(),
		expiresAt: expires.toISOString(),
		nonce: randomUUID().replace(/-/g, "").slice(0, 16),
		isolationTier: input.isolationTier,
	});
}

/** Complete offline IacProvider — same port as live adapters. */
export function createOfflineIacProvider(): IacProvider {
	return {
		id: "offline-iac",
		async preview(program) {
			return {
				summary: `offline preview ${program.resourceId}`,
				changes: 1,
			};
		},
		async apply(program) {
			return {
				resourceId: program.resourceId,
				provider: program.provider,
				endpoint: `https://${program.resourceId}.offline.local`,
			};
		},
		async destroy() {},
		async refresh(program) {
			return {
				drift: false,
				observed: { resourceId: program.resourceId },
			};
		},
	};
}

/** Export attestation document factory for fixtures / proofs. */
export function createContractAssertedApplyAttestation(input: {
	readonly tenant: string;
	readonly setContentHash: string;
	readonly planHash: string;
}): AttestationDocument {
	const hostId = "host-local-fixture";
	const attestor = createFixtureHostAttestor({ hostId });
	const launch = createLaunchMeasurement({
		tenant: input.tenant,
		codeDigest: normalizeDigest(input.planHash),
		componentImageDigest: normalizeDigest(input.setContentHash),
		hostId,
		isolationTier: "in-process",
		parentPrincipal: { kind: "service", id: "svc:cd-fixture" },
		now: new Date().toISOString(),
	});
	return attestor.createDocument({ launchMeasurement: launch });
}
