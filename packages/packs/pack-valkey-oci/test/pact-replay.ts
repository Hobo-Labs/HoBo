/**
 * The provider side of `contracts/pack-valkey-oci-yard-executor.pact.json`.
 *
 * A Yard container executor cannot run this pack by reading its README: it asks
 * the pack what to start, what to probe, what argv an operation is, and what
 * binding to hand a workload. That question-and-answer is the boundary, and this
 * module answers each recorded question with the **real** pack functions — no
 * HTTP, no mock of the pack, no second implementation. `respond` is the whole
 * dispatcher; a path the pact names but the pack cannot serve is an error rather
 * than a default.
 *
 * The recorded requests are untrusted input on purpose. Every deployment
 * interaction goes through `parseValkeyDeploymentRequest`, so the refusal
 * interactions exercise the same parse boundary a Yard would hit, and a refusal
 * carries the code the pack actually raises rather than one invented for the
 * contract.
 */
import { parseSecretRef, SecretRefError, SecretValue } from "@hobo/bindings";
import {
	isPackError,
	type PackSecretResolverPort,
	type ProcessRunner,
} from "@hobo/pack-framework";

import {
	buildValkeyBinding,
	buildValkeyDeployment,
	buildValkeyRdbBackupArgv,
	buildValkeyReplicaHandoffPlan,
	buildValkeyRewriteAofArgv,
	isValkeyDurabilityMode,
	isValkeyEvictionPolicy,
	parseValkeyDeploymentRequest,
	runValkeyCommand,
	type ValkeyCommand,
	type ValkeyEndpointInput,
	valkeyRetentionSemantics,
} from "../src/index.js";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../src/json.js";
import { verifiedValkeyPack } from "./harness.js";

const manifest = verifiedValkeyPack();

export type PactRequest = {
	readonly method: string;
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly body?: JsonValue;
};

export type PactOutcome = {
	readonly status: number;
	readonly body: JsonValue;
};

/**
 * A runner that fails if it is ever reached.
 *
 * The argv-safety interaction is only meaningful if the refusal happens *before*
 * a process exists; a permissive stub here would let the contract pass while the
 * credential reached a command line.
 */
const UNREACHABLE_RUNNER: ProcessRunner = {
	run: () => {
		throw new Error("argv safety must refuse before a process is spawned");
	},
};

const RESOLVER: PackSecretResolverPort = {
	resolve: (ref) =>
		Promise.resolve(new SecretValue(parseSecretRef(ref), "resolved-password")),
};

function asRecord(value: JsonValue, what: string): Readonly<JsonObject> {
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		throw new Error(`the pact's ${what} must be an object`);
	}
	// SAFETY: `return value as Readonly<JsonObject>;` is required at this I/O or test boundary.
	return value as Readonly<JsonObject>;
}

function requireString(record: Readonly<JsonObject>, key: string): string {
	const value = record[key];
	if (!isJsonString(value)) throw new Error(`the pact omits ${key}`);
	return value;
}

/** Endpoints arrive as JSON; the locator becomes a `SecretRef` here. */
function endpointFrom(value: JsonValue): ValkeyEndpointInput {
	const record = asRecord(value, "endpoint");
	const port = record.port;
	const database = record.database;
	const tls = record.tls;
	return {
		host: requireString(record, "host"),
		passwordRef: parseSecretRef(requireString(record, "passwordRef")).ref,
		...(isJsonNumber(port) ? { port } : undefined),
		...(isJsonNumber(database) ? { database } : undefined),
		...(isJsonBoolean(tls) ? { tls } : undefined),
	};
}

function durabilityModeFrom(value: JsonValue) {
	const mode = isJsonString(value) ? value : "";
	if (!isValkeyDurabilityMode(mode)) {
		throw new Error(
			`the pact names an unknown durability mode ${JSON.stringify(value)}`,
		);
	}
	return mode;
}

function evictionPolicyFrom(value: JsonValue) {
	const policy = isJsonString(value) ? value : "";
	if (!isValkeyEvictionPolicy(policy)) {
		throw new Error(
			`the pact names an unknown eviction policy ${JSON.stringify(value)}`,
		);
	}
	return policy;
}

/** A command as the executor receives it: argv, locators, timeout. */
function commandView(command: ValkeyCommand) {
	return {
		operationId: command.operationId,
		argv: command.argv,
		env: command.env,
		secretEnv: command.secretEnv,
		timeoutMs: command.timeoutMs,
	};
}

/**
 * A refusal, projected the way a receipt records one.
 *
 * `PackError` and `SecretRefError` both carry a stable code; anything else is a
 * defect in this pack rather than a contracted outcome, so it is rethrown.
 */
function refusal(error: JsonValue): PactOutcome {
	if (isPackError(error) || error instanceof SecretRefError) {
		return { status: 422, body: { code: error.code, message: error.message } };
	}
	throw error;
}

function deployment(body: JsonValue): PactOutcome {
	try {
		const plan = buildValkeyDeployment(
			manifest,
			parseValkeyDeploymentRequest(manifest, body),
		);
		return { status: 201, body: plan };
	} catch (error) {
		return refusal(error);
	}
}

async function operation(body: JsonValue): Promise<PactOutcome> {
	const record = asRecord(body, "operation request");
	const operationName = requireString(record, "operation");
	try {
		if (operationName === "backup") {
			const command = buildValkeyRdbBackupArgv({
				endpoint: endpointFrom(record.endpoint),
				outputPath: requireString(record, "outputPath"),
			});
			// `appendArgv` is the pact's way of saying "a caller mutated argv
			// after the builder returned", which is the only way a credential
			// can still reach a command line.
			if (Array.isArray(record.appendArgv)) {
				const tampered: ValkeyCommand = {
					...command,
					// SAFETY: `argv: [...command.argv, ...(record.appendArgv as readonly string[])],` is required at this I/O or test boundary.
					argv: [...command.argv, ...(record.appendArgv as readonly string[])],
				};
				await runValkeyCommand(UNREACHABLE_RUNNER, RESOLVER, tampered);
			}
			return { status: 200, body: commandView(command) };
		}
		if (operationName === "rewrite-aof") {
			return {
				status: 200,
				body: commandView(
					buildValkeyRewriteAofArgv({
						endpoint: endpointFrom(record.endpoint),
						durabilityMode: durabilityModeFrom(record.durabilityMode),
					}),
				),
			};
		}
	} catch (error) {
		return refusal(error);
	}
	throw new Error(`the pact names an unknown operation ${operationName}`);
}

function migration(body: JsonValue): PactOutcome {
	const record = asRecord(body, "migration request");
	try {
		const plan = buildValkeyReplicaHandoffPlan({
			source: endpointFrom(record.source),
			target: endpointFrom(record.target),
		});
		return {
			status: 200,
			body: {
				profileRef: plan.profileRef,
				replicate: commandView(plan.replicate),
				awaitSync: commandView(plan.awaitSync),
				promote: commandView(plan.promote),
			},
		};
	} catch (error) {
		return refusal(error);
	}
}

function binding(body: JsonValue): PactOutcome {
	const record = asRecord(body, "binding request");
	const port = record.port;
	const database = record.database;
	const certificateRef = record.certificateRef;
	try {
		return {
			status: 201,
			body: buildValkeyBinding(manifest, {
				bindingId: requireString(record, "bindingId"),
				resourceRef: requireString(record, "resourceRef"),
				host: requireString(record, "host"),
				credentialRef: parseSecretRef(requireString(record, "credentialRef"))
					.ref,
				tls: record.tls === true,
				producerEvidenceRef: requireString(record, "producerEvidenceRef"),
				retention: valkeyRetentionSemantics({
					durabilityMode: durabilityModeFrom(record.durabilityMode),
					evictionPolicy: evictionPolicyFrom(record.evictionPolicy),
				}),
				...(isJsonNumber(port) ? { port } : undefined),
				...(isJsonNumber(database) ? { database } : undefined),
				...(isJsonString(certificateRef)
					? { certificateRef: parseSecretRef(certificateRef).ref }
					: undefined),
			}),
		};
	} catch (error) {
		return refusal(error);
	}
}

/** The probes the verified manifest declares, as the executor reads them. */
function probes(): PactOutcome {
	return { status: 200, body: manifest.probes };
}

export async function respond(request: PactRequest): Promise<PactOutcome> {
	if (request.path === "/packs/valkey/deployments")
		return deployment(request.body);
	if (request.path === "/packs/valkey/operations")
		return operation(request.body);
	if (request.path === "/packs/valkey/migrations")
		return migration(request.body);
	if (request.path === "/packs/valkey/bindings") return binding(request.body);
	if (request.path === "/packs/valkey/probes") return probes();
	throw new Error(`the pact names an unknown path ${request.path}`);
}
