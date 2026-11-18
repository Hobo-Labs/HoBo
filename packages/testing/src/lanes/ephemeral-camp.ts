import type { JsonObject } from "@hobo/core";
import { TestHarnessError } from "./../errors.js";
import { parseTestTopology } from "./../graph.js";
import type {
	BindleInput,
	EphemeralCampDeployResult,
	EphemeralCampDriver,
	EphemeralCampYardInput,
	ResourceHandle,
} from "./../types.js";

export const CAMP_CREDENTIAL_ENV_VAR = "HOBO_TESTING_CAMP_CREDENTIAL_REF"; // public-contract: env-var name the camp lane brokers credentials through

const SECRET_REF_PATTERN =
	/^(?:vault|azure-kv|aws-sm|gcp-sm|op|infisical|hobo-secret|hobo-token):\/\/[^@\s]+$/u;

export interface EphemeralCampTarget {
	readonly yardName: string;
	readonly providerId: string;
	readonly credentialRef: string;
}

export interface EphemeralCampDeployment {
	readonly handles: ReadonlyMap<string, ResourceHandle>;
	readonly outputs: JsonObject;
	destroy(): Promise<void>;
}

const tagOf = Object.prototype.toString;

function isString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

function isFunction<T>(value: T): value is T & (() => Promise<void>) {
	return tagOf.call(value).endsWith("Function]");
}

export function parseEphemeralCampTarget(
	yard: EphemeralCampYardInput | null | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): EphemeralCampTarget {
	if (yard === undefined || yard === null) {
		throw new TestHarnessError(
			"HARNESS_YARD_REQUIRED",
			"the ephemeral-camp lane was selected without a Yard",
			"pass an explicit Yard — createTestHarness({ lane: 'ephemeral-camp', yard }) — the lane never falls back to in-process",
		);
	}
	if (
		!isString(yard.name) ||
		yard.name.length === 0 ||
		!isString(yard.providerId) ||
		yard.providerId.length === 0
	) {
		throw new TestHarnessError(
			"HARNESS_YARD_INVALID",
			"the supplied `yard` is not a parsed Yard (no `name`/`providerId`)",
			"build it with `yard(name, { provider })` from @hobo/yards and pass the returned value unchanged",
		);
	}

	const credentialRef = env[CAMP_CREDENTIAL_ENV_VAR];
	if (credentialRef === undefined || credentialRef.length === 0) {
		throw new TestHarnessError(
			"HARNESS_CREDENTIALS_REQUIRED",
			`the ephemeral-camp lane needs brokered credentials; ${CAMP_CREDENTIAL_ENV_VAR} is not set`,
			`set ${CAMP_CREDENTIAL_ENV_VAR} to a brokered secretRef locator (for example hobo-secret://tenant/yard/deploy) — the lane never degrades to in-process`,
		);
	}
	if (!SECRET_REF_PATTERN.test(credentialRef)) {
		throw new TestHarnessError(
			"HARNESS_CREDENTIAL_NOT_A_REF",
			`${CAMP_CREDENTIAL_ENV_VAR} does not hold a secretRef locator`,
			"broker the credential and reference it (vault://, aws-sm://, hobo-secret://, …); a pasted token value is refused by design (ADR-0113)",
		);
	}

	return Object.freeze({
		yardName: yard.name,
		providerId: yard.providerId,
		credentialRef,
	});
}

function invalidDeployment(message: string): never {
	throw new TestHarnessError(
		"HARNESS_CAMP_DEPLOYMENT_INVALID",
		message,
		"fix the Camp driver so it returns every Bindle resource once, with matching kinds, valid HTTP endpoints, outputs, and a destroy function",
	);
}

function parseEndpoint(
	alias: string,
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		invalidDeployment(
			`the Camp driver returned an invalid endpoint for "${alias}"`,
		);
	}
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		invalidDeployment(
			`the Camp driver returned a non-HTTP endpoint for "${alias}"`,
		);
	}
	return value;
}

function parseDeployment(
	bindle: BindleInput,
	value: EphemeralCampDeployResult,
): EphemeralCampDeployment {
	if (!Array.isArray(value.resources)) {
		invalidDeployment("the Camp driver deployment has no resources array");
	}
	if (Object(value.outputs) !== value.outputs || Array.isArray(value.outputs)) {
		invalidDeployment("the Camp driver deployment has no outputs record");
	}
	if (!isFunction(value.destroy)) {
		invalidDeployment("the Camp driver deployment has no destroy function");
	}

	const topology = parseTestTopology(bindle);
	const expected = new Map(topology.nodes.map((node) => [node.alias, node]));
	const handles = new Map<string, ResourceHandle>();
	for (const resource of value.resources) {
		if (
			!isString(resource.alias) ||
			resource.alias.length === 0 ||
			!isString(resource.kind) ||
			resource.kind.length === 0
		) {
			invalidDeployment("the Camp driver returned an invalid resource record");
		}
		const node = expected.get(resource.alias);
		if (node === undefined) {
			invalidDeployment(
				`the Camp driver returned unknown resource "${resource.alias}"`,
			);
		}
		if (handles.has(resource.alias)) {
			invalidDeployment(
				`the Camp driver returned resource "${resource.alias}" more than once`,
			);
		}
		if (resource.kind !== node.kind) {
			invalidDeployment(
				`the Camp driver returned kind "${resource.kind}" for "${resource.alias}"; expected "${node.kind}"`,
			);
		}
		const endpoint = parseEndpoint(resource.alias, resource.endpoint);
		const handle: ResourceHandle =
			endpoint === undefined
				? Object.freeze({
						alias: resource.alias,
						kind: resource.kind,
						fidelity: "real" as const,
					})
				: Object.freeze({
						alias: resource.alias,
						kind: resource.kind,
						fidelity: "real" as const,
						endpoint,
					});
		handles.set(resource.alias, handle);
	}
	const missing = [...expected.keys()].filter((alias) => !handles.has(alias));
	if (missing.length > 0) {
		invalidDeployment(
			`the Camp driver omitted Bindle resources: ${missing.join(", ")}`,
		);
	}
	return Object.freeze({
		handles,
		outputs: Object.freeze({ ...value.outputs }),
		async destroy(): Promise<void> {
			await value.destroy();
		},
	});
}

export async function deployEphemeralCamp(
	target: EphemeralCampTarget,
	bindle: BindleInput,
	stage: string,
	driver: EphemeralCampDriver | undefined,
): Promise<EphemeralCampDeployment> {
	if (driver === undefined) {
		throw new TestHarnessError(
			"HARNESS_CAMP_DRIVER_REQUIRED",
			`the ephemeral-camp lane has no deployment driver for yard "${target.yardName}"`,
			"pass campDriver in createTestHarness options; the driver must deploy and destroy the Bindle on the selected Yard",
		);
	}
	const result: EphemeralCampDeployResult = await driver.deploy(
		Object.freeze({
			bindle,
			stage,
			yardName: target.yardName,
			providerId: target.providerId,
			credentialRef: target.credentialRef,
		}),
	);
	try {
		return parseDeployment(bindle, result);
	} catch (cause) {
		if (isFunction(result.destroy)) {
			try {
				await result.destroy.call(result);
			} catch (destroyCause) {
				throw new AggregateError(
					[cause, destroyCause],
					"invalid Camp deployment could not be destroyed",
				);
			}
		}
		throw cause;
	}
}
