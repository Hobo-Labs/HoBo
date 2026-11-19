import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { describe, expect, it } from "vitest";
import {
	type CreditLedgerView,
	createDispatcherRegistry,
	type DispatchCategory,
	type DispatchProviderInput,
	decideCreditDispatch,
} from "../../src/dispatcher.js";

type LibraryInteraction = {
	type: string;
	description: string;
	request: {
		contents: {
			contentType: string;
			encoded: false;
			content: {
				registryCandidates: DispatchProviderInput[];
				category: DispatchCategory;
				objective: "min-cost" | "maximize-credits";
				dispatchId: string;
				units?: number;
				ledgerView: CreditLedgerView;
			};
		};
	};
	response: Array<{
		contents: {
			contentType: string;
			encoded: false;
			content: {
				ok: boolean;
				selectedProvider?: string;
				reason?: string;
				dispatchEvent?: { type: string };
				ranking?: Array<{ providerId: string; eligible?: boolean }>;
			};
		};
	}>;
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
		expect(pact.interactions).toHaveLength(5);
	});

	it.each(pact.interactions)("$description", (interaction) => {
		expect(interaction.type).toBe("Synchronous/Messages");
		expect(interaction.request.contents.contentType).toBe("application/json");
		expect(interaction.request.contents.encoded).toBe(false);
		expect(interaction.response).toHaveLength(1);
		const [response] = interaction.response;
		if (!response) throw new Error("contract response missing");
		expect(response.contents.contentType).toBe("application/json");
		expect(response.contents.encoded).toBe(false);
		const { registryCandidates, ...request } =
			interaction.request.contents.content;
		const decision = decideCreditDispatch({
			...request,
			registry: createDispatcherRegistry(registryCandidates),
		});
		expect(decision).toMatchObject(response.contents.content);
		if (!decision.ok) expect(decision.dispatchEvent).toBeUndefined();
	});

	it("verifies recorded requests with the Pact provider verifier", async () => {
		const verified = new Set<string>();
		const invoke = (message: MessageDescriptor) => {
			if (message.content === undefined || Buffer.isBuffer(message.content))
				throw new Error("invalid dispatcher contract request");
			const input: LibraryInteraction["request"]["contents"]["content"] =
				JSON.parse(JSON.stringify(message.content));
			const { registryCandidates, ...request } = input;
			verified.add(message.description);
			return decideCreditDispatch({
				...request,
				registry: createDispatcherRegistry(registryCandidates),
			});
		};
		const messageProviders = Object.fromEntries(
			pact.interactions.map(({ description }) => [description, invoke]),
		);
		await new Verifier({
			provider: "DispatcherDecisionBoundary",
			pactUrls: [join(packageRoot, "../pacts/dispatch_decision.pact.json")],
			messageProviders,
			logLevel: "error",
			failIfNoPactsFound: true,
		}).verifyProvider();
		expect([...verified].sort()).toEqual(
			pact.interactions.map(({ description }) => description).sort(),
		);
	}, 30_000);
});
