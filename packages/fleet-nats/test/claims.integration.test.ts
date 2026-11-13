/**
 * O4, claims are first-writer-wins at the server (E5, A5): 8 connections race
 * 500 claims and each has exactly one holder; a second publish, a delete, a
 * purge and a rollup from an executor are all refused.
 */
import { randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
	CLAIM_CONTEXT,
	parseFleetId,
	parseWorkDigest,
	Role,
	SignedEnvelopeSchema,
	type WorkDigest,
} from "@hobo/fleet";
import { headers } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STREAMS } from "../src/bus/names.js";
import {
	type Integration,
	refused,
	startIntegration,
} from "./support/integration.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const FLEET = parseFleetId("builders");
const CONNECTIONS = 8;
const CLAIMS = 500;
const encoder = new TextEncoder();

const claimBy = (member: string) =>
	create(SignedEnvelopeSchema, {
		context: CLAIM_CONTEXT,
		payload: encoder.encode(member),
	});

describe.skipIf(SKIP_INTEGRATION)(
	"O4: claims are first-writer-wins at the server",
	() => {
		let nats: TestNats | undefined;
		let integration: Integration | undefined;
		beforeAll(async () => {
			requireBinary();
			nats = await startNats();
			integration = await startIntegration(nats);
		}, 60_000);
		afterAll(async () => {
			await integration?.close();
			await nats?.stop();
		});
		const ready = (): Integration => {
			if (integration === undefined)
				throw new Error("nats-server did not start");
			return integration;
		};

		it(`gives each of ${CLAIMS} claims raced by ${CONNECTIONS} connections exactly one holder`, async () => {
			const fleet = ready();
			const buses = await Promise.all(
				Array.from({ length: CONNECTIONS }, async () =>
					fleet.connect(await fleet.device([Role.EXECUTOR])),
				),
			);
			const digests: WorkDigest[] = Array.from({ length: CLAIMS }, () =>
				parseWorkDigest(randomBytes(16).toString("hex")),
			);
			const won = new Map<string, number>();
			await Promise.all(
				buses.map((bus, index) =>
					Promise.all(
						digests.map(async (digest) => {
							const answer = await bus.claims.claim(
								claimBy(`c${index}`),
								FLEET,
								digest,
							);
							if (answer === "claimed")
								won.set(digest, (won.get(digest) ?? 0) + 1);
						}),
					),
				),
			);
			expect(digests.filter((digest) => won.get(digest) !== 1)).toEqual([]);
			const holder = await buses[0]?.claims.holder(
				FLEET,
				digests[0] ?? parseWorkDigest("0".repeat(32)),
			);
			expect(holder?.context).toBe(CLAIM_CONTEXT);
		}, 300_000);

		it("refuses a second publish, a delete, a purge and a rollup from an executor (A5)", async () => {
			const fleet = ready();
			const keys = await fleet.device([Role.EXECUTOR]);
			const bus = await fleet.connect(keys);
			const digest = parseWorkDigest(randomBytes(16).toString("hex"));
			expect(await bus.claims.claim(claimBy("first"), FLEET, digest)).toBe(
				"claimed",
			);
			expect(await bus.claims.claim(claimBy("second"), FLEET, digest)).toBe(
				"held",
			);

			const connection = await fleet.raw(keys);
			const held = await bus.claims.holder(FLEET, digest);
			expect(
				await refused(
					connection,
					`$JS.API.STREAM.MSG.DELETE.${STREAMS.claims}`,
					encoder.encode(JSON.stringify({ seq: 1 })),
				),
			).toBe(true);
			expect(
				await refused(connection, `$JS.API.STREAM.PURGE.${STREAMS.claims}`),
			).toBe(true);
			const rollup = headers();
			rollup.set("Nats-Rollup", "sub");
			const subject = `fleet.claim.${FLEET}.${digest}`;
			const answer = await connection
				.request(subject, toBinary(SignedEnvelopeSchema, claimBy("rollup")), {
					headers: rollup,
					timeout: 2_000,
				})
				.then((reply) => reply.string())
				.catch((error: Error) => error.message);
			expect(answer).toMatch(/error|rollup|maximum messages per subject/iu);
			const after = await bus.claims.holder(FLEET, digest);
			expect(new TextDecoder().decode(after?.payload)).toBe(
				new TextDecoder().decode(held?.payload),
			);
			expect(new TextDecoder().decode(after?.payload)).toBe("first");
		}, 60_000);
	},
);
