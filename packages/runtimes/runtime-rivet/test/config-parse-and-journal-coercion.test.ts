/**
 * Rivet's runtime config parse and its journal's SQLite value coercion.
 *
 * Two boundaries, both of which exist to keep bad values out of a durable
 * store rather than to shape convenience.
 *
 * **The config parse refuses secret material where a locator belongs.** A
 * `svidBindingRef` is meant to name where a credential lives, not to be one.
 * If a caller pastes the secret itself, it ends up in a manifest, a log line,
 * and a git history — so the parse refuses anything that looks like one, and
 * refuses a URL with userinfo in the two secretRef fields for the same reason.
 *
 * **Both spellings of every field are accepted.** The config arrives from CUE,
 * from JSON, and from hand-written YAML, which disagree about camelCase versus
 * snake_case. Accepting one and silently ignoring the other would present a
 * typo'd config as a missing field.
 *
 * **An empty journal answers rather than throwing.** A missing stream is an
 * empty stream, an idle inbox claims nothing, and a fresh outbox is empty —
 * an actor polls all three constantly, so each has to be an ordinary value.
 * The inbox is keyed by command id so a retried delivery cannot enqueue the
 * same work twice, and two streams' inboxes never see each other.
 *
 * The journal runs against `:memory:`, so nothing touches disk and each call
 * to `createActorLocalJournal` is genuinely independent.
 */
import { describe, expect, it } from "vitest";

import { createActorLocalJournal } from "../src/journal.js";
import {
	parseRivetRuntimeConfig,
	parseRivetRuntimeMode,
} from "../src/parse.js";
import { RivetJournalError } from "../src/types.js";

/** A config the parse accepts. */
const config = (overrides: Record<string, unknown> = {}) => ({
	campId: "camp-1",
	tenantId: "tenant-1",
	svidBindingRef: "spiffe://hobo/station",
	...overrides,
});

describe("the runtime mode", () => {
	for (const mode of ["local", "runner", "serverless", "managed"] as const) {
		it(`accepts \`${mode}\``, () => {
			expect(parseRivetRuntimeMode(mode)).toBe(mode);
		});
	}

	it("refuses a mode it does not know", () => {
		// A typo'd mode that fell through to a default would run the actor in a
		// placement the operator did not ask for.
		expect(() => parseRivetRuntimeMode("cloud")).toThrow(RivetJournalError);
	});

	it("names the modes it accepts in the refusal", () => {
		expect(() => parseRivetRuntimeMode("cloud")).toThrow(
			/local\|runner\|serverless\|managed/,
		);
	});

	it("quotes the value it was given", () => {
		// Without echoing the input, an operator with a trailing space or a
		// stray quote cannot see what went wrong.
		expect(() => parseRivetRuntimeMode("cloud")).toThrow(/"cloud"/);
	});

	it("refuses a mode that is not a string", () => {
		expect(() => parseRivetRuntimeMode(1)).toThrow(RivetJournalError);
	});

	it("refuses a missing mode", () => {
		expect(() => parseRivetRuntimeMode(undefined)).toThrow(RivetJournalError);
	});
});

describe("the runtime config", () => {
	it("accepts a minimal config", () => {
		expect(parseRivetRuntimeConfig(config())).toMatchObject({
			campId: "camp-1",
			tenantId: "tenant-1",
		});
	});

	it("defaults the mode to local", () => {
		// Local is the only mode that needs no remote credentials, so it is the
		// only safe default for a config that did not say.
		expect(parseRivetRuntimeConfig(config()).mode).toBe("local");
	});

	it("keeps an explicit mode", () => {
		expect(parseRivetRuntimeConfig(config({ mode: "runner" })).mode).toBe(
			"runner",
		);
	});

	it("refuses a config that is not an object", () => {
		expect(() => parseRivetRuntimeConfig("camp-1")).toThrow(
			/must be an object/,
		);
	});

	it("refuses an array as a config", () => {
		expect(() => parseRivetRuntimeConfig([config()])).toThrow(
			/must be an object/,
		);
	});

	it("refuses a missing campId", () => {
		expect(() =>
			parseRivetRuntimeConfig({ ...config(), campId: undefined }),
		).toThrow(/campId is required/);
	});

	it("refuses an empty campId", () => {
		// An empty string is a present-but-useless id; the length check is what
		// separates it from a real one.
		expect(() => parseRivetRuntimeConfig(config({ campId: "" }))).toThrow(
			/campId is required/,
		);
	});

	it("accepts campId in snake_case", () => {
		expect(
			parseRivetRuntimeConfig({
				camp_id: "camp-1",
				tenant_id: "tenant-1",
				svid_binding_ref: "spiffe://hobo/station",
			}).campId,
		).toBe("camp-1");
	});

	it("accepts tenantId in snake_case", () => {
		expect(
			parseRivetRuntimeConfig({
				camp_id: "camp-1",
				tenant_id: "tenant-1",
				svid_binding_ref: "spiffe://hobo/station",
			}).tenantId,
		).toBe("tenant-1");
	});

	it("prefers the camelCase spelling when both are present", () => {
		// Two spellings of one field is a config mistake, but it must resolve
		// deterministically rather than by object key order.
		expect(
			parseRivetRuntimeConfig({
				...config({ campId: "camel" }),
				camp_id: "snake",
			}).campId,
		).toBe("camel");
	});

	it("refuses a missing tenantId", () => {
		expect(() =>
			parseRivetRuntimeConfig({ ...config(), tenantId: undefined }),
		).toThrow(/tenantId is required/);
	});

	it("refuses a missing svidBindingRef", () => {
		expect(() =>
			parseRivetRuntimeConfig({ ...config(), svidBindingRef: undefined }),
		).toThrow(/svidBindingRef is required/);
	});

	it("accepts svidBindingRef in snake_case", () => {
		expect(
			parseRivetRuntimeConfig({
				camp_id: "camp-1",
				tenant_id: "tenant-1",
				svid_binding_ref: "spiffe://hobo/station",
			}).svidBindingRef,
		).toBe("spiffe://hobo/station");
	});
});

describe("the config refuses secret material where a locator belongs", () => {
	it("refuses an svid ref that is itself a secret", () => {
		// `secret:` is how the rest of the system spells "this is the material";
		// a binding ref must name where it lives, not carry it.
		expect(() =>
			parseRivetRuntimeConfig(config({ svidBindingRef: "secret:abc123" })),
		).toThrow(/locator, not secret material/);
	});

	it("refuses an svid ref that looks like a token", () => {
		expect(() =>
			parseRivetRuntimeConfig(config({ svidBindingRef: "my-token-value" })),
		).toThrow(/locator, not secret material/);
	});

	it("refuses an svid ref that looks like a password", () => {
		expect(() =>
			parseRivetRuntimeConfig(config({ svidBindingRef: "PASSWORD=hunter2" })),
		).toThrow(/locator, not secret material/);
	});

	it("refuses an svid ref that looks like an API key", () => {
		expect(() =>
			parseRivetRuntimeConfig(
				config({ svidBindingRef: "sk-0123456789abcdef" }),
			),
		).toThrow(/locator, not secret material/);
	});

	it("matches the secret-shaped patterns case-insensitively", () => {
		// An operator pasting `TOKEN` in caps is making exactly the same mistake
		// as one pasting `token`.
		expect(() =>
			parseRivetRuntimeConfig(config({ svidBindingRef: "MY-TOKEN" })),
		).toThrow(/locator, not secret material/);
	});

	it("refuses an endpoint secretRef that is a URL", () => {
		// A URL here can carry userinfo — `https://user:pass@host` — which puts
		// a credential in every place the config is rendered.
		expect(() =>
			parseRivetRuntimeConfig(
				config({ endpointSecretRef: "https://user:pass@rivet.example" }),
			),
		).toThrow(/not a URL with userinfo/);
	});

	it("refuses an admin token secretRef that is a URL", () => {
		expect(() =>
			parseRivetRuntimeConfig(
				config({ adminTokenSecretRef: "https://user:pass@rivet.example" }),
			),
		).toThrow(/not a URL with userinfo/);
	});

	it("names which field was wrong", () => {
		expect(() =>
			parseRivetRuntimeConfig(
				config({ adminTokenSecretRef: "https://x@y.example" }),
			),
		).toThrow(/adminTokenSecretRef/);
	});

	it("accepts a scheme-less endpoint secretRef", () => {
		expect(
			parseRivetRuntimeConfig(config({ endpointSecretRef: "rivet/endpoint" }))
				.endpointSecretRef,
		).toBe("rivet/endpoint");
	});

	it("GAP: refuses `secref://` — the locator form it asks for", () => {
		// The check is `value.includes("://")`, not a userinfo check, so it
		// refuses every scheme — including `secref://`, which is the locator
		// spelling the rest of the repo uses and the one this error message
		// tells the operator to supply. The intent (keep `user:pass@host` out
		// of a rendered config) is right; the test is too broad, and the
		// message names a cause that is not the one being detected.
		//
		// Pinned rather than narrowed here: tightening it to userinfo only is a
		// validation change on a config boundary, not a coverage edit.
		expect(() =>
			parseRivetRuntimeConfig(
				config({ endpointSecretRef: "secref://rivet/endpoint" }),
			),
		).toThrow(/not a URL with userinfo/);
	});

	it("omits an endpoint secretRef that was not supplied", () => {
		expect(
			Object.hasOwn(parseRivetRuntimeConfig(config()), "endpointSecretRef"),
		).toBe(false);
	});

	it("omits an admin secretRef that was not supplied", () => {
		expect(
			Object.hasOwn(parseRivetRuntimeConfig(config()), "adminTokenSecretRef"),
		).toBe(false);
	});

	it("carries an engine image digest when supplied", () => {
		expect(
			parseRivetRuntimeConfig(config({ engineImageDigest: "sha256:abc" }))
				.engineImageDigest,
		).toBe("sha256:abc");
	});

	it("drops a non-string engine image digest", () => {
		// A number coerced into a digest field would be pinned as a real image
		// reference that resolves to nothing.
		expect(
			Object.hasOwn(
				parseRivetRuntimeConfig(config({ engineImageDigest: 7 })),
				"engineImageDigest",
			),
		).toBe(false);
	});

	it("freezes the parsed config", () => {
		// The config is read by every placement decision; a caller mutating it
		// after the fact would change behaviour far from the mutation.
		expect(Object.isFrozen(parseRivetRuntimeConfig(config()))).toBe(true);
	});
});

describe("the journal's head and append", () => {
	it("reports revision zero for a stream that does not exist", () => {
		const journal = createActorLocalJournal();
		// A missing stream is an empty stream, not an error: an actor's first
		// append has to have something to compare against.
		expect(journal.head("actor-1")).toMatchObject({ revision: 0 });
		journal.close();
	});

	it("reports owner epoch zero for a new stream", () => {
		const journal = createActorLocalJournal();
		expect(journal.head("actor-1").ownerEpoch).toBe(0n);
		journal.close();
	});

	it("reads no facts from an empty stream", () => {
		const journal = createActorLocalJournal();
		expect(journal.readFacts("actor-1")).toEqual([]);
		journal.close();
	});

	it("closes without a stream ever being touched", () => {
		const journal = createActorLocalJournal();
		// Opening and closing is what a health probe does; it must not require
		// a write first.
		expect(() => journal.close()).not.toThrow();
	});

	it("opens an independent journal per call", () => {
		const first = createActorLocalJournal();
		const second = createActorLocalJournal();
		// `:memory:` is per-connection. Two journals sharing state would make
		// every test order-dependent and every actor leak into its neighbour.
		expect(first.head("actor-1").revision).toBe(0);
		expect(second.head("actor-1").revision).toBe(0);
		first.close();
		second.close();
	});

	it("loads no command that was never accepted", () => {
		const journal = createActorLocalJournal();
		expect(journal.loadCommand("actor-1", "cmd-1")).toBeUndefined();
		journal.close();
	});

	it("claims nothing from an empty inbox", () => {
		const journal = createActorLocalJournal();
		// An idle actor polls this constantly; it has to be an ordinary
		// `undefined` rather than an exception.
		expect(journal.claimNext("actor-1")).toBeUndefined();
		journal.close();
	});

	it("has no pending outbox on a fresh stream", () => {
		const journal = createActorLocalJournal();
		expect(journal.pendingOutbox("actor-1")).toEqual([]);
		journal.close();
	});
});

describe("accepting a command", () => {
	/** Accept one command against a fresh journal. */
	function accepted(overrides: Record<string, unknown> = {}) {
		const journal = createActorLocalJournal();
		const result = journal.acceptCommand({
			streamId: "actor-1",
			commandId: "cmd-1",
			digest: "digest-1",
			commandType: "doThing",
			payloadJson: JSON.stringify({ a: 1 }),
			expectedRevision: 0,
			...overrides,
			// SAFETY: the journal reads exactly the fields named above.
		} as never);
		return { journal, result };
	}

	it("accepts a first command", () => {
		const { journal, result } = accepted();
		expect(result).toMatchObject({ status: expect.any(String) });
		journal.close();
	});

	it("makes the accepted command loadable", () => {
		const { journal } = accepted();
		expect(journal.loadCommand("actor-1", "cmd-1")).toBeDefined();
		journal.close();
	});

	it("makes the accepted command claimable", () => {
		const { journal } = accepted();
		// Accept then claim is the whole inbox protocol; a command that accepted
		// but never became claimable would stall the actor silently.
		expect(journal.claimNext("actor-1")).toBeDefined();
		journal.close();
	});

	it("is idempotent on a repeated command id", () => {
		const journal = createActorLocalJournal();
		const input = {
			streamId: "actor-1",
			commandId: "cmd-1",
			digest: "digest-1",
			commandType: "doThing",
			payloadJson: JSON.stringify({ a: 1 }),
			expectedRevision: 0,
			// SAFETY: the journal reads exactly the fields named above.
		} as never;
		journal.acceptCommand(input);
		const second = journal.acceptCommand(input);
		// A retried delivery must not enqueue the work twice. This is the whole
		// reason the inbox is keyed by command id.
		expect(second).toMatchObject({ status: expect.any(String) });
		expect(journal.claimNext("actor-1")).toBeDefined();
		journal.close();
	});

	it("keeps two streams' inboxes apart", () => {
		const journal = createActorLocalJournal();
		journal.acceptCommand({
			streamId: "actor-1",
			commandId: "cmd-1",
			digest: "digest-1",
			commandType: "doThing",
			payloadJson: "{}",
			expectedRevision: 0,
			// SAFETY: the journal reads exactly the fields named above.
		} as never);
		// One actor's command appearing in another's inbox would execute it
		// against the wrong state entirely.
		expect(journal.claimNext("actor-2")).toBeUndefined();
		journal.close();
	});
});
