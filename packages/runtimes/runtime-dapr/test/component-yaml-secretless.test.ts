/**
 * Dapr component YAML, and the secret it must never carry.
 *
 * A Dapr Component CR is applied to a cluster and readable by anyone with
 * `get component` on the namespace. HoBo's rule is that credentials never
 * appear in one: metadata carries *binding references* — `fromBinding:...`,
 * an OIDC auth type — and the platform resolves them at runtime. That is the
 * secretless-first property, and this module is where it is enforced.
 *
 * So the refusal is the headline:
 *
 * **A metadata key that names a credential is refused, not redacted.** Six
 * key names are forbidden outright — `password`, `saslPassword`,
 * `clientSecret`, `accessKey`, `secretKey`, `apiKey`. Redacting instead would
 * emit a component that looks configured and cannot authenticate; dropping the
 * key silently would do the same. Refusing at parse time means the operator
 * finds out while writing the bindle rather than after an apply.
 *
 * The rest is about the generated document being one a cluster will accept:
 *
 * **A component with no name or no type is refused.** Both are required by
 * the CR schema, and emitting YAML the apiserver rejects moves the failure
 * from a bindle the author is editing to a deploy they are watching.
 *
 * **An empty metadata map still emits valid YAML.** `metadata:` with nothing
 * under it is a parse error in YAML; `[]` is an empty list. A component with
 * no metadata is ordinary, so the empty case has to be the one that works.
 *
 * **Scopes are omitted entirely when there are none.** An empty `scopes:` key
 * is not the same as an absent one to Dapr — the first scopes the component to
 * no apps at all.
 */
import { MessagingParseError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	generateDaprComponentYaml,
	kafkaPubsubComponent,
	parseDaprComponentSpec,
	scopesFromAllow,
} from "../src/components.js";

const spec = (overrides: Record<string, unknown> = {}) =>
	parseDaprComponentSpec({
		name: "pubsub",
		type: "pubsub.kafka",
		metadata: { brokers: "fromBinding:kafka" },
		...overrides,
	});

describe("credentials the spec refuses", () => {
	for (const key of [
		"password",
		"saslPassword",
		"clientSecret",
		"accessKey",
		"secretKey",
		"apiKey",
	]) {
		it(`refuses \`${key}\` in metadata`, () => {
			// The CR is readable by anyone with `get component` on the
			// namespace. Redacting would emit a component that looks configured
			// and cannot authenticate; dropping it silently would do the same.
			expect(() =>
				parseDaprComponentSpec({
					name: "pubsub",
					type: "pubsub.kafka",
					metadata: { [key]: "hunter2" },
				}),
			).toThrow(MessagingParseError);
		});
	}

	it("names the offending key in the refusal", () => {
		// An operator with a dozen metadata entries needs to be told which one,
		// not that "metadata" was wrong.
		expect(() =>
			parseDaprComponentSpec({
				name: "pubsub",
				type: "pubsub.kafka",
				metadata: { brokers: "fromBinding:kafka", apiKey: "abc" },
			}),
		).toThrow(/metadata\.apiKey/);
	});

	it("says a binding ref is what belongs there", () => {
		// The refusal has to point at the remedy; "invalid metadata" leaves the
		// author to guess that a `fromBinding:` ref is the supported form.
		expect(() =>
			parseDaprComponentSpec({
				name: "pubsub",
				type: "pubsub.kafka",
				metadata: { password: "hunter2" },
			}),
		).toThrow(/secretless/);
	});

	it("refuses even an empty credential value", () => {
		// The key name is the signal, not the value. An empty password today is
		// a real one after the next edit.
		expect(() =>
			parseDaprComponentSpec({
				name: "pubsub",
				type: "pubsub.kafka",
				metadata: { password: "" },
			}),
		).toThrow(MessagingParseError);
	});

	it("accepts a binding ref under a non-credential key", () => {
		// The rule is about key names that mean "secret", not about the shape
		// of the value — otherwise every legitimate binding would be suspect.
		expect(
			spec({ metadata: { clientAuthBinding: "fromBinding:kafka-client" } })
				.metadata,
		).toStrictEqual({ clientAuthBinding: "fromBinding:kafka-client" });
	});

	it("is case-sensitive on the forbidden names", () => {
		// GAP: `Password` and `APIKEY` pass, because the check is an exact
		// `includes` on the key. Dapr metadata keys are case-sensitive and the
		// real component fields use these exact spellings, so this is not a
		// bypass of a working component — but a differently-cased key would
		// carry a secret into the CR. Pinned rather than fixed: widening the
		// match risks refusing legitimate keys that merely contain these
		// substrings, and choosing the rule is a policy decision.
		expect(() => spec({ metadata: { Password: "hunter2" } })).not.toThrow();
	});
});

describe("parsing a spec", () => {
	it("refuses input that is not an object", () => {
		for (const input of [null, "pubsub", 1, []]) {
			expect(() => parseDaprComponentSpec(input)).toThrow(MessagingParseError);
		}
	});

	it("defaults the version to v1", () => {
		// Every Dapr component CR in use is v1; requiring it in every bindle
		// would be noise with one correct answer.
		expect(spec().version).toBe("v1");
	});

	it("keeps an explicit version", () => {
		expect(spec({ version: "v2" }).version).toBe("v2");
	});

	it("defaults an absent name and type to empty, leaving the yaml step to refuse", () => {
		// Parsing normalizes; generating validates. Splitting it this way lets a
		// caller build a spec incrementally and still be refused before it
		// reaches a cluster.
		const parsed = parseDaprComponentSpec({});
		expect([parsed.name, parsed.type]).toStrictEqual(["", ""]);
	});

	it("stringifies metadata values", () => {
		// Dapr metadata values are strings on the wire. A number left as a
		// number would serialise unquoted and change type on the way in.
		expect(
			spec({ metadata: { maxRetries: 5, enabled: true } }).metadata,
		).toStrictEqual({ maxRetries: "5", enabled: "true" });
	});

	it("ignores metadata that is not an object", () => {
		// An array or a scalar has no entries to carry; treating it as empty is
		// the same outcome as omitting it, which is what the author meant.
		expect(spec({ metadata: ["brokers"] }).metadata).toStrictEqual({});
	});

	it("stringifies scopes", () => {
		expect(spec({ scopes: ["app-a", 2] }).scopes).toStrictEqual(["app-a", "2"]);
	});

	it("ignores scopes that are not an array", () => {
		expect(spec({ scopes: "app-a" }).scopes).toStrictEqual([]);
	});

	it("freezes the parsed spec", () => {
		// It is the input to YAML generation and to the secretless claim; a
		// caller that could add a `password` after parsing would defeat the
		// check entirely.
		expect(Object.isFrozen(spec())).toBe(true);
	});
});

describe("generating the CR", () => {
	it("refuses a component with no name", () => {
		// Required by the CR schema. Emitting YAML the apiserver rejects moves
		// the failure from a bindle the author is editing to a deploy they are
		// watching.
		expect(() => generateDaprComponentYaml(spec({ name: "" }))).toThrow(
			MessagingParseError,
		);
	});

	it("refuses a component with no type", () => {
		expect(() => generateDaprComponentYaml(spec({ type: "" }))).toThrow(
			MessagingParseError,
		);
	});

	it("emits the component's name and type", () => {
		const yaml = generateDaprComponentYaml(spec()).body;
		expect(yaml).toContain("name: pubsub");
		expect(yaml).toContain("type: pubsub.kafka");
	});

	it("emits each metadata entry as a quoted name/value pair", () => {
		// Quoted because a binding ref contains a colon, which is YAML's
		// key/value separator — unquoted it would parse as a nested map.
		expect(generateDaprComponentYaml(spec()).body).toContain(
			'- name: brokers\n      value: "fromBinding:kafka"',
		);
	});

	it("emits an empty list when there is no metadata", () => {
		// `metadata:` with nothing under it is a YAML parse error; `[]` is an
		// empty list. A component with no metadata is ordinary.
		expect(generateDaprComponentYaml(spec({ metadata: {} })).body).toContain(
			"metadata:\n    []",
		);
	});

	it("omits scopes entirely when there are none", () => {
		// An empty `scopes:` key is not the same as an absent one — the first
		// scopes the component to no apps at all.
		expect(generateDaprComponentYaml(spec()).body).not.toContain("scopes:");
	});

	it("emits each scope as a list item when there are some", () => {
		expect(
			generateDaprComponentYaml(spec({ scopes: ["app-a", "app-b"] })).body,
		).toContain("scopes:\n  - app-a\n  - app-b");
	});

	it("ends with exactly one newline", () => {
		// Applied by `kubectl apply -f -`; a document with trailing blank lines
		// or none at all is accepted by some tools and not others.
		const body = generateDaprComponentYaml(spec()).body;
		expect(body.endsWith("\n")).toBe(true);
		expect(body.endsWith("\n\n")).toBe(false);
	});

	it("declares itself secretless", () => {
		// The flag is what a report reads to claim the property; it is only
		// sound because the parse step refuses credentials.
		expect(generateDaprComponentYaml(spec()).secretless).toBe(true);
	});

	it("is frozen", () => {
		expect(Object.isFrozen(generateDaprComponentYaml(spec()))).toBe(true);
	});
});

describe("the Kafka pubsub component", () => {
	it("carries the broker binding rather than a broker list", () => {
		expect(
			kafkaPubsubComponent({ bootstrapServersBinding: "fromBinding:kafka" })
				.metadata.brokers,
		).toBe("fromBinding:kafka");
	});

	it("uses OIDC rather than a SASL password", () => {
		// The whole reason this helper exists: the obvious Kafka config carries
		// `saslPassword`, which the parse step would refuse.
		expect(
			kafkaPubsubComponent({ bootstrapServersBinding: "fromBinding:kafka" })
				.metadata.authType,
		).toBe("oidc");
	});

	it("points client auth material at a binding", () => {
		expect(
			kafkaPubsubComponent({ bootstrapServersBinding: "fromBinding:kafka" })
				.metadata.clientAuthBinding,
		).toBe("fromBinding:kafka-client");
	});

	it("defaults the component name and consumer group", () => {
		const component = kafkaPubsubComponent({
			bootstrapServersBinding: "fromBinding:kafka",
		});
		expect([component.name, component.metadata.consumerGroup]).toStrictEqual([
			"pubsub",
			"hobo",
		]);
	});

	it("keeps an explicit name and consumer group", () => {
		const component = kafkaPubsubComponent({
			name: "events",
			bootstrapServersBinding: "fromBinding:kafka",
			consumerGroup: "orders",
		});
		expect([component.name, component.metadata.consumerGroup]).toStrictEqual([
			"events",
			"orders",
		]);
	});

	it("defaults to no scopes", () => {
		expect(
			kafkaPubsubComponent({ bootstrapServersBinding: "fromBinding:kafka" })
				.scopes,
		).toStrictEqual([]);
	});

	it("keeps the scopes it was given", () => {
		expect(
			kafkaPubsubComponent({
				bootstrapServersBinding: "fromBinding:kafka",
				scopes: ["app-a"],
			}).scopes,
		).toStrictEqual(["app-a"]);
	});

	it("generates YAML a cluster would accept", () => {
		expect(() =>
			generateDaprComponentYaml(
				kafkaPubsubComponent({ bootstrapServersBinding: "fromBinding:kafka" }),
			),
		).not.toThrow();
	});
});

describe("scopes from allow verbs", () => {
	it("scopes the component to the app id", () => {
		// Dapr scopes are app-ids. The verbs from `.allow()` constrain link
		// grants inside HoBo policy and have no Dapr equivalent, so mapping
		// them onto scopes would invent a restriction Dapr does not enforce.
		expect(scopesFromAllow("tenant-a", ["publish", "subscribe"])).toStrictEqual(
			["tenant-a"],
		);
	});

	it("ignores the verbs entirely", () => {
		expect(scopesFromAllow("tenant-a", [])).toStrictEqual(
			scopesFromAllow("tenant-a", ["publish"]),
		);
	});
});
