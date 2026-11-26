/**
 * The policy IR parse boundary.
 *
 * Everything in this module exists so that a decision can be re-derived and
 * re-checked later: `inputHash` binds a decision to the exact request it
 * answered, and canonical JSON is what makes that hash stable across encoders.
 * A branch that is wrong here does not produce a crash — it produces an
 * *evidence trail that does not prove what it claims*, which is the failure
 * each assertion below is written against.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	canonicalJson,
	createDecision,
	createDecisionRequest,
	createPolicyDecidedEvent,
	DATA_CLASSIFICATIONS,
	EFFECTS,
	fromWitDecisionRecord,
	hashDecisionRequest,
	migratePolicyIrDocument,
	PHASES,
	POLICY_DECIDED_EVENT_TYPE,
	POLICY_IR_SCHEMA_VERSION,
	PolicyIrValidationError,
	parseDecision,
	parseDecisionRequest,
	parsePolicyIrDocument,
	SUBJECT_KINDS,
	serializePolicyIrDocument,
	toWitDecisionRecord,
} from "../src/policy-ir.js";

const V = POLICY_IR_SCHEMA_VERSION;

function request(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: V,
		subject: { kind: "user", id: "u-1" },
		action: "deploy",
		resource: { kind: "camp", id: "camp-1" },
		phase: "apply",
		...overrides,
	};
}

/** Assert the thrown error is the typed parse error with this code and path. */
function expectRejection(
	run: () => unknown,
	code: string,
	path?: string,
): PolicyIrValidationError {
	try {
		run();
	} catch (error) {
		// The typed error is the contract: callers branch on `code` to decide
		// whether a request is retryable or terminal, and `path` is what a CLI
		// prints to tell an operator *which* field to fix. A bare `Error` — or a
		// TypeError from an unguarded property read — would satisfy a plain
		// `toThrow()` while giving callers nothing to branch on.
		expect(error).toBeInstanceOf(PolicyIrValidationError);
		const typed = error as PolicyIrValidationError;
		expect(typed.code).toBe(code);
		if (path !== undefined) expect(typed.path).toBe(path);
		return typed;
	}
	expect.unreachable(`expected a ${code} rejection`);
	throw new Error("unreachable");
}

describe("vocabularies", () => {
	it("pins the closed vocabularies the rest of the platform switches on", () => {
		// These arrays are the wire contract. Adding a member is a schema change;
		// silently dropping one would make previously-valid stored decisions
		// unparseable on replay.
		expect(SUBJECT_KINDS).toEqual(["user", "service", "agent", "system"]);
		expect(PHASES).toEqual([
			"author",
			"local",
			"test",
			"plan",
			"apply",
			"runtime",
			"observe",
			"train",
			"promote",
			"repair",
		]);
		expect(EFFECTS).toEqual([
			"allow",
			"allow-degraded",
			"deny",
			"warn",
			"mutate",
			"require-approval",
		]);
		expect(DATA_CLASSIFICATIONS).toEqual([
			"public",
			"internal",
			"pii",
			"phi",
			"pci",
			"secret",
		]);
	});

	it("freezes them so a consumer cannot widen the vocabulary at runtime", () => {
		// A pack that pushed onto EFFECTS would make an unknown effect parse
		// successfully for every other consumer in the process.
		expect(Object.isFrozen(EFFECTS)).toBe(true);
		expect(Object.isFrozen(PHASES)).toBe(true);
		expect(Object.isFrozen(SUBJECT_KINDS)).toBe(true);
		expect(Object.isFrozen(DATA_CLASSIFICATIONS)).toBe(true);
	});
});

describe("PolicyIrValidationError", () => {
	it("builds a message that names the code and path, defaulting the path to $", () => {
		const err = new PolicyIrValidationError("bad-thing", "why", "$.a.b");
		expect(err.message).toBe("bad-thing at $.a.b: why");
		expect(err.name).toBe("PolicyIrValidationError");
		// The default matters: an error raised at the document root must still
		// print a location rather than "undefined".
		expect(new PolicyIrValidationError("c", "m").path).toBe("$");
	});
});

describe("parseDecisionRequest", () => {
	it("parses a minimal request and stamps a canonical inputHash", () => {
		const parsed = parseDecisionRequest(request());
		expect(parsed.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
		// Absent context becomes `{}`, not `undefined`. If it stayed undefined the
		// hash would depend on whether the caller spelled the key, so two
		// identical requests would produce two different evidence trails.
		expect(parsed.context).toEqual({});
		expect(parsed.inputHash).toBe(
			parseDecisionRequest(request({ context: {} })).inputHash,
		);
	});

	it("createDecisionRequest is parseDecisionRequest", () => {
		// The alias exists for readability at call sites; if it ever diverged,
		// requests built one way would hash differently from the other.
		expect(createDecisionRequest(request())).toEqual(
			parseDecisionRequest(request()),
		);
	});

	it("rejects a non-object input", () => {
		expectRejection(() => parseDecisionRequest(null), "expected-object", "$");
		expectRejection(() => parseDecisionRequest([]), "expected-object", "$");
		expectRejection(() => parseDecisionRequest("{}"), "expected-object", "$");
	});

	it("accepts a null-prototype object but rejects a class instance", () => {
		const bare = Object.assign(Object.create(null), request());
		expect(() => parseDecisionRequest(bare)).not.toThrow();
		// `isPlainObject` deliberately excludes exotic objects: a Date or a class
		// instance would serialize through `JSON.stringify` in a way this module's
		// canonicalizer never sees, so the hash would not be reproducible.
		class Req {}
		expectRejection(
			() => parseDecisionRequest(Object.assign(new Req(), request())),
			"expected-object",
			"$",
		);
	});

	it("rejects a wrong or missing schema version", () => {
		expectRejection(
			() =>
				parseDecisionRequest(request({ schemaVersion: "hobo.policy-ir/v0" })),
			"unsupported-version",
			"$.schemaVersion",
		);
		expectRejection(
			() => parseDecisionRequest({ ...request(), schemaVersion: undefined }),
			"unsupported-version",
			"$.schemaVersion",
		);
	});

	it("requires the subject key to be present, distinguishing absent from undefined", () => {
		const { subject: _drop, ...noSubject } = request();
		expectRejection(
			() => parseDecisionRequest(noSubject),
			"missing-subject",
			"$.subject",
		);
		// `Object.hasOwn` and not a truthiness check: an explicit
		// `subject: undefined` is a *present* key and falls through to the
		// subject parser, which reports the shape problem instead. Collapsing the
		// two would hide "you forgot to say who is asking" behind a generic error.
		expectRejection(
			() => parseDecisionRequest(request({ subject: undefined })),
			"expected-object",
			"$.subject",
		);
	});

	it("rejects an unknown subject kind and an empty subject id", () => {
		expectRejection(
			() =>
				parseDecisionRequest(request({ subject: { kind: "robot", id: "r" } })),
			"unknown-subject-kind",
			"$.subject.kind",
		);
		expectRejection(
			() =>
				parseDecisionRequest(request({ subject: { kind: "user", id: "  " } })),
			"expected-string",
			"$.subject.id",
		);
	});

	it("accepts every declared subject kind", () => {
		for (const kind of SUBJECT_KINDS) {
			// Agents and system subjects are the ones guardrail packs key on; a
			// vocabulary that parsed only `user` would make agent policy dead code.
			expect(
				parseDecisionRequest(request({ subject: { kind, id: "s" } })).subject
					.kind,
			).toBe(kind);
		}
	});

	it("carries optional roles and scopes, and rejects non-string members", () => {
		const parsed = parseDecisionRequest(
			request({
				subject: {
					kind: "user",
					id: "u-1",
					roles: ["admin"],
					scopes: ["camp:write"],
				},
			}),
		);
		expect(parsed.subject.roles).toEqual(["admin"]);
		expect(parsed.subject.scopes).toEqual(["camp:write"]);
		// Roles and scopes are what a pack compares against. A numeric member
		// would never equal any policy's string role and would silently fail open
		// or closed depending on the pack.
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ subject: { kind: "user", id: "u", roles: ["ok", 7] } }),
				),
			"expected-string",
			"$.subject.roles[1]",
		);
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ subject: { kind: "user", id: "u", scopes: "camp:write" } }),
				),
			"expected-array",
			"$.subject.scopes",
		);
	});

	it("omits roles and scopes entirely when not supplied", () => {
		const parsed = parseDecisionRequest(request());
		// Absent, not `[]`: an empty array would read as "this subject has no
		// roles" to a pack that distinguishes the two, and it would change the
		// hash of a request that never mentioned roles.
		expect(Object.hasOwn(parsed.subject, "roles")).toBe(false);
		expect(Object.hasOwn(parsed.subject, "scopes")).toBe(false);
	});

	it("accepts delegatedBy as a bare string or as a subject reference", () => {
		expect(
			parseDecisionRequest(
				request({
					subject: { kind: "agent", id: "a-1", delegatedBy: "u-1" },
				}),
			).subject.delegatedBy,
		).toBe("u-1");
		expect(
			parseDecisionRequest(
				request({
					subject: {
						kind: "agent",
						id: "a-1",
						delegatedBy: { kind: "user", id: "u-1" },
					},
				}),
			).subject.delegatedBy,
		).toEqual({ kind: "user", id: "u-1" });
	});

	it("rejects a malformed delegatedBy", () => {
		// Delegation is the audit link from an agent's action back to the human
		// accountable for it. An unvalidated one produces an evidence trail that
		// names a principal nobody can resolve.
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ subject: { kind: "agent", id: "a", delegatedBy: "" } }),
				),
			"expected-string",
			"$.subject.delegatedBy",
		);
		expectRejection(
			() =>
				parseDecisionRequest(
					request({
						subject: {
							kind: "agent",
							id: "a",
							delegatedBy: { kind: "robot", id: "r" },
						},
					}),
				),
			"unknown-subject-kind",
			"$.subject.delegatedBy.kind",
		);
		expectRejection(
			() =>
				parseDecisionRequest(
					request({
						subject: { kind: "agent", id: "a", delegatedBy: { kind: "user" } },
					}),
				),
			"expected-string",
			"$.subject.delegatedBy.id",
		);
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ subject: { kind: "agent", id: "a", delegatedBy: 7 } }),
				),
			"expected-object",
			"$.subject.delegatedBy",
		);
	});

	it("rejects an empty action and a malformed resource", () => {
		expectRejection(
			() => parseDecisionRequest(request({ action: "" })),
			"expected-string",
			"$.action",
		);
		expectRejection(
			() => parseDecisionRequest(request({ resource: { kind: "camp" } })),
			"expected-string",
			"$.resource.id",
		);
		expectRejection(
			() => parseDecisionRequest(request({ resource: undefined })),
			"expected-object",
			"$.resource",
		);
	});

	it("rejects an unknown phase and accepts every declared one", () => {
		expectRejection(
			() => parseDecisionRequest(request({ phase: "deploy" })),
			"unknown-phase",
			"$.phase",
		);
		for (const phase of PHASES) {
			expect(parseDecisionRequest(request({ phase })).phase).toBe(phase);
		}
	});

	it("canonicalizes context by sorting keys, so key order cannot change the hash", () => {
		const a = parseDecisionRequest(
			request({ context: { zeta: 1, alpha: { b: 2, a: 1 } } }),
		);
		const b = parseDecisionRequest(
			request({ context: { alpha: { a: 1, b: 2 }, zeta: 1 } }),
		);
		// Two encoders that emit the same object in different orders must produce
		// the same evidence hash, or a decision replayed from storage would be
		// reported as answering a different request than it did.
		expect(a.inputHash).toBe(b.inputHash);
		expect(Object.keys(a.context.alpha)).toEqual(["a", "b"]);
	});

	it("rejects context values that are not JSON", () => {
		expectRejection(
			() => parseDecisionRequest(request({ context: { n: Number.NaN } })),
			"invalid-json-number",
			"$.context.n",
		);
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ context: { n: Number.POSITIVE_INFINITY } }),
				),
			"invalid-json-number",
			"$.context.n",
		);
		expectRejection(
			() => parseDecisionRequest(request({ context: { u: undefined } })),
			"invalid-json-value",
			"$.context.u",
		);
		expectRejection(
			() => parseDecisionRequest(request({ context: { f: () => 1 } })),
			"invalid-json-value",
			"$.context.f",
		);
		expectRejection(
			() => parseDecisionRequest(request({ context: { d: new Date(0) } })),
			"invalid-json-value",
			"$.context.d",
		);
		// `JSON.stringify` would happily turn NaN into `null` and drop the
		// undefined key, producing a hash over a *different* request than the
		// caller supplied. Rejecting is what keeps the hash honest.
	});

	it("keeps null, booleans, numbers, strings and nested arrays in context", () => {
		const parsed = parseDecisionRequest(
			request({
				context: { n: null, b: false, i: 0, s: "", arr: [1, [2, { k: "v" }]] },
			}),
		);
		// `0`, `false` and `""` are all falsy; a canonicalizer written with
		// truthiness checks would drop them and change the hash.
		expect(parsed.context).toEqual({
			n: null,
			b: false,
			i: 0,
			s: "",
			arr: [1, [2, { k: "v" }]],
		});
	});

	it("rejects a non-JSON value nested inside a context array", () => {
		expectRejection(
			() => parseDecisionRequest(request({ context: { a: [1, Number.NaN] } })),
			"invalid-json-number",
			"$.context.a[1]",
		);
	});

	it("accepts a context that is an array, and hashes it as one", () => {
		// Pinning what actually happens rather than what I expected. `context` is
		// only required to be a JSON *value*, so an array passes the canonicalizer,
		// and `assertDataClassifications` returns early because an array has no
		// own `dataClassifications` key. Nothing today sends one, but the hash is
		// still well defined, so this is a tolerated shape rather than a hole: the
		// classification guard cannot be bypassed by wrapping the key in an array,
		// because an array simply has no such key to read.
		const parsed = parseDecisionRequest(request({ context: [1, 2] }));
		expect(parsed.context).toEqual([1, 2]);
		expect(parsed.inputHash).not.toBe(
			parseDecisionRequest(request()).inputHash,
		);
		// A scalar context is likewise accepted; the only thing rejected is a
		// value that is not JSON at all.
		expect(parseDecisionRequest(request({ context: "eu" })).context).toBe("eu");
		expectRejection(
			() => parseDecisionRequest(request({ context: () => 1 })),
			"invalid-json-value",
			"$.context",
		);
	});
});

describe("dataClassifications (ADR-0146)", () => {
	it("accepts every declared classification", () => {
		for (const label of DATA_CLASSIFICATIONS) {
			expect(
				parseDecisionRequest(
					request({ context: { dataClassifications: [label] } }),
				).context.dataClassifications,
			).toEqual([label]);
		}
	});

	it("ignores a context with no dataClassifications key at all", () => {
		// Most requests carry none. The guard must be opt-in, or every existing
		// caller would start failing.
		expect(() =>
			parseDecisionRequest(request({ context: { other: 1 } })),
		).not.toThrow();
	});

	it("rejects a non-array dataClassifications", () => {
		expectRejection(
			() =>
				parseDecisionRequest(
					request({ context: { dataClassifications: "pii" } }),
				),
			"invalid-data-classifications",
			"$.context.dataClassifications",
		);
	});

	it("rejects an unknown label and names its index", () => {
		const err = expectRejection(
			() =>
				parseDecisionRequest(
					request({ context: { dataClassifications: ["pii", "top-secret"] } }),
				),
			"unknown-data-classification",
			"$.context.dataClassifications[1]",
		);
		// Residency packs read this key without re-parsing it (that is the point
		// of pinning it here), so an unrecognized label reaching them would be
		// treated as "not sensitive" and route data into the wrong jurisdiction.
		expect(err.message).toContain("top-secret");
	});

	it("accepts an empty classification list", () => {
		expect(() =>
			parseDecisionRequest(request({ context: { dataClassifications: [] } })),
		).not.toThrow();
	});
});

describe("inputHash", () => {
	it("accepts a matching caller-supplied inputHash and rejects a mismatched one", () => {
		const hash = parseDecisionRequest(request()).inputHash;
		expect(parseDecisionRequest(request({ inputHash: hash })).inputHash).toBe(
			hash,
		);
		// A caller that computed the hash itself must not be able to assert a
		// hash the request does not actually have — that is precisely how a
		// decision would be bound to a request it never saw.
		expectRejection(
			() => parseDecisionRequest(request({ inputHash: "sha256:0" })),
			"input-hash-mismatch",
			"$.inputHash",
		);
	});

	it("changes when any bound field changes", () => {
		const base = parseDecisionRequest(request()).inputHash;
		for (const change of [
			{ action: "destroy" },
			{ phase: "plan" },
			{ subject: { kind: "user", id: "u-2" } },
			{ resource: { kind: "camp", id: "camp-2" } },
			{ context: { region: "eu" } },
		]) {
			// Each of these is something a policy decision depends on. A hash that
			// ignored one would let a decision made for `plan` be replayed as
			// evidence for `apply`.
			expect(parseDecisionRequest(request(change)).inputHash).not.toBe(base);
		}
	});

	it("is computed over exactly the six bound fields, ignoring extras", () => {
		const withExtra = hashDecisionRequest({ ...request(), note: "ignored" });
		expect(withExtra).toBe(hashDecisionRequest(request()));
	});

	it("matches an independently computed sha256 of the canonical form", () => {
		// Recomputing the digest from the documented recipe rather than from the
		// implementation: this is what an external verifier would do to check an
		// evidence trail, so it is the property that actually matters.
		const req = request({ context: { b: 2, a: 1 } });
		const expected = createHash("sha256")
			.update(
				canonicalJson({
					schemaVersion: V,
					subject: req.subject,
					action: req.action,
					resource: req.resource,
					phase: req.phase,
					context: { a: 1, b: 2 },
				}),
			)
			.digest("hex");
		expect(hashDecisionRequest(req)).toBe(`sha256:${expected}`);
	});

	it("hashDecisionRequest defaults an absent context to {}", () => {
		const { schemaVersion, subject, action, resource, phase } = request();
		expect(
			hashDecisionRequest({ schemaVersion, subject, action, resource, phase }),
		).toBe(
			hashDecisionRequest({
				schemaVersion,
				subject,
				action,
				resource,
				phase,
				context: {},
			}),
		);
	});

	it("hashDecisionRequest rejects a non-object", () => {
		expectRejection(() => hashDecisionRequest(null), "expected-object", "$");
	});
});

describe("canonicalJson", () => {
	it("sorts object keys at every depth", () => {
		expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe(
			'{"a":3,"b":{"c":2,"d":1}}',
		);
	});

	it("preserves array order, which is semantic", () => {
		// Sorting arrays too would be a plausible-looking "more canonical" change
		// and would destroy meaning: `["read","write"]` is not `["write","read"]`
		// for an ordered obligation list.
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
	});

	it("round-trips through JSON.parse unchanged", () => {
		const value = { z: [1, { b: null, a: true }], a: "s" };
		expect(JSON.parse(canonicalJson(value))).toEqual(value);
	});
});

describe("parseDecision", () => {
	function decision(overrides: Record<string, unknown> = {}) {
		return {
			schemaVersion: V,
			effect: "allow",
			reason: "ok",
			violations: [],
			mutations: [],
			approvals: [],
			obligations: [],
			evidence: {
				policyIds: ["p-1"],
				inputHash: parseDecisionRequest(request()).inputHash,
				engine: "ts",
			},
			...overrides,
		};
	}

	it("parses a full decision", () => {
		const parsed = parseDecision(decision());
		expect(parsed.effect).toBe("allow");
		expect(parsed.evidence.policyIds).toEqual(["p-1"]);
	});

	it("defaults the four list fields to empty arrays", () => {
		const parsed = parseDecision({
			schemaVersion: V,
			effect: "deny",
			reason: "nope",
			evidence: decision().evidence,
		});
		// A decision that omits `violations` means "none", not "unknown". If these
		// stayed undefined, `toWitDecisionRecord` would emit null lists across the
		// component boundary and a guest would have to guess.
		expect(parsed.violations).toEqual([]);
		expect(parsed.mutations).toEqual([]);
		expect(parsed.approvals).toEqual([]);
		expect(parsed.obligations).toEqual([]);
	});

	it("rejects an unknown effect and an empty reason", () => {
		expectRejection(
			() => parseDecision(decision({ effect: "maybe" })),
			"unknown-effect",
			"$.effect",
		);
		// Every decision must say why. A blank reason is what turns an audit log
		// into a list of verdicts nobody can review.
		expectRejection(
			() => parseDecision(decision({ reason: "" })),
			"expected-string",
			"$.reason",
		);
	});

	it("accepts every declared effect", () => {
		for (const effect of EFFECTS) {
			expect(parseDecision(decision({ effect })).effect).toBe(effect);
		}
	});

	it("rejects non-array list fields and canonicalizes their members", () => {
		expectRejection(
			() => parseDecision(decision({ violations: "none" })),
			"expected-array",
			"$.violations",
		);
		expectRejection(
			() => parseDecision(decision({ mutations: [{ v: Number.NaN }] })),
			"invalid-json-number",
			"$.mutations[0].v",
		);
		expect(
			parseDecision(decision({ approvals: [{ b: 1, a: 2 }] })).approvals,
		).toEqual([{ a: 2, b: 1 }]);
	});

	it("requires every obligation to name a kind", () => {
		expect(
			parseDecision(
				decision({ obligations: [{ kind: "redact", field: "ssn" }] }),
			).obligations,
		).toEqual([{ field: "ssn", kind: "redact" }]);
		// An obligation with no kind cannot be dispatched to a handler, so it
		// would be silently dropped at enforcement time — the decision would say
		// "allow with obligations" and nothing would enforce them.
		expectRejection(
			() => parseDecision(decision({ obligations: [{ field: "ssn" }] })),
			"expected-string",
			"$.obligations[0].kind",
		);
		expectRejection(
			() => parseDecision(decision({ obligations: ["redact"] })),
			"expected-object",
			"$.obligations[0]",
		);
		expectRejection(
			() => parseDecision(decision({ obligations: {} })),
			"expected-array",
			"$.obligations",
		);
	});

	it("rejects evidence with a malformed inputHash", () => {
		for (const bad of [
			"sha256:xyz",
			"sha256:ABCDEF",
			"md5:0123",
			`sha256:${"a".repeat(63)}`,
			`sha256:${"a".repeat(65)}`,
		]) {
			// Uppercase hex is rejected too: the hash is compared with `!==`
			// elsewhere, so accepting two spellings of the same digest would make
			// a legitimate request look like a mismatch.
			expectRejection(
				() =>
					parseDecision(
						decision({ evidence: { ...decision().evidence, inputHash: bad } }),
					),
				"invalid-input-hash",
				"$.evidence.inputHash",
			);
		}
	});

	it("rejects evidence missing policyIds or engine", () => {
		expectRejection(
			() =>
				parseDecision(
					decision({
						evidence: {
							inputHash: decision().evidence.inputHash,
							engine: "ts",
						},
					}),
				),
			"expected-array",
			"$.evidence.policyIds",
		);
		// `engine` records *what decided*. Without it a replay cannot tell a
		// rego-lite verdict from a TypeScript one, and the two need not agree.
		expectRejection(
			() =>
				parseDecision(
					decision({
						evidence: {
							policyIds: [],
							inputHash: decision().evidence.inputHash,
						},
					}),
				),
			"expected-string",
			"$.evidence.engine",
		);
		expectRejection(
			() => parseDecision(decision({ evidence: undefined })),
			"expected-object",
			"$.evidence",
		);
	});

	it("binds the decision to a request when one is supplied", () => {
		const other = request({ action: "destroy" });
		expectRejection(
			() => parseDecision(decision(), other),
			"input-hash-mismatch",
			"$.evidence.inputHash",
		);
		// This is the whole point of the module: a decision presented as evidence
		// for a request it did not answer must not parse.
		expect(() => parseDecision(decision(), request())).not.toThrow();
	});

	it("skips the binding check when no request is supplied", () => {
		// Reading a stored decision on its own is legitimate — the hash is still
		// shape-checked, just not compared against anything.
		expect(() => parseDecision(decision())).not.toThrow();
	});

	it("validates the supplied request before comparing hashes", () => {
		expectRejection(
			() => parseDecision(decision(), request({ phase: "nope" })),
			"unknown-phase",
			"$.phase",
		);
	});
});

describe("createDecision", () => {
	it("fills defaults and stamps the request hash into evidence", () => {
		const built = createDecision(request(), {
			effect: "deny",
			reason: "residency",
			evidence: { policyIds: ["p-1"], engine: "ts" },
		});
		expect(built.effect).toBe("deny");
		// The caller never supplies `inputHash` — it is derived, so a decision
		// built this way is bound to its request by construction rather than by
		// the author remembering to copy a digest.
		expect(built.evidence.inputHash).toBe(
			parseDecisionRequest(request()).inputHash,
		);
		expect(built.violations).toEqual([]);
	});

	it("overrides a caller-supplied inputHash rather than trusting it", () => {
		const built = createDecision(request(), {
			effect: "allow",
			reason: "ok",
			evidence: {
				policyIds: [],
				engine: "ts",
				inputHash: `sha256:${"0".repeat(64)}`,
			},
		});
		// The spread puts `inputHash` last deliberately. If it were first, a
		// caller could bind a decision to an arbitrary request.
		expect(built.evidence.inputHash).not.toBe(`sha256:${"0".repeat(64)}`);
	});

	it("defaults policyIds to an empty list", () => {
		expect(
			createDecision(request(), {
				effect: "warn",
				reason: "advisory",
				evidence: { engine: "ts" },
			}).evidence.policyIds,
		).toEqual([]);
	});

	it("lets the caller override the list fields", () => {
		expect(
			createDecision(request(), {
				effect: "deny",
				reason: "r",
				violations: [{ rule: "x" }],
				evidence: { engine: "ts" },
			}).violations,
		).toEqual([{ rule: "x" }]);
	});
});

describe("policy IR documents", () => {
	function document() {
		return {
			request: request(),
			decision: createDecision(request(), {
				effect: "allow",
				reason: "ok",
				evidence: { policyIds: ["p"], engine: "ts" },
			}),
		};
	}

	it("parses a document object and a document string identically", () => {
		const fromObject = parsePolicyIrDocument(document());
		const fromString = parsePolicyIrDocument(JSON.stringify(document()));
		// Documents travel as text on disk and as objects in process; the two
		// paths must agree or a stored trail would verify differently than a live
		// one.
		expect(fromString).toEqual(fromObject);
	});

	it("rejects a document whose decision does not match its request", () => {
		expectRejection(
			() =>
				parsePolicyIrDocument({
					request: request({ action: "destroy" }),
					decision: document().decision,
				}),
			"input-hash-mismatch",
			"$.evidence.inputHash",
		);
	});

	it("rejects a string that is not a JSON object", () => {
		expectRejection(() => parsePolicyIrDocument("[1]"), "expected-object", "$");
		// Malformed JSON is a SyntaxError from `JSON.parse`, not a typed
		// rejection. Pinning it so nobody assumes the typed error covers this.
		expect(() => parsePolicyIrDocument("{")).toThrowError(SyntaxError);
	});

	it("serializes to canonical JSON that re-parses to the same document", () => {
		const text = serializePolicyIrDocument(document());
		expect(text).toBe(canonicalJson(parsePolicyIrDocument(document())));
		expect(parsePolicyIrDocument(text)).toEqual(
			parsePolicyIrDocument(document()),
		);
		// Serialization must be stable: two runs producing different bytes for
		// the same document would break content-addressed evidence storage.
		expect(serializePolicyIrDocument(document())).toBe(text);
	});
});

describe("migratePolicyIrDocument", () => {
	it("passes a current-version request through the parser unchanged", () => {
		expect(migratePolicyIrDocument(request())).toEqual(
			parseDecisionRequest(request()),
		);
	});

	it("lifts a v0 flat request into the current nested shape", () => {
		const migrated = migratePolicyIrDocument({
			schemaVersion: "hobo.policy-ir/v0",
			subjectKind: "service",
			subjectId: "svc-1",
			action: "read",
			resourceKind: "bucket",
			resourceId: "b-1",
			lifecycle: "runtime",
			context: { region: "eu" },
		});
		// `lifecycle` was renamed to `phase`; a migration that forgot the rename
		// would produce a request that fails `unknown-phase` at the far end, long
		// after the stored document was accepted.
		expect(migrated.phase).toBe("runtime");
		expect(migrated.subject).toEqual({ kind: "service", id: "svc-1" });
		expect(migrated.resource).toEqual({ kind: "bucket", id: "b-1" });
		expect(migrated.context).toEqual({ region: "eu" });
		expect(migrated.schemaVersion).toBe(V);
	});

	it("defaults an absent v0 context to an empty object", () => {
		expect(
			migratePolicyIrDocument({
				schemaVersion: "hobo.policy-ir/v0",
				subjectKind: "user",
				subjectId: "u",
				action: "a",
				resourceKind: "camp",
				resourceId: "c",
				lifecycle: "apply",
			}).context,
		).toEqual({});
	});

	it("validates the migrated result rather than trusting the old document", () => {
		// v0 documents were written by an older validator; re-running the current
		// one is what stops a stale vocabulary member from re-entering the system.
		expectRejection(
			() =>
				migratePolicyIrDocument({
					schemaVersion: "hobo.policy-ir/v0",
					subjectKind: "robot",
					subjectId: "r",
					action: "a",
					resourceKind: "camp",
					resourceId: "c",
					lifecycle: "apply",
				}),
			"unknown-subject-kind",
			"$.subject.kind",
		);
		expectRejection(
			() =>
				migratePolicyIrDocument({
					schemaVersion: "hobo.policy-ir/v0",
					subjectKind: "user",
					subjectId: "u",
					action: "a",
					resourceKind: "camp",
					resourceId: "c",
					lifecycle: "deploy",
				}),
			"unknown-phase",
			"$.phase",
		);
	});

	it("refuses a version it does not know how to migrate", () => {
		const err = expectRejection(
			() => migratePolicyIrDocument({ schemaVersion: "hobo.policy-ir/v2" }),
			"unsupported-version",
			"$.schemaVersion",
		);
		// The message names the version so an operator can tell "too old" from
		// "from the future" — the remediation differs.
		expect(err.message).toContain("hobo.policy-ir/v2");
		expectRejection(
			() => migratePolicyIrDocument({}),
			"unsupported-version",
			"$.schemaVersion",
		);
	});

	it("rejects a non-object document", () => {
		expectRejection(() => migratePolicyIrDocument(7), "expected-object", "$");
	});
});

describe("createPolicyDecidedEvent", () => {
	const decisionInput = () =>
		createDecision(request(), {
			effect: "allow",
			reason: "ok",
			evidence: { policyIds: ["p"], engine: "ts" },
		});

	it("projects request fields onto the event envelope and the decision into data", () => {
		const event = createPolicyDecidedEvent({
			request: request(),
			decision: decisionInput(),
		});
		// Subject/action/resource/phase are lifted out of `data` so a stream can
		// be filtered without deserializing every decision body.
		expect(event.type).toBe(POLICY_DECIDED_EVENT_TYPE);
		expect(event.schemaVersion).toBe(V);
		expect(event.subject).toEqual({ kind: "user", id: "u-1" });
		expect(event.action).toBe("deploy");
		expect(event.resource).toEqual({ kind: "camp", id: "camp-1" });
		expect(event.phase).toBe("apply");
		expect(event.data.effect).toBe("allow");
	});

	it("derives a deterministic id from the input hash", () => {
		const event = createPolicyDecidedEvent({
			request: request(),
			decision: decisionInput(),
		});
		const hash = parseDecisionRequest(request()).inputHash;
		// Pinning the exact slice: `slice("sha256:".length, 18)` uses 18 as an
		// absolute end index, not a length, so the id carries 11 hex characters
		// rather than the 18 the shape suggests. That is enough to be stable and
		// is what any stored event already uses, so this test records the real
		// width — widening it later would change every derived id.
		expect(event.id).toBe(`policy-decided-${hash.slice(7, 18)}`);
		expect(event.id).toHaveLength("policy-decided-".length + 11);
		expect(
			createPolicyDecidedEvent({
				request: request(),
				decision: decisionInput(),
			}).id,
		).toBe(event.id);
	});

	it("honours an explicit id", () => {
		expect(
			createPolicyDecidedEvent({
				request: request(),
				decision: decisionInput(),
				id: "evt-1",
			}).id,
		).toBe("evt-1");
	});

	it("refuses to emit an event whose decision answers a different request", () => {
		// `policy.Decided` is a terminal, never-retried event. Emitting one that
		// cites the wrong request would poison the audit stream permanently.
		expectRejection(
			() =>
				createPolicyDecidedEvent({
					request: request({ action: "destroy" }),
					decision: decisionInput(),
				}),
			"input-hash-mismatch",
			"$.evidence.inputHash",
		);
	});
});

describe("WIT record interop", () => {
	const built = () =>
		createDecision(request(), {
			effect: "require-approval",
			reason: "needs a human",
			obligations: [{ kind: "notify", channel: "ops" }],
			evidence: { policyIds: ["p-1"], engine: "rego-lite" },
		});

	it("converts to snake_case component fields", () => {
		const record = toWitDecisionRecord(built());
		// The WIT world uses snake_case; a stray camelCase field would simply be
		// absent on the guest side rather than failing loudly.
		expect(record.schema_version).toBe(V);
		expect(record.effect).toBe("require-approval");
		expect(record.evidence.policy_ids).toEqual(["p-1"]);
		expect(record.evidence.input_hash).toMatch(/^sha256:/u);
		expect(record.evidence.engine).toBe("rego-lite");
		expect(Object.hasOwn(record.evidence, "policyIds")).toBe(false);
	});

	it("round-trips through the component boundary without loss", () => {
		const original = built();
		const restored = fromWitDecisionRecord(toWitDecisionRecord(original));
		// This is the property that matters: a decision made in a guest component
		// and a decision made in-process must be the same evidence.
		expect(restored).toEqual(original);
	});

	it("re-checks the request binding on the way in and on the way out", () => {
		const record = toWitDecisionRecord(built());
		// A guest is untrusted: a component that returned a decision citing some
		// other request must be rejected at the boundary, not stored.
		expectRejection(
			() => fromWitDecisionRecord(record, request({ action: "destroy" })),
			"input-hash-mismatch",
			"$.evidence.inputHash",
		);
		expect(() => fromWitDecisionRecord(record, request())).not.toThrow();
		expectRejection(
			() => toWitDecisionRecord(built(), request({ phase: "plan" })),
			"input-hash-mismatch",
			"$.evidence.inputHash",
		);
	});

	it("rejects a record that is not an object or has no evidence", () => {
		expectRejection(() => fromWitDecisionRecord(null), "expected-object", "$");
		expectRejection(
			() => fromWitDecisionRecord({ schema_version: V, effect: "allow" }),
			"expected-object",
			"$.evidence",
		);
	});

	it("rejects a guest record with an unknown effect", () => {
		const record = toWitDecisionRecord(built());
		expectRejection(
			() => fromWitDecisionRecord({ ...record, effect: "allow-always" }),
			"unknown-effect",
			"$.effect",
		);
	});
});
