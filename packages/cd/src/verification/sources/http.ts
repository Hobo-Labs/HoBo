// What every HTTP health source shares: the endpoint and credential rules,
// one bounded request through the injected HttpTransport, typed refusals, and
// cohort selection by a declared label. Credentials are resolved per query
// and scoped to the Camp; they are sent, never stored, logged or echoed.
// Response bodies are parsed once into JsonValue and read through the tag
// guards in ../json.ts.
import type { JsonValue } from "@bufbuild/protobuf";
import type { HttpTransport, TransportMethod } from "@hobo/core";
import { Cohort, type HealthQueryRecord } from "../../_generated/cd_pb.js";
import type {
	CampId,
	CredentialResolver,
	HealthSamples,
	Outcome,
} from "../../ports.js";
import { isJsonNumber, isJsonString, parseJsonText } from "../json.js";
import { refuse } from "../reasons.js";

export type SourceDeps = Readonly<{
	http: HttpTransport;
	credentials: CredentialResolver;
}>;

export const SOURCE_TIMEOUT_MS = 10_000;
export const SOURCE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The label value that selects a split cohort; undefined for ALL. */
export function cohortValue(cohort: Cohort): "canary" | "baseline" | undefined {
	if (cohort === Cohort.CANARY) return "canary";
	if (cohort === Cohort.BASELINE) return "baseline";
	return undefined;
}

/** Credential scope: one Camp's verification, so a resolver can narrow it. */
export const credentialScope = (campId: CampId) => `cd.verification:${campId}`;

export function httpsEndpoint(query: HealthQueryRecord): Outcome<URL> {
	try {
		const url = new URL(query.endpointRef);
		if (url.protocol === "https:" && url.username === "" && url.password === "")
			return { ok: true, value: url };
	} catch {
		// fall through to the refusal
	}
	return refuse(
		"health-source-endpoint-invalid",
		`endpoint_ref of ${query.name} is not an https URL without userinfo`,
		query.name,
	);
}

export async function credentialFor(
	deps: SourceDeps,
	query: HealthQueryRecord,
	campId: CampId,
): Promise<Outcome<Readonly<Record<string, string>>>> {
	if (query.credentialRef === "") return { ok: true, value: {} };
	try {
		return {
			ok: true,
			value: await deps.credentials.resolve(
				query.credentialRef,
				credentialScope(campId),
			),
		};
	} catch {
		// The resolver's message may name the secret store; never forward it.
		return refuse(
			"health-source-credential-unavailable",
			`credential_ref of ${query.name} did not resolve`,
			query.name,
		);
	}
}

export type CohortSelector = Readonly<{ label: string; value: string }>;

/** The cohort's label and value, or a refusal when a split cohort has no declared label. */
export function cohortSelector(
	query: HealthQueryRecord,
	cohort: Cohort,
): Outcome<CohortSelector | undefined> {
	const value = cohortValue(cohort);
	if (value === undefined) return { ok: true, value: undefined };
	if (query.cohortLabel === "") {
		return refuse(
			"health-source-cohort-label-missing",
			`${query.name} needs cohort_label to select the ${value} cohort`,
			query.name,
		);
	}
	return { ok: true, value: { label: query.cohortLabel, value } };
}

/** One bounded request; non-2xx, transport failure and non-JSON bodies are typed refusals. */
export async function requestJson(
	deps: SourceDeps,
	input: Readonly<{
		method: TransportMethod;
		url: URL;
		headers: Readonly<Record<string, string>>;
		body?: string;
		subject: string;
	}>,
): Promise<Outcome<JsonValue>> {
	let response: Awaited<ReturnType<HttpTransport>>;
	try {
		const request = {
			method: input.method,
			url: input.url.toString(),
			headers: { accept: "application/json", ...input.headers },
			timeoutMs: SOURCE_TIMEOUT_MS,
			maxResponseBytes: SOURCE_MAX_RESPONSE_BYTES,
		};
		response = await deps.http(
			input.body === undefined ? request : { ...request, body: input.body },
		);
	} catch {
		return refuse(
			"health-source-transport-failed",
			`request to ${input.url.host} did not complete`,
			input.subject,
		);
	}
	if (response.status < 200 || response.status > 299) {
		return refuse(
			"health-source-http-error",
			`${input.url.host} answered ${response.status}`,
			input.subject,
		);
	}
	const value = parseJsonText(response.body);
	if (value === undefined) {
		return refuse(
			"health-source-response-invalid",
			`${input.url.host} answered with a body that is not JSON`,
			input.subject,
		);
	}
	return { ok: true, value };
}

/** A sample value: numbers and numeric strings, ±Inf kept (and later judged invalid); "NaN" and null mean no sample. */
export function sampleValue(value: JsonValue | undefined): number | undefined {
	if (value === "+Inf" || value === "Inf") return Number.POSITIVE_INFINITY;
	if (value === "-Inf") return Number.NEGATIVE_INFINITY;
	const number = isJsonNumber(value)
		? value
		: isJsonString(value) && value.trim() !== ""
			? Number(value)
			: Number.NaN;
	return Number.isNaN(number) ? undefined : number;
}

export function samplesOutcome(
	values: readonly number[],
	fromMs: number,
	toMs: number,
): Outcome<HealthSamples> {
	return { ok: true, value: { values, fromMs, toMs } };
}

export function invalid(subject: string, message: string): Outcome<never> {
	return refuse("health-source-response-invalid", message, subject);
}

/** Series order must not depend on the source's answer order (I8). */
export function stableKey(labels: Readonly<Record<string, JsonValue>>): string {
	return JSON.stringify(
		Object.keys(labels)
			.sort()
			.map((key) => [key, labels[key] ?? null]),
	);
}

export function byKey<T extends Readonly<{ key: string }>>(a: T, b: T): number {
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
