/**
 * What `parsePublishedManifest` rejects when a published document drifts. The
 * Depot provider's other refusals are in `refusals-and-matching.test.ts`.
 *
 * **The published-manifest parser is the secretless posture's enforcement.**
 * `staticSecrets !== false`, or a `staticKey`/`clientSecret`/`pat` anywhere in
 * the auth document, is a refusal — because a published manifest carrying a
 * static credential has already leaked it to everyone who can fetch the
 * well-known path.
 */
import { describe, expect, it } from "vitest";

import { type JsonObject, parseJsonObject } from "../src/json.js";
import {
	AUTH_SCHEMA,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/manifest.js";

// `manifest.ts` re-exports the auth and bundle schema ids but imports the cost
// one from core without re-exporting it, so this asserts the literal rather
// than a name that resolves to `undefined` here — which is how the first draft
// of this test "passed" a `toContain(undefined)`.
const COST_SCHEMA_ID = "hobo.cost/v1";

describe("parsing a published manifest", () => {
	const published = () => publishCapabilityManifest();

	/** The published bundle with one document parsed, rewritten and re-encoded. */
	const withDocument = (
		path: keyof PublishedManifestDocuments,
		rewrite: (doc: JsonObject) => JsonObject,
	): PublishedManifestDocuments => {
		const documents = published();
		const rewritten = rewrite(parseJsonObject(documents[path]));
		return { ...documents, [path]: JSON.stringify(rewritten) };
	};

	it("accepts what the package itself publishes", () => {
		expect(parsePublishedManifest(published()).ok).toBe(true);
	});

	it("reports no errors on a clean manifest", () => {
		expect(parsePublishedManifest(published()).errors).toEqual([]);
	});

	it("refuses a wrong index schema", () => {
		const documents = withDocument(
			"/.well-known/capability-manifest/index.json",
			(doc) => ({ ...doc, manifestSchema: "hobo.capability-manifest/v0" }),
		);
		expect(parsePublishedManifest(documents).errors.join(" ")).toContain(
			MANIFEST_SCHEMA,
		);
	});

	it("refuses a wrong auth schema", () => {
		const documents = withDocument(
			"/.well-known/capability-manifest/auth.json",
			(doc) => ({ ...doc, schema: "hobo.provider-auth/v0" }),
		);
		expect(parsePublishedManifest(documents).errors.join(" ")).toContain(
			AUTH_SCHEMA,
		);
	});

	it("refuses a wrong cost schema", () => {
		const documents = withDocument(
			"/.well-known/capability-manifest/cost.json",
			(doc) => ({ ...doc, schema: "hobo.cost/v0" }),
		);
		expect(parsePublishedManifest(documents).errors.join(" ")).toContain(
			COST_SCHEMA_ID,
		);
	});

	it.each([
		["staticKey"],
		["clientSecret"],
		["pat"],
	])("refuses an auth document carrying a %s", (field) => {
		// A published manifest lives at a well-known path. A static credential
		// in one has already leaked to everyone who can fetch it, so this is a
		// refusal rather than a warning.
		const documents = withDocument(
			"/.well-known/capability-manifest/auth.json",
			(doc) => ({ ...doc, [field]: "secret-material" }),
		);
		expect(parsePublishedManifest(documents).errors.join(" ")).toMatch(
			/static secrets/u,
		);
	});

	it("refuses auth that does not declare itself secretless", () => {
		// Absent is not the same as false: the posture has to be *stated*, so a
		// document that simply forgot the field cannot pass as brokered.
		const documents = withDocument(
			"/.well-known/capability-manifest/auth.json",
			(doc) => ({ ...doc, staticSecrets: true }),
		);
		expect(parsePublishedManifest(documents).errors.join(" ")).toMatch(
			/staticSecrets must be false/u,
		);
	});

	it("refuses the wrong number of capabilities", () => {
		// Exactly two execution-host ports — runner and build machine. One means a
		// half-published provider; three means something else got in.
		const documents = withDocument(
			"/.well-known/capability-manifest/capabilities.json",
			(doc) => ({ ...doc, capabilities: [{ port: "runner" }] }),
		);
		expect(parsePublishedManifest(documents).ok).toBe(false);
	});

	it("collects every problem rather than stopping at the first", () => {
		// An operator fixing a drifted manifest should see the whole list in one
		// pass, not discover the next error only after fixing this one.
		const documents = withDocument(
			"/.well-known/capability-manifest/auth.json",
			(doc) => ({
				...doc,
				schema: "wrong",
				staticSecrets: true,
				pat: "leaked",
			}),
		);
		expect(
			parsePublishedManifest(documents).errors.length,
		).toBeGreaterThanOrEqual(3);
	});

	it("refuses a document that is not JSON at all", () => {
		// `parseJsonObject` answers `{}` for unparseable input, so a truncated
		// upload degrades into "every field is missing" rather than throwing.
		const documents = {
			...published(),
			"/.well-known/capability-manifest/auth.json": "{tru ncated",
		};
		expect(parsePublishedManifest(documents).ok).toBe(false);
	});
});
