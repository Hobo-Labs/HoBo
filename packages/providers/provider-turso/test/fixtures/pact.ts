/**
 * The libSQL statement pact: loading, the typed-value encoding it is written
 * in, and a recording/replaying client.
 *
 * Values are written the way the Hrana protocol (libSQL's wire, which
 * `@libsql/client/http` speaks to Turso) types them — `null`, `integer` as a
 * decimal string, `text`, `blob` as base64 — so a reviewer reads the pact as
 * what crosses the wire, and integer-vs-float is visible: a counter bound as
 * a float would come back as `"10.0"`, and the pact would show it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	isCellBigInt,
	isCellBytes,
	isCellNumber,
	isCellText,
	type LibsqlArg,
	type LibsqlCell,
	type LibsqlResult,
	type LibsqlStatementClient,
} from "../../src/index.js";

export type PactValue =
	| { readonly type: "null" }
	| { readonly type: "integer"; readonly value: string }
	| { readonly type: "text"; readonly value: string }
	| { readonly type: "blob"; readonly base64: string };

export type PactStatement = {
	readonly sql: string;
	readonly args: readonly PactValue[];
};

export type PactInteraction = {
	readonly description: string;
	readonly request: { readonly statement: PactStatement };
	readonly response: { readonly rows: readonly (readonly PactValue[])[] };
};

/** What the pact encodes: an argument the binding binds, or a cell a database returns. */
export type PactSource = LibsqlArg | LibsqlCell | undefined;

export function encodeValue(value: PactSource): PactValue {
	if (value === null || value === undefined) return { type: "null" };
	if (isCellBigInt(value)) return { type: "integer", value: String(value) };
	if (isCellNumber(value)) {
		if (!Number.isInteger(value)) throw new Error("the pact carries no floats");
		return { type: "integer", value: String(value) };
	}
	if (isCellText(value)) return { type: "text", value };
	if (isCellBytes(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return { type: "blob", base64: Buffer.from(bytes).toString("base64") };
	}
	throw new Error("no pact encoding for this value");
}

export function decodeArg(value: PactValue): LibsqlArg {
	switch (value.type) {
		case "null":
			return null;
		case "integer":
			return BigInt(value.value);
		case "text":
			return value.value;
		case "blob":
			return new Uint8Array(Buffer.from(value.base64, "base64"));
	}
}

export function encodeStatement(statement: {
	readonly sql: string;
	readonly args: readonly PactSource[];
}): PactStatement {
	return { sql: statement.sql, args: statement.args.map(encodeValue) };
}

export function encodeRows(result: LibsqlResult): PactValue[][] {
	return Array.from(result.rows, (row) => Array.from(row, encodeValue));
}

/** A result whose cells decode as the client would hand them back. */
export function decodeRows(
	rows: readonly (readonly PactValue[])[],
): LibsqlResult {
	return {
		rows: rows.map((row) =>
			row.map((cell): LibsqlCell => {
				if (cell.type === "null") return null;
				if (cell.type === "integer") return Number(cell.value);
				if (cell.type === "text") return cell.value;
				return new Uint8Array(Buffer.from(cell.base64, "base64")).buffer;
			}),
		),
	};
}

export function loadStatementPact(): readonly PactInteraction[] {
	const path = fileURLToPath(
		new URL(
			"../../contracts/libsql-ephemeral-state.pact.json",
			import.meta.url,
		),
	);
	// SAFETY: a checked-in fixture whose shape the pact test pins.
	const pact = JSON.parse(readFileSync(path, "utf8")) as {
		readonly interactions: readonly PactInteraction[];
	};
	return pact.interactions;
}

export type ReplayClient = {
	readonly client: LibsqlStatementClient;
	readonly sent: PactStatement[];
};

/** Answers each `execute` with the next interaction's rows, recording what was sent. */
export function replayClient(
	interactions: readonly PactInteraction[],
): ReplayClient {
	const sent: PactStatement[] = [];
	let next = 0;
	return {
		sent,
		client: {
			async execute(statement) {
				sent.push(encodeStatement(statement));
				const interaction = interactions[next];
				next += 1;
				if (interaction === undefined) {
					throw new Error(
						"the binding sent more statements than the pact lists",
					);
				}
				return decodeRows(interaction.response.rows);
			},
			async batch() {
				throw new Error("the pact covers single statements only");
			},
		},
	};
}
