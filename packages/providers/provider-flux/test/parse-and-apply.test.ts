/**
 * The Flux deploy spec — parsing it, and refusing an unsafe production apply.
 *
 * Flux is a community-tier PaaS with a paid multi-instance tier above it, and
 * this parser is where HoBo decides what it will and will not run there. Most
 * of the refusals are security ones, and each guards a specific way a Flux
 * deploy can go wrong.
 *
 * **Secret material never travels in a spec field.** `webhookSecretRef` and
 * `apiKeySecretRef` are *locators* — names of secrets held elsewhere. A spec
 * carrying the secret itself would put it in every plan, every log line, and
 * every stored deployment record. The check refuses anything that looks like a
 * credential or a URL, and it is deliberately blunt: a false refusal costs a
 * rename, a false accept costs a leak.
 *
 * **Production requires a pinned digest, a signed webhook, authenticated
 * status, and a paid tier.** Each is separately fatal because each has a
 * separate consequence: a floating tag deploys something other than what was
 * reviewed; an unsigned webhook lets anyone trigger a deploy; public `/status`
 * and `/health` leak the shape of a running system; and community nodes have
 * no isolation guarantee to put production work behind.
 *
 * **The Rivet control plane must never run on a community node** — that is a
 * separate refusal from the production tier check, because it applies even to
 * a preview deployment.
 *
 * **An unmapped residency region fails closed** (ADR-0146): an empty region is
 * a jurisdiction nobody resolved, and defaulting it would place data somewhere
 * nobody chose.
 */
import { describe, expect, it } from "vitest";

import {
	applyFluxDeploy,
	FLUX_RIVET_RUNNER_RECIPE,
	type FluxDeploySpec,
	type FluxProviderError,
	parseFluxDeploySpec,
} from "../src/parse.js";

/** A spec that parses, for tests that vary one field at a time. */
function doc(overrides: Record<string, unknown> = {}) {
	return {
		source: "oci",
		tier: "paid-multi-instance",
		environment: "preview",
		primitives: ["web"],
		...overrides,
	};
}

/** A parsed spec that applies cleanly in production. */
function productionSpec(
	overrides: Partial<FluxDeploySpec> = {},
): FluxDeploySpec {
	return parseFluxDeploySpec(
		doc({
			environment: "production",
			imageDigest: `sha256:${"a".repeat(64)}`,
			webhookSigned: true,
			statusLogsAuthenticated: true,
			...overrides,
		}),
	);
}

/** The code of the error a call throws, or undefined if it did not throw. */
function codeOf(run: () => unknown): string | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		return (error as FluxProviderError).code;
	}
}

describe("spec shape", () => {
	it("refuses anything that is not an object", () => {
		for (const raw of [null, undefined, "spec", 7, true]) {
			expect(codeOf(() => parseFluxDeploySpec(raw))).toBe("PARSE");
		}
	});

	it("refuses a source outside oci|git", () => {
		// The source decides whether the deploy is digest-pinned or
		// branch-tracking. An unrecognised one would fall through both.
		for (const source of [undefined, "", "docker", "OCI", 7]) {
			expect(codeOf(() => parseFluxDeploySpec(doc({ source })))).toBe("PARSE");
		}
		expect(parseFluxDeploySpec(doc({ source: "git" })).source).toBe("git");
	});

	it("refuses a tier it does not know", () => {
		// The tier gates production. An unrecognised one would skip the check
		// that keeps production work off community nodes.
		for (const tier of [undefined, "", "enterprise", "free"]) {
			expect(codeOf(() => parseFluxDeploySpec(doc({ tier })))).toBe("PARSE");
		}
	});

	it("refuses an environment outside preview|production", () => {
		for (const environment of [undefined, "", "staging", "prod"]) {
			expect(codeOf(() => parseFluxDeploySpec(doc({ environment })))).toBe(
				"PARSE",
			);
		}
	});

	it("requires a non-empty primitives array", () => {
		// A deploy that realizes nothing would report success having created
		// no workload at all.
		for (const primitives of [undefined, [], "web", {}]) {
			expect(codeOf(() => parseFluxDeploySpec(doc({ primitives })))).toBe(
				"PARSE",
			);
		}
	});

	it("refuses a non-string primitive rather than coercing it", () => {
		expect(codeOf(() => parseFluxDeploySpec(doc({ primitives: [7] })))).toBe(
			"PARSE",
		);
	});

	it("freezes the parsed spec", () => {
		// The spec is read at apply time and stored in the deployment record. A
		// caller editing it in place would make the record disagree with what
		// was deployed.
		expect(Object.isFrozen(parseFluxDeploySpec(doc()))).toBe(true);
	});
});

describe("supported primitives", () => {
	it("realizes web, api, and service", () => {
		for (const primitive of ["web", "api", "service"]) {
			expect(
				parseFluxDeploySpec(doc({ primitives: [primitive] })).primitives,
			).toEqual([primitive]);
		}
	});

	it("refuses a stateful primitive under its own code, pointing elsewhere", () => {
		// Flux realizes stateless HTTP workloads. Accepting a queue or a bucket
		// would deploy an app whose data plane simply does not exist — and the
		// message has to name the alternative, or the user has no next step.
		for (const primitive of ["actor", "data", "kv", "queue", "bucket"]) {
			expect(
				codeOf(() => parseFluxDeploySpec(doc({ primitives: [primitive] }))),
				primitive,
			).toBe("PRIMITIVE_UNSUPPORTED");
		}
		expect(() => parseFluxDeploySpec(doc({ primitives: ["kv"] }))).toThrow(
			/use an actor\/data\/kv\/queue\/bucket provider/,
		);
	});

	it("refuses the whole spec when any primitive is unsupported", () => {
		// A partial realization would deploy the web tier of an app whose
		// storage was silently dropped.
		expect(
			codeOf(() => parseFluxDeploySpec(doc({ primitives: ["web", "kv"] }))),
		).toBe("PRIMITIVE_UNSUPPORTED");
	});

	it("accepts several supported primitives together", () => {
		expect(
			parseFluxDeploySpec(doc({ primitives: ["web", "api", "service"] }))
				.primitives,
		).toEqual(["web", "api", "service"]);
	});
});

describe("secret locators", () => {
	it("accepts a plain locator name", () => {
		const spec = parseFluxDeploySpec(
			doc({ webhookSecretRef: "flux-webhook", apiKeySecretRef: "flux-api" }),
		);
		expect(spec.webhookSecretRef).toBe("flux-webhook");
		expect(spec.apiKeySecretRef).toBe("flux-api");
	});

	it("refuses a value that looks like credential material", () => {
		// The check is blunt on purpose: a false refusal costs a rename, a false
		// accept puts a live credential into every plan, log, and stored record.
		for (const value of [
			"sk-live-abc123",
			"my-token-value",
			"hunter2-password",
			"AKIAIOSFODNN7EXAMPLE",
		]) {
			expect(
				codeOf(() => parseFluxDeploySpec(doc({ webhookSecretRef: value }))),
				value,
			).toBe("SECRET_MATERIAL");
		}
	});

	it("refuses a URL, which is a fetch target rather than a locator", () => {
		// A URL in this field is someone pointing at a secret *service*, which
		// would have the provider fetch credentials itself.
		expect(
			codeOf(() =>
				parseFluxDeploySpec(
					doc({ apiKeySecretRef: "https://vault.example/secret" }),
				),
			),
		).toBe("SECRET_MATERIAL");
	});

	it("checks the two secret fields independently", () => {
		// A clean webhook ref must not vouch for a dirty api key ref.
		expect(
			codeOf(() =>
				parseFluxDeploySpec(
					doc({ webhookSecretRef: "ok", apiKeySecretRef: "sk-live-x" }),
				),
			),
		).toBe("SECRET_MATERIAL");
	});

	it("omits a secret field that was not a string", () => {
		// A number here is a malformed document, not a locator. Coercing it
		// would produce a ref that resolves to nothing at deploy time.
		const spec = parseFluxDeploySpec(doc({ webhookSecretRef: 7 }));
		expect(spec.webhookSecretRef).toBeUndefined();
	});
});

describe("control plane placement", () => {
	it("refuses the Rivet control plane on a community node", () => {
		// Community nodes carry no isolation guarantee. This is separate from
		// the production tier check because it applies to preview deploys too.
		expect(
			codeOf(() =>
				parseFluxDeploySpec(
					doc({ tier: "community-free", hostsRivetControlPlane: true }),
				),
			),
		).toBe("CONTROL_PLANE_ON_COMMUNITY");
	});

	it("allows the control plane on the paid tier", () => {
		expect(
			parseFluxDeploySpec(doc({ hostsRivetControlPlane: true }))
				.hostsRivetControlPlane,
		).toBe(true);
	});

	it("treats anything but a literal true as not hosting it", () => {
		// A truthy string would otherwise place a control plane the operator
		// never asked for — and on the community tier, past the refusal above.
		for (const value of ["true", 1, undefined]) {
			expect(
				parseFluxDeploySpec(
					doc({ tier: "community-free", hostsRivetControlPlane: value }),
				).hostsRivetControlPlane,
			).toBeUndefined();
		}
	});
});

describe("residency", () => {
	it("fails closed on an empty region", () => {
		// An empty region is a jurisdiction nobody resolved. Defaulting it would
		// place data somewhere nobody chose (ADR-0146).
		expect(
			codeOf(() => parseFluxDeploySpec(doc({ residencyRegion: "" }))),
		).toBe("RESIDENCY_UNMAPPED");
	});

	it("carries a named region through", () => {
		expect(
			parseFluxDeploySpec(doc({ residencyRegion: "eu-central" }))
				.residencyRegion,
		).toBe("eu-central");
	});

	it("omits the region entirely when none was given", () => {
		// Absent is "no residency requirement stated", which is different from
		// an empty one — and only the second is a failure.
		expect(parseFluxDeploySpec(doc()).residencyRegion).toBeUndefined();
		expect(
			parseFluxDeploySpec(doc({ residencyRegion: 7 })).residencyRegion,
		).toBeUndefined();
	});
});

describe("boolean flags default closed", () => {
	it("treats a missing or non-boolean signal as not signed and not authenticated", () => {
		// Both flags gate a production apply. Defaulting either open would let
		// an unsigned webhook or a public status endpoint reach production on a
		// malformed document.
		for (const value of [undefined, "true", 1, null]) {
			const spec = parseFluxDeploySpec(
				doc({ webhookSigned: value, statusLogsAuthenticated: value }),
			);
			expect(spec.webhookSigned, String(value)).toBe(false);
			expect(spec.statusLogsAuthenticated, String(value)).toBe(false);
		}
	});

	it("honours a literal true", () => {
		const spec = parseFluxDeploySpec(
			doc({ webhookSigned: true, statusLogsAuthenticated: true }),
		);
		expect(spec.webhookSigned).toBe(true);
		expect(spec.statusLogsAuthenticated).toBe(true);
	});
});

describe("applying a preview deploy", () => {
	it("applies without any of the production requirements", () => {
		// Preview is where an unsigned webhook and a floating tag are fine —
		// that is the point of a preview.
		const receipt = applyFluxDeploy(
			parseFluxDeploySpec(doc({ source: "git" })),
		);
		expect(receipt.applied).toBe(true);
		expect(receipt.source).toBe("git");
	});

	it("applies on the community tier", () => {
		expect(
			applyFluxDeploy(parseFluxDeploySpec(doc({ tier: "community-free" })))
				.applied,
		).toBe(true);
	});

	it("reports orbit mode exactly for a git source", () => {
		// Orbit mode is branch-tracking. A caller reading this decides whether
		// to expect the deployment to change under it without another apply.
		expect(
			applyFluxDeploy(parseFluxDeploySpec(doc({ source: "git" }))).orbitMode,
		).toBe(true);
		expect(
			applyFluxDeploy(parseFluxDeploySpec(doc({ source: "oci" }))).orbitMode,
		).toBe(false);
	});
});

describe("applying a production deploy", () => {
	it("applies when every requirement is met", () => {
		const receipt = applyFluxDeploy(productionSpec());
		expect(receipt).toEqual({
			applied: true,
			source: "oci",
			orbitMode: false,
		});
	});

	it("refuses a git source in production", () => {
		// Branch-tracking in production deploys whatever lands on the branch,
		// which is not what was reviewed.
		expect(
			codeOf(() =>
				applyFluxDeploy(
					parseFluxDeploySpec(
						doc({
							environment: "production",
							source: "git",
							webhookSigned: true,
							statusLogsAuthenticated: true,
						}),
					),
				),
			),
		).toBe("DIGEST_REQUIRED");
	});

	it("refuses a missing or unpinned digest", () => {
		// A tag is mutable. Only a `sha256:` digest names exactly the image that
		// was reviewed.
		for (const imageDigest of [undefined, "latest", "v1.2.3", "md5:abc"]) {
			expect(
				codeOf(() =>
					applyFluxDeploy(
						parseFluxDeploySpec(
							doc({
								environment: "production",
								imageDigest,
								webhookSigned: true,
								statusLogsAuthenticated: true,
							}),
						),
					),
				),
				String(imageDigest),
			).toBe("DIGEST_REQUIRED");
		}
	});

	it("refuses an unsigned webhook", () => {
		// An unsigned webhook endpoint lets anyone who finds the URL trigger a
		// production deploy.
		expect(
			codeOf(() =>
				applyFluxDeploy(productionSpec({ webhookSigned: false } as never)),
			),
		).toBe("WEBHOOK_UNSIGNED");
	});

	it("refuses public status and health endpoints", () => {
		// `/status` and `/health` describe the shape of a running system —
		// versions, dependencies, and what is failing.
		expect(
			codeOf(() =>
				applyFluxDeploy(
					parseFluxDeploySpec(
						doc({
							environment: "production",
							imageDigest: `sha256:${"a".repeat(64)}`,
							webhookSigned: true,
						}),
					),
				),
			),
		).toBe("STATUS_LOGS_PUBLIC");
	});

	it("refuses the community tier", () => {
		// Community nodes are shared and carry no isolation guarantee.
		expect(
			codeOf(() =>
				applyFluxDeploy(
					parseFluxDeploySpec(
						doc({
							environment: "production",
							tier: "community-free",
							imageDigest: `sha256:${"a".repeat(64)}`,
							webhookSigned: true,
							statusLogsAuthenticated: true,
						}),
					),
				),
			),
		).toBe("COMMUNITY_PRODUCTION");
	});

	it("reports the first unmet requirement rather than the last", () => {
		// A spec missing everything gets one actionable answer at a time. The
		// digest comes first because it is the one that decides *what* deploys.
		expect(
			codeOf(() =>
				applyFluxDeploy(
					parseFluxDeploySpec(
						doc({ environment: "production", tier: "community-free" }),
					),
				),
			),
		).toBe("DIGEST_REQUIRED");
	});
});

describe("the Rivet runner recipe", () => {
	it("keeps the control plane on a trusted Yard and runners outbound-only", () => {
		// This is the shape that makes running Rivet on Flux safe at all: the
		// community nodes never hold control-plane state and never accept
		// inbound connections.
		expect(FLUX_RIVET_RUNNER_RECIPE).toEqual({
			id: "rivet-runners-on-flux",
			controlPlane: "trusted-yard",
			runners: "flux-outbound-only",
		});
	});
});
