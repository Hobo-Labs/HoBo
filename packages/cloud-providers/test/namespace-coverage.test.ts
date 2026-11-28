import { describe, expect, it } from "vitest";

import {
	aws,
	azure,
	cloudflare,
	digitalocean,
	gcp,
	hetzner,
	hostinger,
	kubernetes,
	vercel,
} from "../src/index.js";

type SlotBinding = { readonly contract?: string; readonly productId?: string };
type SlotFactory = () => object;
type NamespaceValue = string | SlotFactory | NamespaceObject;
type NamespaceObject = Readonly<Record<string, NamespaceValue>>;

function isSlotFactory(value: NamespaceValue): value is SlotFactory {
	return value instanceof Function;
}

function productIdsFrom(namespace: NamespaceObject): Set<string> {
	const found = new Set<string>();
	const consider = (value: NamespaceValue): void => {
		if (!isSlotFactory(value)) return;
		let produced: object;
		try {
			produced = value();
		} catch {
			return;
		}
		// SAFETY: slot factories return parsed binding objects by contract.
		const record = produced as SlotBinding;
		if (record.contract !== "hobo.slot-binding/v1") return;
		if (record.productId !== undefined) found.add(record.productId);
	};

	for (const value of Object.values(namespace)) {
		if (value instanceof Object) consider(value);
		if (value instanceof Object) {
			for (const nested of Object.values(value)) {
				if (nested instanceof Object) consider(nested);
			}
		}
	}
	return found;
}

const NAMESPACES = [
	{ name: "aws", ns: aws },
	{ name: "azure", ns: azure },
	{ name: "gcp", ns: gcp },
	{ name: "cloudflare", ns: cloudflare },
	{ name: "vercel", ns: vercel },
	{ name: "digitalocean", ns: digitalocean },
	{ name: "hetzner", ns: hetzner },
	{ name: "hostinger", ns: hostinger },
	{ name: "kubernetes", ns: kubernetes },
] as const;

describe("namespace reaches everything its catalog declares", () => {
	for (const { name, ns } of NAMESPACES) {
		it(`${name}: every catalog productId has a reachable factory`, () => {
			const catalogProducts = new Set(
				// SAFETY: every namespace in NAMESPACES exposes the shared Yard contract.
				(ns as { Yard: () => { bindings: readonly { productId?: string }[] } })
					.Yard()
					.bindings.map((row) => row.productId)
					.filter((id): id is string => id !== undefined),
			);
			// SAFETY: provider namespaces are closed string-keyed export objects.
			const reachable = productIdsFrom(ns as NamespaceObject);
			const unreachable = [...catalogProducts]
				.filter((id) => !reachable.has(id))
				.sort();

			expect(
				unreachable,
				`${name} declares these products in its Yard catalog but exports no factory for them from @hobo/cloud-providers`,
			).toEqual([]);
		});
	}

	it("aws reaches the offerings added when its catalog was widened", () => {
		for (const factory of [
			"appRunner",
			"amplifyHosting",
			"cloudfrontSite",
			"apiGateway",
			"auroraServerlessPostgres",
			"elasticacheRedis",
			"sns",
			"secretsManager",
			"ssmParameterStore",
			"sqsFifo",
			"dynamodbDocument",
		]) {
			expect(
				// SAFETY: these names are the closed regression vocabulary above.
				(aws as Record<string, SlotFactory>)[factory],
				`aws.${factory} must be reachable from @hobo/cloud-providers`,
			).toBeTypeOf("function");
		}
		expect(
			// SAFETY: `ecs.service` is the nested factory exported by the namespace.
			(aws as { ecs?: { service?: SlotFactory } }).ecs?.service,
		).toBeTypeOf("function");
	});
});
