/**
 * Lazy binding-token resolution for a local Camp, and the manifest hash.
 *
 * The failure this guards is a resolved environment that looks right and is
 * wrong: a token left unresolved reaches the process as the literal token text
 * (an app then connects to a host called `{db.url}`), and a token resolved
 * against the wrong resource reaches it as a real value pointing somewhere
 * else. Neither throws.
 */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SAFETY: token fixtures intentionally use controlled manifest boundary values. */
import { describe, expect, it } from "vitest";
import { attachCampToYard, camp } from "../src/camp.js";
import {
	BindingResolutionError,
	canonicalManifestHash,
	resolveLocalBindings,
} from "../src/resolve-local-bindings.js";

const LOCAL = attachCampToYard(camp("dev"), {
	yardId: "local",
	providerId: "local",
});

type ResolveCall = { resourceId: unknown; property: string };

/** A resolver that records what it was asked for and answers deterministically. */
function recordingResolver(
	answer: (resourceId: string, property: string) => string = (id, property) =>
		`${id}#${property}`,
) {
	const calls: ResolveCall[] = [];
	return {
		calls,
		port: {
			async resolve(resourceId: unknown, property: string) {
				calls.push({ resourceId, property });
				return { value: answer(String(resourceId), property) };
			},
		} as never,
	};
}

function manifest(resources: Record<string, unknown>) {
	return {
		schemaVersion: "hobo.wiring-manifest/v1",
		resources,
	} as never;
}

describe("resolveLocalBindings — provider gate", () => {
	it("accepts a bare Camp with no derived provider", async () => {
		// A Camp that was never attached to a Yard is bare metal, which this
		// function treats as local. Requiring an explicit `local` would make
		// `resolveLocalBindings(manifest, camp("dev"), …)` fail for the simplest
		// case there is.
		const env = await resolveLocalBindings(
			manifest({ api: { kind: "api", name: "api", env: { A: "1" } } }),
			camp("dev"),
			recordingResolver().port,
		);
		expect(env.A).toBe("1");
	});

	it("refuses any non-local provider with a typed error naming the field", async () => {
		for (const providerId of ["aws", "azure", "gcp"]) {
			const attached = attachCampToYard(camp("prod"), {
				yardId: "y",
				providerId,
			});
			try {
				await resolveLocalBindings(
					manifest({}),
					attached,
					recordingResolver().port,
				);
				expect.unreachable("a non-local provider must be refused");
			} catch (error) {
				// The path is what tells an operator which field to look at; a bare
				// Error would leave them guessing between the Camp and the Yard.
				expect(error).toBeInstanceOf(BindingResolutionError);
				expect((error as BindingResolutionError).path).toBe(
					"camp.derivedProviderId",
				);
				expect((error as Error).message).toContain(providerId);
			}
		}
	});

	it("checks the provider before touching the manifest", async () => {
		const resolver = recordingResolver();
		await expect(
			resolveLocalBindings(
				manifest({
					api: { kind: "api", name: "api", env: { A: "{cache.url}" } },
				}),
				attachCampToYard(camp("prod"), { yardId: "y", providerId: "aws" }),
				resolver.port,
			),
		).rejects.toThrow(/requires local provider/u);
		// Nothing was resolved. A gate that ran after resolution would already
		// have pulled secrets for a Camp it was about to refuse.
		expect(resolver.calls).toEqual([]);
	});
});

describe("resolveLocalBindings — token resolution", () => {
	it("passes a literal value through untouched", async () => {
		const resolver = recordingResolver();
		const env = await resolveLocalBindings(
			manifest({
				api: {
					kind: "api",
					name: "api",
					env: { PLAIN: "value", EMPTY: "", NUMBERISH: "8080" },
				},
			}),
			LOCAL,
			resolver.port,
		);
		expect(env).toEqual({ PLAIN: "value", EMPTY: "", NUMBERISH: "8080" });
		// A literal must not be sent to the resolver: doing so would turn every
		// plain config value into a lookup that fails.
		expect(resolver.calls).toEqual([]);
	});

	it("resolves a lazy token through the port and substitutes the value", async () => {
		const resolver = recordingResolver(() => "postgres://local/app");
		const env = await resolveLocalBindings(
			manifest({
				api: {
					kind: "api",
					name: "api",
					env: { DATABASE_URL: "{db.connectionString}" },
				},
			}),
			LOCAL,
			resolver.port,
		);
		expect(env.DATABASE_URL).toBe("postgres://local/app");
		// The token text itself must never survive into the environment — an app
		// receiving the literal `{db.connectionString}` would try to connect to
		// it verbatim.
		expect(env.DATABASE_URL).not.toContain("{");
		expect(resolver.calls).toHaveLength(1);
		expect(resolver.calls[0]?.property).toBe("connectionString");
	});

	it("resolves tokens across several resources and keys", async () => {
		const resolver = recordingResolver(
			(id, property) => `${String(id)}::${property}`,
		);
		const env = await resolveLocalBindings(
			manifest({
				api: {
					kind: "api",
					name: "api",
					env: {
						DB: "{db.url}",
						PLAIN: "x",
					},
				},
				worker: {
					kind: "worker",
					name: "worker",
					env: { CACHE: "{cache.url}" },
				},
			}),
			LOCAL,
			resolver.port,
		);
		expect(Object.keys(env).sort()).toEqual(["CACHE", "DB", "PLAIN"]);
		// Each token resolved against its own resource. Reusing one resource id
		// for every token would hand the worker the database's URL.
		expect(env.DB).not.toBe(env.CACHE);
		expect(resolver.calls).toHaveLength(2);
	});

	it("tolerates a resource with no env block", async () => {
		// `env` is optional on a manifest resource; a resource that declares none
		// must contribute nothing rather than throwing partway through the loop
		// and leaving the caller with no environment at all.
		const env = await resolveLocalBindings(
			manifest({
				api: { kind: "api", name: "api" },
				worker: { kind: "worker", name: "worker", env: { A: "1" } },
			}),
			LOCAL,
			recordingResolver().port,
		);
		expect(env).toEqual({ A: "1" });
	});

	it("returns an empty frozen environment for an empty manifest", async () => {
		const env = await resolveLocalBindings(
			manifest({}),
			LOCAL,
			recordingResolver().port,
		);
		expect(env).toEqual({});
		// Frozen so a caller cannot inject a variable into a resolved environment
		// after the fact and have it look like it came from the manifest.
		expect(Object.isFrozen(env)).toBe(true);
	});

	it("lets a later resource win a duplicated key", async () => {
		// Pinning last-writer-wins rather than assuming a refusal. Two resources
		// declaring the same env key is a manifest-authoring problem, and this
		// function is not where it is caught — but the behaviour is deterministic
		// because `Object.values` follows insertion order.
		const env = await resolveLocalBindings(
			manifest({
				first: { kind: "a", name: "a", env: { SHARED: "one" } },
				second: { kind: "b", name: "b", env: { SHARED: "two" } },
			}),
			LOCAL,
			recordingResolver().port,
		);
		expect(env.SHARED).toBe("two");
	});

	it("propagates a resolver failure rather than substituting a placeholder", async () => {
		// A failed lookup must stop the deployment. Falling back to the literal
		// token, or to an empty string, would start a process pointed at nothing,
		// which fails much later and much less clearly.
		await expect(
			resolveLocalBindings(
				manifest({
					api: {
						kind: "api",
						name: "api",
						env: { DB: "{db.url}" },
					},
				}),
				LOCAL,
				{
					async resolve() {
						throw new Error("no such binding");
					},
				} as never,
			),
		).rejects.toThrow(/no such binding/u);
	});
});

describe("canonicalManifestHash", () => {
	const base = manifest({
		api: { kind: "api", name: "api", env: { B: "2", A: "1" } },
	});

	it("is stable across key order at every depth", () => {
		const reordered = {
			resources: {
				api: { env: { A: "1", B: "2" }, name: "api", kind: "api" },
			},
			schemaVersion: "hobo.wiring-manifest/v1",
		} as never;
		// This hash is what tells a Station that a redeploy is a no-op. If it
		// depended on key order, a serializer change would look like a manifest
		// change and force an unnecessary redeploy of everything.
		expect(canonicalManifestHash(reordered)).toBe(canonicalManifestHash(base));
	});

	it("changes when any value changes", () => {
		const changed = manifest({
			api: { kind: "api", name: "api", env: { B: "2", A: "changed" } },
		});
		// And the converse of the above: a real change must not hash equal, or a
		// redeploy that matters would be skipped.
		expect(canonicalManifestHash(changed)).not.toBe(
			canonicalManifestHash(base),
		);
	});

	it("preserves array order, which is semantic", () => {
		const forward = manifest({
			api: { kind: "api", name: "api", ports: [80, 443] },
		});
		const reversed = manifest({
			api: { kind: "api", name: "api", ports: [443, 80] },
		});
		// Sorting arrays too would be a plausible-looking "more canonical" change
		// and would make two genuinely different manifests hash identically.
		expect(canonicalManifestHash(forward)).not.toBe(
			canonicalManifestHash(reversed),
		);
	});

	it("handles nulls and primitives inside the manifest", () => {
		const withNull = manifest({
			api: { kind: "api", name: "api", replicas: null, enabled: false },
		});
		// `sortKeys` returns early for anything that is not an object, and `null`
		// is typeof "object" — so the falsy guard is what stops it recursing into
		// nothing. Without it this would throw on any manifest carrying a null.
		expect(() => canonicalManifestHash(withNull)).not.toThrow();
		expect(canonicalManifestHash(withNull)).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("is prefixed and hex-encoded", () => {
		// The `sha256:` prefix is what lets a consumer tell this apart from a
		// digest computed with a different algorithm later.
		expect(canonicalManifestHash(base)).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("is deterministic across calls", () => {
		expect(canonicalManifestHash(base)).toBe(canonicalManifestHash(base));
	});
});
