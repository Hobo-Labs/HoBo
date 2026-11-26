/**
 * Parse-don't-validate boundaries for the GitHub runner's manifests.
 *
 * Two documents cross a parser here: an execution-host manifest handed to the
 * Dispatcher, and the well-known bundle a registry publishes. Nothing
 * downstream re-checks a field, so each refusal below is the only place its
 * property is enforced.
 *
 * **Every error is collected, not just the first.** A manifest author fixing
 * one field at a time across a document with six problems is exactly the
 * experience a fail-fast parser would create, and a manifest is authored
 * offline where a full list costs nothing.
 *
 * **The secretless posture is parse-enforced** (HOBO-110). The Yard broker
 * holds the GitHub App relationship and mints short-lived installation tokens
 * per operation, so a published `auth.json` carrying a `staticKey`,
 * `clientSecret`, or `pat` — or simply failing to say `staticSecrets: false` —
 * is refused. Publishing a static secret in a well-known document puts it on
 * an unauthenticated HTTP endpoint.
 *
 * **A category decides three other fields at once.** The port, the SKU, and
 * the expected capability count all follow from whether this is a runner or a
 * build machine, which is why an unrecognised category short-circuits the rest
 * — checking them against a category nobody declared would produce errors
 * about fields that were never wrong.
 */
import { describe, expect, it } from "vitest";

import {
	executionHostManifest,
	parseExecutionHostManifest,
	parsePublishedManifest,
	publishCapabilityManifest,
} from "../src/manifest.js";

/** A manifest that parses, for tests that vary one field at a time. */
function manifest(category: "runner" | "build-machine" = "runner") {
	return JSON.parse(JSON.stringify(executionHostManifest(category))) as Record<
		string,
		unknown
	>;
}

/** Parse a manifest with one path mutated. */
function withField(
	mutate: (doc: Record<string, unknown>) => void,
	options: { category?: "runner" | "build-machine" } = {},
) {
	const doc = manifest(options.category ?? "runner");
	mutate(doc);
	return parseExecutionHostManifest(doc, options as never);
}

describe("a well-formed execution-host manifest", () => {
	it("parses both categories", () => {
		for (const category of ["runner", "build-machine"] as const) {
			const result = parseExecutionHostManifest(manifest(category));
			expect(result.ok, category).toBe(true);
			expect(result.errors).toEqual([]);
		}
	});

	it("freezes the parsed manifest", () => {
		// The Dispatcher reads it on every placement. A caller editing it in
		// place would change routing for the life of the process.
		const result = parseExecutionHostManifest(manifest());
		expect(Object.isFrozen(result.manifest)).toBe(true);
	});

	it("returns no manifest at all when it refuses", () => {
		// A partially-parsed manifest handed back alongside errors would invite
		// a caller to use it anyway.
		const result = parseExecutionHostManifest({});
		expect(result.ok).toBe(false);
		expect(result.manifest).toBeUndefined();
	});
});

describe("manifest shape", () => {
	it("refuses anything that is not a plain object", () => {
		for (const raw of [null, undefined, "manifest", 7, []]) {
			const result = parseExecutionHostManifest(raw);
			expect(result.ok, String(raw)).toBe(false);
			expect(result.errors).toEqual(["manifest must be an object"]);
		}
	});

	it("refuses a wrong schema, naming the expected value", () => {
		// The schema is what tells a reader which shape the rest of the document
		// is in. An unrecognised one means every later check is a guess.
		const result = withField((doc) => {
			doc.schema = "hobo.execution-host/v2";
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join(" ")).toContain("schema must be");
	});

	it("requires a non-empty provider id", () => {
		// The id is how a placement decision names which provider it chose.
		for (const id of [undefined, "", 7, null]) {
			const result = withField((doc) => {
				(doc.provider as Record<string, unknown>).id = id;
			});
			expect(result.errors.join(" "), String(id)).toContain(
				"provider.id must be a non-empty string",
			);
		}
	});

	it("collects every error rather than stopping at the first", () => {
		// A manifest is authored offline. Reporting one problem per run would
		// make fixing six a six-round conversation.
		const result = parseExecutionHostManifest({
			schema: "wrong",
			provider: { category: "runner" },
			capabilities: [],
			cost: { schema: "wrong", facts: [] },
		});
		expect(result.errors.length).toBeGreaterThan(3);
	});
});

describe("category", () => {
	it("refuses a category outside runner and build-machine", () => {
		for (const category of [undefined, "", "gpu", 7]) {
			const result = withField((doc) => {
				(doc.provider as Record<string, unknown>).category = category;
			});
			expect(result.errors.join(" "), String(category)).toContain(
				"provider.category must be runner or build-machine",
			);
		}
	});

	it("checks nothing category-dependent when the category is unrecognised", () => {
		// The port, SKU, and capability count all follow from the category.
		// Checking them against one nobody declared would report errors about
		// fields that were never wrong.
		const result = withField((doc) => {
			(doc.provider as Record<string, unknown>).category = "gpu";
		});
		expect(result.errors.join(" ")).not.toContain("cost.facts.0.sku");
		expect(result.errors.join(" ")).not.toContain("capabilities.0.port");
	});

	it("refuses a manifest whose category is not the one the caller expected", () => {
		// A caller asking for a runner and handed a build machine would place
		// CI work on the wrong kind of host.
		const result = parseExecutionHostManifest(manifest("build-machine"), {
			category: "runner",
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join(" ")).toContain(
			"provider.category must be runner",
		);
	});

	it("accepts a manifest matching the expected category", () => {
		expect(
			parseExecutionHostManifest(manifest("runner"), { category: "runner" }).ok,
		).toBe(true);
	});
});

describe("capabilities", () => {
	it("requires exactly one execution-host port", () => {
		// An execution-host manifest describes one host kind. Two ports would
		// make it ambiguous which the Dispatcher is being offered.
		for (const capabilities of [undefined, [], "port", [{}, {}]]) {
			const result = withField((doc) => {
				doc.capabilities = capabilities;
			});
			expect(result.errors.join(" "), String(capabilities)).toContain(
				"capabilities must contain exactly one execution-host port",
			);
		}
	});

	it("requires the port the category implies", () => {
		// A runner manifest declaring the build-machine port would be selected
		// for the wrong workloads.
		const result = withField((doc) => {
			(doc.capabilities as Record<string, unknown>[])[0] = { port: "wrong" };
		});
		expect(result.errors.join(" ")).toContain("capabilities.0.port must be");
	});
});

describe("cost facts", () => {
	it("requires the cost schema", () => {
		const result = withField((doc) => {
			(doc.cost as Record<string, unknown>).schema = "wrong";
		});
		expect(result.errors.join(" ")).toContain("cost.schema must be");
	});

	it("requires a non-empty facts list", () => {
		// Placement ranks on cost. A manifest with none would either be
		// unrankable or treated as free.
		for (const facts of [undefined, [], null]) {
			const result = withField((doc) => {
				(doc.cost as Record<string, unknown>).facts = facts;
			});
			expect(result.errors.join(" "), String(facts)).toContain(
				"cost.facts must be non-empty",
			);
		}
	});

	it("requires the SKU the category implies", () => {
		// The SKU is what a bill is reconciled against. A runner priced as a
		// build machine would reconcile against the wrong line.
		const result = withField((doc) => {
			(
				(doc.cost as Record<string, unknown>).facts as Record<string, unknown>[]
			)[0] = {
				sku: "wrong",
				source: { type: "declared-provider", digest: "sha256:abc" },
			};
		});
		expect(result.errors.join(" ")).toContain("cost.facts.0.sku must be");
	});

	it("requires the source type to be declared-provider", () => {
		// The type says where the number came from. A measured or estimated
		// fact carries different confidence, and mislabelling one as declared
		// would present a guess as the provider's own price.
		const result = withField((doc) => {
			(
				(doc.cost as Record<string, unknown>).facts as Record<string, unknown>[]
			)[0] = {
				sku: "github-hosted-runner",
				source: { type: "measured", digest: "sha256:abc" },
			};
		});
		expect(result.errors.join(" ")).toContain(
			"cost.facts.0.source.type must be declared-provider",
		);
	});

	it("requires a non-empty source digest", () => {
		// The digest pins which published price list the fact came from —
		// without it the fact cannot be re-derived or audited later.
		for (const digest of [undefined, "", 7, null]) {
			const result = withField((doc) => {
				const fact = (
					(doc.cost as Record<string, unknown>).facts as Record<
						string,
						unknown
					>[]
				)[0] as Record<string, unknown>;
				(fact.source as Record<string, unknown>).digest = digest;
			});
			expect(result.errors.join(" "), String(digest)).toContain(
				"cost.facts.0.source.digest must be a non-empty string",
			);
		}
	});

	it("reports a missing source without throwing on it", () => {
		// A fact with no source at all is a malformed document, not a crash —
		// the parser has to keep collecting the other errors.
		const result = withField((doc) => {
			(
				(doc.cost as Record<string, unknown>).facts as Record<string, unknown>[]
			)[0] = {
				sku: "github-hosted-runner",
			};
		});
		expect(result.ok).toBe(false);
		expect(result.errors.join(" ")).toContain("source.type");
	});
});

describe("the published well-known bundle", () => {
	const bundle = (
		mutate: (documents: {
			index: Record<string, unknown>;
			capabilities: Record<string, unknown>;
			auth: Record<string, unknown>;
			cost: Record<string, unknown>;
		}) => void = () => {},
	) => {
		const published = publishCapabilityManifest();
		const parsed = {
			index: JSON.parse(
				published["/.well-known/capability-manifest/index.json"],
			),
			capabilities: JSON.parse(
				published["/.well-known/capability-manifest/capabilities.json"],
			),
			auth: JSON.parse(published["/.well-known/capability-manifest/auth.json"]),
			cost: JSON.parse(published["/.well-known/capability-manifest/cost.json"]),
		};
		mutate(parsed);
		return parsePublishedManifest({
			"/.well-known/capability-manifest/index.json": JSON.stringify(
				parsed.index,
			),
			"/.well-known/capability-manifest/capabilities.json": JSON.stringify(
				parsed.capabilities,
			),
			"/.well-known/capability-manifest/auth.json": JSON.stringify(parsed.auth),
			"/.well-known/capability-manifest/cost.json": JSON.stringify(parsed.cost),
		});
	};

	it("round-trips what it publishes", () => {
		// Publish and parse are two halves of one contract. A published bundle
		// its own parser rejects would fail every registry that fetched it.
		const result = bundle();
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("declares exactly the two execution-host ports", () => {
		// The provider offers a runner and a build machine. One port would hide
		// half of what it can do; three would offer something it cannot.
		expect(bundle().capabilities.capabilities).toHaveLength(2);
		expect(
			bundle((documents) => {
				documents.capabilities.capabilities = [{ port: "one" }];
			}).errors.join(" "),
		).toContain("exactly the two execution-host ports");
		expect(
			bundle((documents) => {
				documents.capabilities.capabilities = "not-an-array";
			}).errors.join(" "),
		).toContain("exactly the two execution-host ports");
	});

	it("refuses a bundle that publishes a static secret", () => {
		// A well-known document is served unauthenticated. A key published here
		// is a key given away, and each of the three names is a real shape a
		// hand-written auth document might use.
		for (const key of ["staticKey", "clientSecret", "pat"]) {
			expect(
				bundle((documents) => {
					documents.auth[key] = "leaked";
				}).errors.join(" "),
				key,
			).toContain("auth must not publish static secrets");
		}
	});

	it("requires the secretless posture to be stated, not merely implied", () => {
		// The Yard broker mints short-lived installation tokens per operation
		// (HOBO-110). An absent flag would let a registry assume whichever
		// posture it defaults to.
		for (const value of [undefined, true, "false", null]) {
			expect(
				bundle((documents) => {
					documents.auth.staticSecrets = value;
				}).errors.join(" "),
				String(value),
			).toContain("auth.staticSecrets must be false");
		}
	});

	it("requires each document's own schema", () => {
		// Three documents, three schemas — a registry reads them independently,
		// so each has to identify itself.
		expect(
			bundle((documents) => {
				documents.index.manifestSchema = "wrong";
			}).errors.join(" "),
		).toContain("index.manifestSchema must be");
		expect(
			bundle((documents) => {
				documents.auth.schema = "wrong";
			}).errors.join(" "),
		).toContain("auth.schema must be");
		expect(
			bundle((documents) => {
				documents.cost.schema = "wrong";
			}).errors.join(" "),
		).toContain("cost.schema must be");
	});

	it("returns every document it parsed alongside the verdict", () => {
		// A caller reporting a bad bundle needs the content to show what was
		// wrong, not just a list of complaints.
		const result = bundle();
		expect(result.index).toBeDefined();
		expect(result.capabilities).toBeDefined();
		expect(result.auth).toBeDefined();
		expect(result.cost).toBeDefined();
	});

	it("collects several failures at once", () => {
		const result = bundle((documents) => {
			documents.auth.staticSecrets = true;
			documents.auth.pat = "leaked";
			documents.cost.schema = "wrong";
		});
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThanOrEqual(3);
	});
});

describe("publishCapabilityManifest inputs", () => {
	it("uses the documented provider id and regions by default", () => {
		const capabilities = JSON.parse(
			publishCapabilityManifest()[
				"/.well-known/capability-manifest/capabilities.json"
			],
		);
		expect(capabilities.providerId).toBeTruthy();
		expect(capabilities.capabilities[0].regions.length).toBeGreaterThan(0);
	});

	it("takes an explicit provider id and region list", () => {
		// A self-hosted fleet publishes under its own id and its own regions;
		// hard-coding either would make the bundle unusable for one.
		const capabilities = JSON.parse(
			publishCapabilityManifest({
				providerId: "acme-runners",
				regions: ["eu-west"],
			})["/.well-known/capability-manifest/capabilities.json"],
		);
		expect(capabilities.providerId).toBe("acme-runners");
		expect(capabilities.capabilities[0].regions).toEqual(["eu-west"]);
	});

	it("copies the regions rather than aliasing the caller's array", () => {
		// The caller's array is often reused across several publishes. Sharing
		// it would let a later edit rewrite an already-published document.
		const regions = ["eu-west"];
		const published = publishCapabilityManifest({ regions });
		regions.push("us-east");
		const capabilities = JSON.parse(
			published["/.well-known/capability-manifest/capabilities.json"],
		);
		expect(capabilities.capabilities[0].regions).toEqual(["eu-west"]);
	});

	it("gives the two capabilities distinct ports and categories", () => {
		const capabilities = JSON.parse(
			publishCapabilityManifest()[
				"/.well-known/capability-manifest/capabilities.json"
			],
		);
		const ports = capabilities.capabilities.map(
			(entry: { port: string }) => entry.port,
		);
		const categories = capabilities.capabilities.map(
			(entry: { category: string }) => entry.category,
		);
		expect(new Set(ports).size).toBe(2);
		expect(categories).toEqual(["runner", "build-machine"]);
	});
});
