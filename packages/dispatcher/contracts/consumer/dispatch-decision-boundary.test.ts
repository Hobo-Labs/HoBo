import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type CreditLedgerView,
	createDispatcherRegistry,
	type DispatchCategory,
	type DispatchProviderInput,
	decideDispatch,
} from "../../src/dispatcher.js";

type LibraryInteraction = {
	type: string;
	description: string;
	request: {
		contentType: string;
		contents: {
			registryCandidates: DispatchProviderInput[];
			category: DispatchCategory;
			objective: "maximize-credits";
			dispatchId: string;
			units?: number;
			ledgerView: CreditLedgerView;
		};
	};
	response: Array<{ contentType: string; contents: object }>;
};

type LibraryContract = {
	metadata: { pactSpecification: { version: string }; transport: string };
	interactions: LibraryInteraction[];
};

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pact: LibraryContract = JSON.parse(
	readFileSync(
		join(packageRoot, "../pacts/dispatch_decision.pact.json"),
		"utf8",
	),
);

describe("dispatch decision library contract", () => {
	it("describes the synchronous library boundary", () => {
		expect(pact.metadata).toMatchObject({
			pactSpecification: { version: "4.0.0" },
			transport: "library-call",
		});
		expect(pact.interactions).toHaveLength(3);
	});

	it.each(pact.interactions)("$description", (interaction) => {
		expect(interaction.type).toBe("Synchronous/Messages");
		expect(interaction.request.contentType).toBe("application/json");
		expect(interaction.response).toHaveLength(1);
		const [response] = interaction.response;
		if (!response) throw new Error("contract response missing");
		expect(response.contentType).toBe("application/json");
		const { registryCandidates, ...request } = interaction.request.contents;
		const decision = decideDispatch({
			...request,
			registry: createDispatcherRegistry(registryCandidates),
		});
		expect(decision).toMatchObject(response.contents);
		if (!decision.ok) expect(decision.dispatchEvent).toBeUndefined();
	});
});
