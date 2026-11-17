import { readFileSync } from "node:fs";
import { AlchemyIacError } from "@hobo/iac-alchemy";
import * as Effect from "effect/Effect";
import { setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import {
	bindRivetDurableTopicSource,
	createRivetDurableTopicActor,
} from "../../src/index.js";

const pact = JSON.parse(
	readFileSync(
		new URL("../pacts/topic-source.pact.json", import.meta.url),
		"utf8",
	),
);

describe("topic source composition provider contract", () => {
	for (const interaction of pact.interactions) {
		it(interaction.description, () => {
			const sourceDigest = `sha256:${"a".repeat(64)}`;
			const environmentDigest = `sha256:${"d".repeat(64)}`;
			const binding = createRivetDurableTopicActor({
				actorName: "events",
				semanticDigest: environmentDigest,
				now: () => 1000,
				resolveScope: () => ({ tenant: "tenant", instance: "instance" }),
				authorize: () => true,
				verifyIngress: () => true,
			});
			const registry = setup({
				use: { events: binding.actor },
				noWelcome: true,
			});
			const source = {
				main: "/src/events-main.ts",
				resourceName: "events",
				bindleName: "events-app",
				sourceDigest,
				sourceFence: {
					sourceDigest,
					environmentDigest,
					proofRef: "host:topic-source",
					verify: () => true,
				},
				poolDigest: `sha256:${"b".repeat(64)}`,
				isolationDigest: `sha256:${"c".repeat(64)}`,
				poolHost: {
					deployExternal: () => Effect.void,
					deployCrate: () => Effect.void,
				},
				registry,
				binding:
					interaction.request.body.binding === "copy"
						? { ...binding }
						: binding,
				verifySource: () => true,
			};
			const actual = (() => {
				try {
					const accepted = bindRivetDurableTopicSource(source);
					return {
						status: 200,
						body: { accepted: true, actorName: accepted.binding.actorName },
					};
				} catch (error) {
					if (!(error instanceof AlchemyIacError)) throw error;
					return { status: 409, body: { accepted: false, code: error.code } };
				}
			})();
			expect(actual).toEqual(interaction.response);
		});
	}
});
