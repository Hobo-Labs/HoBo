import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Function as CloudFrontFunction,
	Distribution,
	Invalidation,
	KeyValueStore,
	KvEntries,
	OriginAccessControl,
} from "@alchemy.run/aws/CloudFront";
import { Providers } from "@alchemy.run/aws/Providers";
import { Bucket } from "@alchemy.run/aws/S3";
import { AssetDeployment } from "@alchemy.run/aws/Website";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import { Build } from "alchemy/Command/Build";
import * as Provider from "alchemy/Provider";
import type { ResourceClass, ResourceLike } from "alchemy/Resource";
import { Server } from "alchemy/Website/Server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { sessionReplay } from "../../../bindles/src/session-replay.js";
import {
	awsViteApp,
	awsViteBindleMappers,
	awsViteSource,
} from "../src/aws-vite.js";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	type AlchemyCompositeGuard,
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

function stub<R extends ResourceLike>(
	resource: ResourceClass<R>,
	precreate = false,
) {
	const service = {
		reconcile: () => Effect.die(new Error("unexpected provider effect")),
		delete: () => Effect.void,
	};
	if (precreate)
		return Provider.succeed(resource, {
			...service,
			precreate: () => Effect.die(new Error("unexpected precreate")),
		});
	return Provider.succeed(resource, service);
}

it("includes every Alchemy Vite resource and its source in HoBo's financial preview", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-vite-plan-"));
	const prior = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	try {
		const site = join(dir, "site");
		mkdirSync(site);
		writeFileSync(join(site, "index.html"), "hi");
		const sourceDigest = `sha256:${"a".repeat(64)}`;
		const environmentDigest = `sha256:${"b".repeat(64)}`;
		const sourceFence = {
			sourceDigest,
			environmentDigest,
			proofRef: "host:test",
			verify: () => true,
		};
		const definition = bindle("shop", (b) => ({
			web: b.web(awsViteApp("site")).with(sessionReplay({ enabled: false })),
		}));
		const program = mapBindleToAlchemy(
			definition,
			awsViteBindleMappers({ projectRoot: dir, sourceFence }),
			{ assessRequirements: () => ({ status: "supported" }) },
		);
		const aws = Layer.effect(
			Providers,
			Provider.collection([
				Bucket,
				AssetDeployment,
				KeyValueStore,
				CloudFrontFunction,
				OriginAccessControl,
				Distribution,
				KvEntries,
				Invalidation,
			]),
		).pipe(
			Layer.provide(
				Layer.mergeAll(
					stub(Bucket, true),
					stub(AssetDeployment),
					stub(KeyValueStore),
					stub(CloudFrontFunction),
					stub(OriginAccessControl),
					stub(Distribution),
					stub(KvEntries),
					stub(Invalidation),
				),
			),
		);
		const providers = Layer.mergeAll(aws, stub(Server), stub(Build));
		const stack = Stack(
			"Demo",
			{ providers, state: inMemoryState() },
			program.pipe(Effect.map(() => ({}))),
		);
		const entries = [
			["Build", "Website.Server"],
			["Bucket", "AWS.S3.Bucket"],
			["Files", "AWS.Website.AssetDeployment"],
			["KvStore", "AWS.CloudFront.KeyValueStore"],
			["ViewerRequest", "AWS.CloudFront.Function"],
			["OriginAccessControl", "AWS.CloudFront.OriginAccessControl"],
			["Distribution", "AWS.CloudFront.Distribution"],
			["KvEntries", "AWS.CloudFront.KvEntries"],
			["Invalidation", "AWS.CloudFront.Invalidation"],
		] as const;
		const observed: FinancialPlan[] = [];
		const target = alchemyTarget({
			targetId: "yard",
			tenantId: "tenant",
			stackName: "Demo",
			stage: "test",
			programResourceId: "app",
			sourceDigest,
			inventoryEvidenceRef: "inventory:1",
			resources: entries.map(([name, resourceType]) => ({
				resourceId: `web/${name}`,
				resourceType,
				providerId: "aws",
				providerAccountRef: "account",
				productId: `aws:${name}`,
			})),
		});
		const guard: AlchemyCompositeGuard = {
			proofRef: "host:test",
			environmentDigest,
			sourceRequirements: [awsViteSource("shop", "web", site)],
			verifyEnvironment: () => true,
			verifyPlan: ({ sourceClaims }) => sourceClaims.length === 1,
		};
		const provider = createAlchemyIacProvider({
			stack,
			stateOwnership: testStateOwnership,
			runtimeLayer: Alchemist.layer(),
			runtimeDirectory: join(dir, "runtime"),
			target,
			composite: guard,
			financial: {
				assess: (inventory) => {
					observed.push(inventory);
					return { inventory };
				},
				admit: async () => {
					throw new Error("unexpected admission");
				},
				revalidate: () => false,
				uncertain: () => {},
			},
		});
		const diff = await provider.preview({
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "aws",
			driver: "external",
			action: "apply",
			stackName: "Demo",
		});
		expect(diff.changes).toBe(9);
		expect(
			observed[0]?.resources.map((entry) => entry.resourceId).sort(),
		).toEqual(entries.map(([name]) => `web/${name}`).sort());
	} finally {
		if (prior === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = prior;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
