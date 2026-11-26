// Replays contracts/pacts/mongo-executor.pact.json against a MongoExecutor.
//
// The pact is the executor boundary written down; this is what makes it
// executable evidence instead of prose. Interactions run in order against one
// executor and share its state. The two Pact v3 mechanisms the file uses are
// implemented here and nothing more: `matchingRules` with a `type` matcher
// (resume tokens are opaque), and a `ProviderState` generator (a later request
// is given the token an earlier response returned).
import { readFileSync } from "node:fs";
import {
	canonicalEncode,
	type JsonObject,
	type JsonValue,
} from "@hobo/data-core";
import {
	MongoCommandError,
	type MongoExecutor,
	type MongoSession,
	parseAwaitTransactionsRequest,
	parseBulkWriteRequest,
	parseChangeHeadRequest,
	parseChangeReadRequest,
	parseEnsureCollectionRequest,
	parseFindRequest,
} from "../../src/index.js";
import { isJsonArray, isJsonObject, isJsonString } from "../../src/json.js";

const PACT_URL = new URL(
	"../../contracts/pacts/mongo-executor.pact.json",
	import.meta.url,
);

export function loadExecutorPact(): JsonObject {
	// SAFETY: JSON.parse yields a JSON value at this document boundary.
	const pact = JSON.parse(readFileSync(PACT_URL, "utf8")) as JsonValue;
	if (!isJsonObject(pact)) throw new Error("the pact must be a JSON object");
	return pact;
}

/** The body of a transaction that the pact says must not commit. */
class Abort extends Error {}

interface Reply {
	readonly status: number;
	readonly body: JsonValue;
}

async function sessionCall(
	session: MongoSession,
	op: string,
	request: JsonValue,
): Promise<JsonValue> {
	if (op === "find") {
		const { documents } = await session.find(parseFindRequest(request));
		return { documents };
	}
	if (op === "bulkWrite") {
		const result = await session.bulkWrite(parseBulkWriteRequest(request));
		return {
			inserted: result.inserted,
			replaced: result.replaced,
			deleted: result.deleted,
		};
	}
	throw new Error(`the pact names an unknown session operation ${op}`);
}

async function dispatch(
	executor: MongoExecutor,
	path: string,
	body: JsonValue,
): Promise<JsonValue> {
	switch (path) {
		case "/find":
			return sessionCall(executor, "find", body);
		case "/bulkWrite":
			return sessionCall(executor, "bulkWrite", body);
		case "/ensureCollection": {
			const { created } = await executor.ensureCollection(
				parseEnsureCollectionRequest(body),
			);
			return { created };
		}
		case "/changeHead": {
			const { token } = await executor.changeHead(parseChangeHeadRequest(body));
			return { token };
		}
		case "/readChanges": {
			const batch = await executor.readChanges(parseChangeReadRequest(body));
			return {
				events: batch.events.map((event) => ({
					token: event.token,
					operation: event.operation,
					...(event.id === undefined ? undefined : { id: event.id }),
					...(event.document === undefined
						? undefined
						: { document: event.document }),
					...(event.transaction === undefined
						? undefined
						: { transaction: event.transaction }),
				})),
				token: batch.token,
				drained: batch.drained,
			};
		}
		case "/awaitTransactions":
			await executor.awaitTransactions(parseAwaitTransactionsRequest(body));
			return {};
		case "/transaction": {
			const steps =
				isJsonObject(body) && isJsonArray(body.steps) ? body.steps : [];
			const results = await executor.transaction(async (session) => {
				const collected: JsonValue[] = [];
				for (const step of steps) {
					if (!isJsonObject(step) || !isJsonString(step.op)) continue;
					if (step.op === "abort") throw new Abort();
					collected.push(
						await sessionCall(session, step.op, step.request ?? null),
					);
				}
				return collected;
			});
			return { results };
		}
		default:
			throw new Error(`the pact names an unknown port method ${path}`);
	}
}

async function reply(
	executor: MongoExecutor,
	path: string,
	body: JsonValue,
): Promise<Reply> {
	try {
		return { status: 200, body: await dispatch(executor, path, body) };
	} catch (cause) {
		if (cause instanceof Abort) return { status: 409, body: { aborted: true } };
		if (cause instanceof MongoCommandError) {
			return { status: 409, body: { refused: true, code: cause.code } };
		}
		throw cause;
	}
}

/** Paths under `matchingRules.body` that carry a `type` matcher. */
function typeMatched(response: JsonObject): ReadonlySet<string> {
	const rules = response.matchingRules;
	const body = isJsonObject(rules) ? rules.body : undefined;
	return new Set(isJsonObject(body) ? Object.keys(body) : []);
}

function differences(
	expected: JsonValue,
	actual: JsonValue | undefined,
	path: string,
	typeOnly: ReadonlySet<string>,
	subset: boolean,
): string[] {
	if (actual === undefined) return [`${path}: missing`];
	if (typeOnly.has(path)) {
		return isJsonString(expected) === isJsonString(actual) && actual !== ""
			? []
			: [`${path}: expected a value of the same type`];
	}
	if (isJsonArray(expected) && isJsonArray(actual)) {
		if (expected.length !== actual.length) {
			return [
				`${path}: expected ${expected.length} items, got ${actual.length}`,
			];
		}
		return expected.flatMap((item, index) =>
			differences(item, actual[index], `${path}[*]`, typeOnly, subset),
		);
	}
	if (isJsonObject(expected) && isJsonObject(actual)) {
		const extra = subset
			? []
			: Object.keys(actual)
					.filter((key) => expected[key] === undefined)
					.map((key) => `${path}.${key}: unexpected`);
		return [
			...extra,
			...Object.keys(expected).flatMap((key) =>
				differences(
					expected[key] ?? null,
					actual[key],
					`${path}.${key}`,
					typeOnly,
					subset,
				),
			),
		];
	}
	return canonicalEncode(expected) === canonicalEncode(actual)
		? []
		: [
				`${path}: expected ${canonicalEncode(expected)}, got ${canonicalEncode(actual)}`,
			];
}

/** Request body with every `ProviderState` generator applied. */
function generated(
	request: JsonObject,
	state: ReadonlyMap<string, JsonValue>,
): JsonValue {
	const body = request.body ?? null;
	const generators = request.generators;
	const rules = isJsonObject(generators) ? generators.body : undefined;
	if (!isJsonObject(body) || !isJsonObject(rules)) return body;
	return Object.fromEntries(
		Object.keys(body).map((key) => {
			const rule = rules[`$.${key}`];
			const expression = isJsonObject(rule) ? rule.expression : undefined;
			const name = isJsonString(expression)
				? expression.replace(/^\$\{(.*)\}$/u, "$1")
				: undefined;
			return [
				key,
				(name === undefined ? undefined : state.get(name)) ?? body[key] ?? null,
			];
		}),
	);
}

/**
 * Replay every interaction, in order, against one executor. Returns one line
 * per mismatch; an empty array means the provider honours the pact.
 */
export async function replayExecutorPact(
	executor: MongoExecutor,
): Promise<string[]> {
	const interactions = loadExecutorPact().interactions;
	const state = new Map<string, JsonValue>();
	const mismatches: string[] = [];
	for (const interaction of isJsonArray(interactions) ? interactions : []) {
		if (!isJsonObject(interaction)) continue;
		const { request, response, description } = interaction;
		if (!isJsonObject(request) || !isJsonObject(response)) continue;
		const path = isJsonString(request.path) ? request.path : "";
		const actual = await reply(executor, path, generated(request, state));
		if (path === "/changeHead" && isJsonObject(actual.body)) {
			state.set("changeHead", actual.body.token ?? null);
		}
		const found = [
			...(actual.status === response.status
				? []
				: [
						`$status: expected ${String(response.status)}, got ${actual.status}`,
					]),
			...differences(
				response.body ?? null,
				actual.body,
				"$",
				typeMatched(response),
				actual.status !== 200,
			),
		];
		mismatches.push(...found.map((line) => `${String(description)} — ${line}`));
	}
	return mismatches;
}
