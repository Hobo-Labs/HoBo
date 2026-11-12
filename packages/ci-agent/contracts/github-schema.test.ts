import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import {
	BASE_PROTECTION_QUERY,
	COMMENT_MUTATION,
	COMMIT_CHECKS_QUERY,
	DEFAULT_BRANCH_QUERY,
	ENQUEUE_MUTATION,
	SNAPSHOT_QUERY,
} from "../src/github-queue.js";

// GitHub's published GraphQL schema, vendored by `pnpm contracts:github-schema`
// from https://docs.github.com/public/fpt/schema.docs.graphql.
const schema = buildSchema(
	gunzipSync(
		readFileSync(new URL("./github-schema.graphql.gz", import.meta.url)),
	).toString("utf8"),
);

describe("GitHub GraphQL operations against GitHub's published schema", () => {
	it.each([
		["HoboAgentQueue", SNAPSHOT_QUERY],
		["HoboAgentEnqueue", ENQUEUE_MUTATION],
		["HoboAgentComment", COMMENT_MUTATION],
		["HoboAgentDefaultBranch", DEFAULT_BRANCH_QUERY],
		["HoboAgentBaseProtection", BASE_PROTECTION_QUERY],
		["HoboAgentCommitChecks", COMMIT_CHECKS_QUERY],
	])("%s is a valid operation", (name, operation) => {
		const document = parse(operation);
		expect(validate(schema, document).map((error) => error.message)).toEqual(
			[],
		);
		expect(
			document.definitions.flatMap((definition) =>
				definition.kind === "OperationDefinition"
					? [definition.name?.value]
					: [],
			),
		).toEqual([name]);
	});

	it("refuses a field the schema does not have", () => {
		expect(
			validate(
				schema,
				parse('query { repository(owner: "a", name: "b") { mergeTrain } }'),
			),
		).not.toEqual([]);
	});
});
