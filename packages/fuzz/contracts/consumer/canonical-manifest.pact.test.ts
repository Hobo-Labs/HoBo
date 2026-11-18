import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	canonicalManifestHash,
	ManifestParseError,
	parseManifest,
} from "@hobo/bindles";
import { type MessageDescriptor, Verifier } from "@pact-foundation/pact";
import { expect, it } from "vitest";
import {
	type FuzzValue,
	hashManifest,
	parseOrReject,
} from "../../src/manifest.js";

type CanonicalInteraction = {
	readonly description: string;
	readonly request: { readonly contents: { readonly content: FuzzValue } };
	readonly response: readonly {
		readonly contents: {
			readonly content: { readonly status: string; readonly hash?: string };
		};
	}[];
};

it("verifies canonical manifests against the real Bindles parser and hash", async () => {
	const path = join(
		import.meta.dirname,
		"../pacts/fuzz-bindles-canonical.pact.json",
	);
	const pact: { interactions: CanonicalInteraction[] } = JSON.parse(
		await readFile(path, "utf8"),
	);
	const verified = new Set<string>();
	const invoke = async (message: MessageDescriptor) => {
		if (message.content === undefined || Buffer.isBuffer(message.content)) {
			throw new Error("invalid manifest contract message");
		}
		const manifest: FuzzValue = JSON.parse(JSON.stringify(message.content));
		verified.add(message.description);
		try {
			return {
				status: "accepted",
				hash: canonicalManifestHash(parseManifest(manifest)),
			};
		} catch (error) {
			if (!(error instanceof ManifestParseError)) throw error;
			return { status: "rejected" };
		}
	};
	await new Verifier({
		provider: "bindles-manifest",
		pactUrls: [path],
		messageProviders: Object.fromEntries(
			pact.interactions.map(({ description }) => [description, invoke]),
		),
		logLevel: "error",
		failIfNoPactsFound: true,
	}).verifyProvider();
	expect([...verified].sort()).toEqual(
		pact.interactions.map(({ description }) => description).sort(),
	);
	for (const interaction of pact.interactions) {
		const expected = interaction.response[0]?.contents.content;
		if (!expected) throw new Error("contract response is missing");
		const manifest = interaction.request.contents.content;
		const parsed = parseOrReject(manifest);
		if (expected.status === "rejected") expect(parsed).toBe("rejected");
		else {
			expect(parsed).not.toBe("rejected");
			expect(hashManifest(manifest)).toBe(expected.hash);
		}
	}
}, 120_000);
