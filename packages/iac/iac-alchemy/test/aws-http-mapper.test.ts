import { fileURLToPath } from "node:url";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Output from "alchemy/Output";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import {
	awsHttpBindleMappers,
	awsWebFunctionSource,
} from "../src/aws-http-mapper.js";
import { defineAwsHttpSource } from "../src/aws-http-source.js";
import {
	awsDynamoKvBindleMappers,
	withAwsDynamoKv,
} from "../src/aws-kv-mapper.js";
import { awsS3BindleMappers, withAwsS3 } from "../src/aws-s3-mapper.js";
import {
	type AlchemyBindleMapping,
	mapBindleToAlchemy,
} from "../src/bindle.js";
import { alchemySourceFor } from "../src/source-fence.js";

function fixture() {
	const neutral = bindle("shop", (b) => {
		const sessions = b.kv().allow("get");
		const objects = b.bucket().allow("read");
		return {
			sessions,
			objects,
			web: b
				.web(() => () => new Response("ok"))
				.with(sessionReplay({ enabled: false }))
				.dependsOn(sessions, objects),
		};
	});
	const selected = withAwsS3(withAwsDynamoKv(neutral, { sessions: true }), {
		objects: true,
	});
	const source = defineAwsHttpSource({
		bindle: selected,
		applicationName: "web",
		environment: {},
		resolveStores: () => ({}),
		verifyBinding: () => true,
	});
	const main = fileURLToPath(import.meta.url);
	let authorized = true;
	let sourceAuthorized = true;
	const fence = {
		sourceDigest: `sha256:${"a".repeat(64)}`,
		environmentDigest: `sha256:${"b".repeat(64)}`,
		proofRef: "host:test",
		verify: () => authorized,
	};
	const checks: {
		authType: string;
		maxEnvironments: number;
		rateLimit: number;
	}[] = [];
	const options = {
		source,
		main,
		authType: "IamAuth" as const,
		maxEnvironments: 2,
		rateLimit: 100,
		sourceFence: fence,
		verifySource: (claim: {
			source: typeof source;
			authType: string;
			maxEnvironments: number;
			rateLimit: number;
		}) => {
			checks.push({
				authType: claim.authType,
				maxEnvironments: claim.maxEnvironments,
				rateLimit: claim.rateLimit,
			});
			return sourceAuthorized && claim.source === source;
		},
	};
	const mappers = awsHttpBindleMappers(
		options,
		awsS3BindleMappers(awsDynamoKvBindleMappers()),
	);
	const stack = {
		name: "Shop",
		stage: "test",
		resources: {},
		bindings: {},
		actions: {},
	};
	// SAFETY: this fixture supplies the Alchemy services required to construct the mapped resources.
	const run = () =>
		Effect.runPromise(
			mapBindleToAlchemy(selected, mappers, {
				assessRequirements: () => ({ status: "supported" as const }),
			}).pipe(
				Effect.provideService(StackContext, stack),
				Effect.provideService(Stage, "test"),
				Effect.provideService(AlchemyContext, {
					dotAlchemy: "/tmp",
					dev: false,
					adopt: false,
				}),
			) as Effect.Effect<AlchemyBindleMapping>,
		);
	return {
		selected,
		source,
		options,
		checks,
		main,
		run,
		revoke: () => {
			authorized = false;
		},
		revokeSource: () => {
			sourceAuthorized = false;
		},
	};
}

describe("AWS Alchemy HTTP application mapping", () => {
	it("maps an attested application and its exact dependencies to an Alchemy WebFunction", async () => {
		const f = fixture();
		const mapped = await f.run();
		expect(
			mapped.resources.map((resource) => [resource.FQN, resource.Type]).sort(),
		).toEqual([
			["objects", "AWS.S3.Bucket"],
			["sessions", "AWS.DynamoDB.Table"],
			["web", "AWS.Lambda.WebFunction"],
		]);
		const web = mapped.primary.web;
		if (!web) throw new Error("missing web function");
		expect(web.Props).toMatchObject({
			main: f.main,
			authType: "IamAuth",
			maxConcurrencyPerEnvironment: 32,
			maxEnvironments: 2,
			rateLimit: 100,
		});
		expect(Object.keys(web.Props.env).sort()).toEqual([
			"HOBO_RESOURCE_0",
			"HOBO_RESOURCE_1",
		]);
		expect(
			Object.keys(Output.resolveUpstream(web.Props.env.HOBO_RESOURCE_0)),
		).toEqual(["objects"]);
		expect(
			Object.keys(Output.resolveUpstream(web.Props.env.HOBO_RESOURCE_1)),
		).toEqual(["sessions"]);
		expect(f.checks.length).toBeGreaterThan(0);
		expect(
			f.checks.every(
				(claim) =>
					claim.authType === "IamAuth" &&
					claim.maxEnvironments === 2 &&
					claim.rateLimit === 100,
			),
		).toBe(true);
		expect(alchemySourceFor(web)?.claim).toMatchObject(
			awsWebFunctionSource("shop", "web", f.main),
		);
		f.revoke();
		const binding = alchemySourceFor(web);
		expect(binding?.verify(binding.claim)).toBe(false);
	});
	it("rechecks the source binding as well as the artifact fence after mapping", async () => {
		const f = fixture();
		const mapped = await f.run();
		const web = mapped.primary.web;
		if (!web) throw new Error("missing web function");
		const binding = alchemySourceFor(web);
		if (!binding) throw new Error("missing source claim");
		f.revokeSource();
		expect(binding.verify(binding.claim)).toBe(false);
	});
	it("requires valid explicit endpoint scaling and rate limits", () => {
		const f = fixture();
		for (const maxEnvironments of [0, 1, 10_001, Number.POSITIVE_INFINITY]) {
			expect(() =>
				awsHttpBindleMappers({ ...f.options, maxEnvironments }),
			).toThrow("scaling limits");
		}
		for (const rateLimit of [-1, 1, 101, 10_001, Number.NaN]) {
			expect(() => awsHttpBindleMappers({ ...f.options, rateLimit })).toThrow(
				"scaling limits",
			);
		}
	});
	it("refuses to map after source authority is revoked", async () => {
		const f = fixture();
		f.revoke();
		expect(() => f.run()).toThrow("did not verify");
	});
});
