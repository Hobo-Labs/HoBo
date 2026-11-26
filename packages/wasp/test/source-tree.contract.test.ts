/**
 * Consumer-driven contract verification for the app-source-tree boundary.
 *
 * `contracts/wasp-app-source-tree.pact.json` records what this package expects
 * of a Wasp / Open SaaS application directory: two declaration files, either
 * present with text or absent. That filesystem read is the only seam here, so
 * it is the only thing faked — each interaction's recorded reply is served
 * through a stub `WaspSourceReader` and the *real* `discoverWaspEnv()` runs
 * against it.
 *
 * The suite that reads the actual `examples/wasp-opensaas/app` tree lives in
 * `wasp-app.test.ts`. This one exists so the contract is checkable without an
 * app on disk, and so the refusals — a root that escapes the repo, a
 * server-shaped key sitting in the client file — are pinned rather than
 * implied.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	discoverWaspEnv,
	parseWaspEnvExample,
	WASP_REJECTED_CODE,
	WaspInputRejectedError,
	type WaspSourceReader,
	waspAnnotation,
} from "../src/index.js";

type PactMessage = {
	readonly description: string;
	readonly request: {
		readonly type: string;
		readonly body: Record<string, unknown>;
	};
	readonly response: { readonly body: Record<string, unknown> };
	readonly providerStates?: readonly { readonly name: string }[];
};

type PactFile = {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactMessage[];
};

function loadPact(): PactFile {
	const decoded: unknown = JSON.parse(
		readFileSync(
			fileURLToPath(
				new URL("../contracts/wasp-app-source-tree.pact.json", import.meta.url),
			),
			"utf8",
		),
	);
	if (typeof decoded !== "object" || decoded === null) {
		throw new Error("the pact file is not a JSON object");
	}
	const candidate = decoded as Partial<PactFile>;
	if (
		!Array.isArray(candidate.interactions) ||
		candidate.interactions.length === 0
	) {
		throw new Error("the pact file declares no interactions");
	}
	if (
		candidate.consumer?.name === undefined ||
		candidate.provider?.name === undefined
	) {
		throw new Error("the pact file is missing its consumer or provider name");
	}
	return candidate as PactFile;
}

const pact = loadPact();

function interaction(fragment: string): PactMessage {
	const found = pact.interactions.find((entry) =>
		entry.description.includes(fragment),
	);
	if (found === undefined) {
		throw new Error(
			`the pact has no interaction matching ${JSON.stringify(fragment)}`,
		);
	}
	return found;
}

function textOf(fragment: string): string {
	return interaction(fragment).response.body.text as string;
}

const REPO_ROOT = "/tmp/hobo-wasp-pact-repo";
const APP_ROOT = "examples/wasp-opensaas/app";

/** The seam: the two recorded files, keyed by name, plus a read log. */
function readerFor(
	files: Readonly<Record<string, string | undefined>>,
): WaspSourceReader & { readonly reads: readonly string[] } {
	const reads: string[] = [];
	return {
		reads,
		async readFile(absolutePath) {
			const name = path.basename(absolutePath);
			reads.push(name);
			return files[name];
		},
	};
}

const openSaasReader = () =>
	readerFor({
		".env.server.example": textOf("read .env.server.example"),
		".env.client.example": textOf("read .env.client.example from"),
	});

describe("the pact file itself", () => {
	it("names the source tree it describes and dates its sources", () => {
		expect(pact.consumer.name).toBe("@hobo/wasp");
		expect(pact.provider.name).toBe("WaspAppSourceTree");
		expect(
			pact.interactions.every((entry) => entry.request.type === "message"),
		).toBe(true);
	});

	it("carries only obviously fake values in its recorded file bodies", () => {
		// The parser never reads a value, but the fixture should not require
		// anyone to take that on faith.
		for (const entry of pact.interactions) {
			const text = entry.response.body.text;
			if (typeof text !== "string") continue;
			for (const line of text.split("\n")) {
				const [, value] = line.split("=", 2);
				if (value === undefined || value.length === 0) continue;
				if (line.trim().startsWith("#")) continue;
				expect(value).toMatch(/FAKE|example\.com|your-|012345|G-FAKE/u);
			}
		}
	});
});

describe("reading the declaration files, verified against the pact", () => {
	it("reads exactly the two files the boundary declares", async () => {
		const reader = openSaasReader();

		await discoverWaspEnv(REPO_ROOT, APP_ROOT, { reader });

		expect(reader.reads).toEqual([
			".env.server.example",
			".env.client.example",
		]);
	});

	it("keeps the declared keys and no value from the server file", async () => {
		const discovered = await discoverWaspEnv(REPO_ROOT, APP_ROOT, {
			reader: openSaasReader(),
		});

		expect(discovered.serverExampleKeys).toContain("STRIPE_API_KEY");
		expect(discovered.serverExampleKeys).toContain("AWS_S3_FILES_BUCKET");
		// The commented-out DATABASE_URL is a comment, not a declaration.
		expect(discovered.serverExampleKeys).not.toContain("DATABASE_URL");
		// Nothing anywhere in the result came from the right of an `=`.
		expect(JSON.stringify(discovered)).not.toMatch(/FAKE-DO-NOT-USE/u);
	});

	it("treats an absent example file as a discovery with no keys", async () => {
		const absent = interaction("not there yet");
		expect(absent.response.body.present).toBe(false);

		const discovered = await discoverWaspEnv(REPO_ROOT, APP_ROOT, {
			reader: readerFor({
				".env.server.example": undefined,
				".env.client.example": textOf("read .env.client.example from"),
			}),
		});

		expect(discovered.serverExampleKeys).toEqual([]);
		expect(discovered.clientExampleKeys).toEqual([
			"REACT_APP_GOOGLE_ANALYTICS_ID",
		]);
	});

	it("drops a server-shaped key found in the client file", () => {
		const entry = interaction("without the REACT_APP_ prefix");
		const parsed = parseWaspEnvExample(
			entry.response.body.text as string,
			".env.client.example",
		);

		// Wasp only compiles REACT_APP_* into the browser bundle, so a bare
		// STRIPE_API_KEY there is not a client var — treating it as one would
		// claim a credential is public.
		expect(parsed.keys).toEqual(["REACT_APP_GOOGLE_ANALYTICS_ID"]);
		expect(entry.providerStates?.[0]?.name).toBeTruthy();
	});
});

describe("dependency suggestions, verified against the pact", () => {
	it("derives the general env and suggestions the pact records", async () => {
		const expected = interaction("derive the Bindle dependency suggestions")
			.response.body;
		const discovered = await discoverWaspEnv(REPO_ROOT, APP_ROOT, {
			reader: openSaasReader(),
		});

		expect(discovered.generalEnv).toEqual(expected.generalEnv);
		expect(JSON.parse(JSON.stringify(discovered.suggestedDeps))).toEqual(
			expected.suggestedDeps,
		);
	});
});

describe("the Bindle annotation, verified against the pact", () => {
	it("carries the framework and root and nothing else", () => {
		const entry = interaction("annotate a Bindle web Kit");
		const annotation = waspAnnotation({
			framework: "wasp",
			root: entry.request.body.root as string,
		});

		expect(JSON.parse(JSON.stringify(annotation))).toEqual(entry.response.body);
	});
});

describe("refusals, verified against the pact", () => {
	it("refuses an app root that escapes the repository", async () => {
		const entry = interaction("escapes the repository");
		const expected = entry.response.body.error as {
			code: string;
			field: string;
		};
		expect(expected.code).toBe(WASP_REJECTED_CODE);

		await expect(
			discoverWaspEnv(REPO_ROOT, entry.request.body.root as string, {
				reader: openSaasReader(),
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof WaspInputRejectedError &&
				error.code === expected.code &&
				error.field === expected.field,
		);
	});
});
