import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "../../src/index.js";

// SAFETY: this hand-authored test fixture is parsed by the generated wire parsers below.
const pact = JSON.parse(
	readFileSync(
		new URL("../pacts/broker_hosting_budget.pact.json", import.meta.url),
		"utf8",
	),
) as {
	messages: {
		description: string;
		contents: {
			snapshot: object;
			quote: object;
			now: string;
			expectedStatus: string;
			expectedReservedMicros: number;
			competingRefusal: string;
		};
	}[];
};

describe("hosting coordinator financial port contract", () => {
	it.each(pact.messages)("$description", ({ contents }) => {
		const snapshot = fromJsonString(
			BudgetLedgerSnapshotSchema,
			JSON.stringify(contents.snapshot),
		);
		const quote = fromJsonString(
			HostingQuoteSchema,
			JSON.stringify(contents.quote),
		);
		if (!snapshot.identity) throw new Error("fixture identity missing");
		const authority = createBudgetAdmissionAuthority({ snapshot });
		const command = {
			reservationId: "first",
			requestDigest: quote.requestDigest,
			identity: snapshot.identity,
			quote,
			expectedSeq: 0,
			now: contents.now,
		};
		const held = authority.reserve(command);
		expect(held.status).toBe(contents.expectedStatus);
		expect(authority.reserve(command)).toEqual(held);
		expect(authority.read(contents.now).reservedMicros).toBe(
			contents.expectedReservedMicros,
		);
		expect(() =>
			authority.reserve({
				...command,
				reservationId: "competing",
				expectedSeq: 1,
			}),
		).toThrow(contents.competingRefusal);
	});
});
