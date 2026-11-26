/**
 * The provider side of the proxied-run pact. The pact encodes the process
 * boundary as synthetic HTTP: `POST /dev/run` carries a scenario, the bindings
 * and the command, and the response is what the adapter observed of the run.
 * A `ScenarioRunner` plays one scenario against some OpenSesame (the stand-in in
 * the default lane, the real binary in the real lane) and this turns what it
 * saw into the response, so the same pact is verified against both.
 *
 * Status codes, by what the adapter concluded:
 *   child_exit 200, plugin_pin_mismatch 409, tripwire 403, signalled 410,
 *   scope_unbounded 422, store_unreadable 423, placeholders_only 424.
 */

import type {
	PactRequest,
	PactResponse,
	ProviderStub,
} from "@hobo/contract-harness";

import type { ProxiedRunOutcome } from "../../src/_generated/adapter_opensesame_pb.js";
import {
	type ParsedCredentialBinding,
	parseCredentialBindings,
} from "../../src/binding.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../src/json.js";
import type { OutcomeKind } from "../../src/outcome.js";

export const PROVIDER_NAME = "OpenSesameProxiedRun";

export const SCENARIOS = [
	"surrogate-delivered",
	"scope-unbounded",
	"plugin-absent",
	"misdirected",
	"sigterm",
	"no-sealed-entry",
	"plugin-changed",
	"wrong-passphrase",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const STATUS_BY_KIND = {
	child_exit: 200,
	plugin_pin_mismatch: 409,
	tripwire: 403,
	signalled: 410,
	scope_unbounded: 422,
	schema_refused: 422,
	store_unreadable: 423,
	placeholders_only: 424,
	bridge_missing: 503,
} as const satisfies Readonly<Record<OutcomeKind, number>>;

/** What a scenario's run left, as the runner saw it. */
export type ObservedRun = Readonly<{
	outcome: ProxiedRunOutcome;
	/** The variables the child recorded, or `undefined` when it never ran. */
	childEnv: Readonly<Record<string, string>> | undefined;
	/**
	 * Whether the dummy token that stands for the sealed one showed up anywhere it
	 * must not. The stand-in never reads that dummy, so `false` there is true by
	 * construction; only the real lane's sweep makes it evidence.
	 */
	leaked: boolean;
}>;

export interface ScenarioRunner {
	run(
		scenario: Scenario,
		bindings: readonly ParsedCredentialBinding[],
	): Promise<ObservedRun>;
}

function holds(
	value: string | undefined,
): "surrogate" | "placeholder" | "absent" | "other" {
	if (value === undefined) return "absent";
	if (/^osr_[0-9a-f]{32}$/u.test(value)) return "surrogate";
	if (/^ostest_[0-9a-f]+$/u.test(value)) return "placeholder";
	return "other";
}

function isScenario(value: JsonValue | undefined): value is Scenario {
	return isJsonString(value) && SCENARIOS.some((known) => known === value);
}

function bodyOf(observed: ObservedRun): JsonObject {
	const { outcome, childEnv } = observed;
	const base = {
		exitCode: outcome.exitCode,
		kind: outcome.kind,
		childRan: childEnv !== undefined,
		tokenLeaked: observed.leaked,
	};
	if (childEnv === undefined) return base;
	return {
		...base,
		childHolds: { VERCEL_TOKEN: holds(childEnv.VERCEL_TOKEN) },
		childHasProxy: childEnv.HTTPS_PROXY !== undefined,
	};
}

export function createProxiedRunProvider(runner: ScenarioRunner): ProviderStub {
	return {
		name: PROVIDER_NAME,
		async handle(request: PactRequest): Promise<PactResponse> {
			const body = request.body;
			if (
				request.method !== "POST" ||
				request.path !== "/dev/run" ||
				!isJsonObject(body)
			) {
				return { status: 404, body: { error: "no such interaction" } };
			}
			const scenario = body.scenario;
			const document = body.bindings;
			if (
				!isScenario(scenario) ||
				document === undefined ||
				!isJsonArray(body.argv)
			) {
				return { status: 400, body: { error: "unknown scenario" } };
			}
			const observed = await runner.run(
				scenario,
				parseCredentialBindings(document),
			);
			return {
				status: statusFor(observed.outcome.kind),
				headers: { "content-type": "application/json" },
				body: bodyOf(observed),
			};
		},
	};
}

export function statusFor(kind: string): number {
	const entry = Object.entries(STATUS_BY_KIND).find(
		([known]) => known === kind,
	);
	return entry === undefined ? 500 : entry[1];
}
