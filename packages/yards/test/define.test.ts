import { camp } from "@hobo/camps";
import {
	type CapabilitySlot,
	SLOT_BINDING_CONTRACT,
	type SlotBinding,
	slotBinding,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	defineStation,
	defineYard,
	STATION_MANIFEST_CONTRACT,
	StationDefineError,
	slotOf,
	YARD_BINDING_CONTRACT,
	YardBindingError,
	YardDefineError,
	yard,
	yardToContract,
} from "../src/index.js";

/**
 * A hand-built record that deliberately skips core's `slotBinding()` parse
 * boundary, so the refusals below prove this package's own guards rather than
 * core's. The `slotBinding()` path is exercised separately.
 */
function rawSlotBinding(
	slot: CapabilitySlot,
	profile: string,
	overrides: Partial<SlotBinding> = {},
): SlotBinding {
	return {
		contract: SLOT_BINDING_CONTRACT,
		slot,
		profile,
		properties: {},
		...overrides,
	};
}

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof YardDefineError) return error.code;
		if (error instanceof StationDefineError) return error.code;
		if (error instanceof YardBindingError) return error.code;
		return String(error);
	}
	return "no-error";
}

describe("defineYard() — slots compile to binding rows", () => {
	it("produces the same rows as hand-written ones", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			region: "us-east-1",
			data: rawSlotBinding("data", "data.postgres/v1", {
				productId: "aws.rds-postgres/v1",
				properties: { "aws.engineVersion": "16" },
			}),
			bucket: rawSlotBinding("bucket", "bucket.object/v1", {
				productId: "aws.s3/v1",
			}),
		});
		const handWritten = yard("aws-prod", {
			provider: "aws",
			regions: ["us-east-1"],
			bindings: [
				{
					profile: "data.postgres/v1",
					productId: "aws.rds-postgres/v1",
					properties: { "aws.engineVersion": "16" },
				},
				{ profile: "bucket.object/v1", productId: "aws.s3/v1" },
			],
			camps: [],
		});

		expect(defined).toEqual(handWritten);
		expect(defined.bindings.map((row) => row.profile)).toEqual([
			"bucket.object/v1",
			"data.postgres/v1",
		]);
		expect(defined.bindings[0]?.contract).toBe(YARD_BINDING_CONTRACT);
	});

	it("compiles bindings that came from core's slotBinding() parse boundary", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			data: slotBinding({
				slot: "data",
				profile: "data.postgres/v1",
				productId: "aws.rds-postgres/v1",
				properties: { "aws.engineVersion": "16" },
			}),
			bucket: slotBinding({
				slot: "bucket",
				profile: "bucket.s3-compatible/v1",
				productId: "aws.s3/v1",
			}),
		});
		expect(defined.bindings.map((row) => row.profile)).toEqual([
			"bucket.s3-compatible/v1",
			"data.postgres/v1",
		]);
		expect(defined.bindings[1]?.properties).toEqual({
			"aws.engineVersion": "16",
		});
		expect(slotOf(defined, "bucket.s3-compatible/v1")).toBe("bucket");
	});

	it("carries connectivity-only slot bindings through", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			queue: rawSlotBinding("queue", "queue.at-least-once/v1", {
				connectivityId: "aws.sqs-connectivity/v1",
			}),
		});
		expect(defined.bindings[0]?.connectivityId).toBe("aws.sqs-connectivity/v1");
		expect(defined.bindings[0]?.productId).toBeUndefined();
	});

	it("returns a real Yard: frozen, contract-projectable, bindings intact", () => {
		const defined = defineYard("gcp-edge", {
			provider: { id: "gcp" },
			regions: ["us-central1"],
			residency: ["us"],
			componentHosts: ["gcp.cloud-run/v1"],
			labels: { tier: "edge" },
			camps: [camp("prod", { envType: "production" })],
			web: rawSlotBinding("web", "web.static/v1", {
				productId: "gcp.cloud-storage-website/v1",
			}),
		});

		expect(Object.isFrozen(defined)).toBe(true);
		const contract = yardToContract(defined);
		expect(contract.providerId).toBe("gcp");
		expect(contract.regions).toEqual(["us-central1"]);
		expect(contract.residency).toEqual(["us"]);
		expect(contract.componentHosts).toEqual(["gcp.cloud-run/v1"]);
		expect(contract.labels).toEqual({ tier: "edge" });
		expect(contract.camps).toHaveLength(1);
		expect(contract.bindings).toEqual([
			{
				contract: YARD_BINDING_CONTRACT,
				profile: "web.static/v1",
				productId: "gcp.cloud-storage-website/v1",
				require: [],
				properties: {},
			},
		]);
	});

	it("accepts several bindings on one slot", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			bucket: [
				rawSlotBinding("bucket", "bucket.object/v1", {
					productId: "aws.s3/v1",
				}),
				rawSlotBinding("bucket", "bucket.archive/v1", {
					productId: "aws.s3-glacier/v1",
				}),
			],
		});
		expect(defined.bindings.map((row) => row.profile)).toEqual([
			"bucket.archive/v1",
			"bucket.object/v1",
		]);
	});

	it("still refuses a duplicate row produced by two bindings on one slot", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					bucket: [
						rawSlotBinding("bucket", "bucket.object/v1", {
							productId: "aws.s3/v1",
						}),
						rawSlotBinding("bucket", "bucket.object/v1", {
							productId: "aws.s3/v1",
						}),
					],
				}),
			),
		).toBe("YARD_BINDING_DUPLICATE");
	});

	it("maps the ADR-0151 family aliases onto their slots", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			secretRef: rawSlotBinding("secretRef", "secret-ref.locator/v1", {
				productId: "aws.secrets-manager/v1",
			}),
			webhook: rawSlotBinding("webhook", "realtime.websocket/v1", {
				productId: "aws.apigw-websocket/v1",
			}),
		});
		expect(defined.bindings.map((row) => row.profile)).toEqual([
			"realtime.websocket/v1",
			"secret-ref.locator/v1",
		]);
	});
});

describe("defineYard() — refusals", () => {
	it("refuses a slot whose profile family belongs elsewhere", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					bucket: rawSlotBinding("bucket", "data.postgres/v1", {
						productId: "aws.rds-postgres/v1",
					}),
				}),
			),
		).toBe("SLOT_PROFILE_MISMATCH");
	});

	it("refuses a profile family outside the slot vocabulary", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					data: rawSlotBinding("data", "storage.blob/v1", {
						productId: "aws.s3/v1",
					}),
				}),
			),
		).toBe("SLOT_PROFILE_MISMATCH");
	});

	it("refuses a binding filed under a key it does not declare", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					queue: rawSlotBinding("topic", "topic.durable-log/v1", {
						productId: "aws.kinesis/v1",
					}),
				}),
			),
		).toBe("SLOT_KEY_MISMATCH");
	});

	it("leaves a malformed profile to the existing grammar refusal", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					data: rawSlotBinding("data", "Data.Postgres", {
						productId: "aws.rds-postgres/v1",
					}),
				}),
			),
		).toBe("YARD_BINDING_PROFILE_INVALID");
	});

	it("still refuses a credential property authored through a slot", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					data: rawSlotBinding("data", "data.postgres/v1", {
						productId: "aws.rds-postgres/v1",
						properties: { apiKey: "hunter2" },
					}),
				}),
			),
		).toBe("YARD_BINDING_CREDENTIAL_PROPERTY");
	});

	it("still refuses a row that constrains neither product nor connectivity", () => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					kv: rawSlotBinding("kv", "kv.key-value/v1"),
				}),
			),
		).toBe("YARD_BINDING_EMPTY_CONSTRAINT");
	});

	it("refuses a slot binding with the wrong contract", () => {
		expect(() =>
			defineYard("aws-prod", {
				provider: "aws",
				// SAFETY: the row deliberately carries a retired contract id; the
				// compile step must refuse it, so the typed signature is bypassed
				// on purpose.
				kv: {
					contract: "hobo.slot-binding/v0",
					slot: "kv",
					profile: "kv.key-value/v1",
					productId: "aws.elasticache/v1",
					properties: {},
				} as never,
			}),
		).toThrow(/must carry contract/u);
	});

	it("requires a provider", () => {
		expect(() => defineYard("aws-prod", { provider: "" })).toThrow(/provider/u);
	});
});

describe("defineYard() — determinism", () => {
	it("is unchanged by slot authoring order", () => {
		const first = defineYard("aws-prod", {
			provider: "aws",
			web: rawSlotBinding("web", "web.static/v1", {
				productId: "aws.s3-website/v1",
			}),
			data: rawSlotBinding("data", "data.postgres/v1", {
				productId: "aws.rds-postgres/v1",
			}),
			queue: rawSlotBinding("queue", "queue.at-least-once/v1", {
				productId: "aws.sqs/v1",
			}),
		});
		const second = defineYard("aws-prod", {
			provider: "aws",
			queue: rawSlotBinding("queue", "queue.at-least-once/v1", {
				productId: "aws.sqs/v1",
			}),
			data: rawSlotBinding("data", "data.postgres/v1", {
				productId: "aws.rds-postgres/v1",
			}),
			web: rawSlotBinding("web", "web.static/v1", {
				productId: "aws.s3-website/v1",
			}),
		});

		expect(first).toEqual(second);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe("defineYard() — region sugar", () => {
	it("expands region into a one-element regions list", () => {
		expect(
			defineYard("aws-prod", { provider: "aws", region: "us-east-1" }).regions,
		).toEqual(["us-east-1"]);
	});

	it("accepts region alongside an agreeing regions list", () => {
		expect(
			defineYard("aws-prod", {
				provider: "aws",
				region: "us-east-1",
				regions: ["us-east-1"],
			}).regions,
		).toEqual(["us-east-1"]);
	});

	it.each<[readonly string[], string]>([
		[["us-west-2"], "different region"],
		[["us-east-1", "us-west-2"], "region plus another"],
		[[], "empty regions list"],
	])("refuses region + regions %j (%s)", (regions) => {
		expect(
			codeOf(() =>
				defineYard("aws-prod", {
					provider: "aws",
					region: "us-east-1",
					regions,
				}),
			),
		).toBe("YARD_REGION_CONFLICT");
	});
});

describe("slotOf()", () => {
	it("reports the slot a row came from", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			data: rawSlotBinding("data", "data.postgres/v1", {
				productId: "aws.rds-postgres/v1",
			}),
			secretRef: rawSlotBinding("secretRef", "secret-ref.locator/v1", {
				productId: "aws.secrets-manager/v1",
			}),
		});
		expect(slotOf(defined, "data.postgres/v1")).toBe("data");
		expect(slotOf(defined, "secret-ref.locator/v1")).toBe("secretRef");
	});

	it("answers for hand-written rows too, and is undefined off the vocabulary", () => {
		const handWritten = yard("aws-prod", {
			provider: "aws",
			bindings: [
				{ profile: "bucket.object/v1", productId: "aws.s3/v1" },
				{ profile: "storage.blob/v1", productId: "aws.s3/v1" },
			],
		});
		expect(slotOf(handWritten, "bucket.object/v1")).toBe("bucket");
		expect(slotOf(handWritten, "storage.blob/v1")).toBeUndefined();
	});

	it("is undefined for a profile the Yard does not bind", () => {
		const defined = defineYard("aws-prod", {
			provider: "aws",
			kv: rawSlotBinding("kv", "kv.key-value/v1", {
				productId: "aws.elasticache/v1",
			}),
		});
		expect(slotOf(defined, "queue.at-least-once/v1")).toBeUndefined();
	});
});

describe("defineStation() — registration, not containment", () => {
	const yardA = defineYard("aws-prod", {
		provider: "aws",
		data: rawSlotBinding("data", "data.postgres/v1", {
			productId: "aws.rds-postgres/v1",
		}),
	});
	const yardB = defineYard("gcp-edge", {
		provider: "gcp",
		web: rawSlotBinding("web", "web.static/v1", {
			productId: "gcp.cloud-storage-website/v1",
		}),
	});

	it("emits sorted yardRefs and station() default isolation", () => {
		const manifest = defineStation("edge", { yards: [yardB, yardA] });
		expect(manifest.contract).toBe(STATION_MANIFEST_CONTRACT);
		expect(manifest.name).toBe("edge");
		expect(manifest.yardRefs).toEqual(["aws-prod", "gcp-edge"]);
		expect(manifest.yards.map((entry) => entry.name)).toEqual([
			"aws-prod",
			"gcp-edge",
		]);
		expect(manifest.isolation).toEqual({
			tenant: "edge",
			residency: "local",
			airgap: false,
			trustDomain: "edge.hobo.local",
		});
		expect(Object.isFrozen(manifest)).toBe(true);
	});

	it("honours authored isolation", () => {
		const manifest = defineStation("edge", {
			isolation: {
				tenant: "acme",
				residency: "eu",
				airgap: true,
				trustDomain: "acme.example",
			},
			yards: [yardA],
		});
		expect(manifest.isolation).toEqual({
			tenant: "acme",
			residency: "eu",
			airgap: true,
			trustDomain: "acme.example",
		});
	});

	it("is unchanged by registration order", () => {
		expect(defineStation("edge", { yards: [yardA, yardB] })).toEqual(
			defineStation("edge", { yards: [yardB, yardA] }),
		);
	});

	it("refuses duplicate yard names", () => {
		expect(codeOf(() => defineStation("edge", { yards: [yardA, yardA] }))).toBe(
			"STATION_DUPLICATE_YARD",
		);
	});

	it("refuses a Station that brokers nothing", () => {
		expect(codeOf(() => defineStation("edge", { yards: [] }))).toBe(
			"STATION_NO_YARDS",
		);
	});

	it("refuses non-Yard registrations", () => {
		expect(() =>
			defineStation("edge", {
				// SAFETY: `yards: [{ kind: "camp", name: "prod" }] as never,` is required at this I/O or test boundary.
				yards: [{ kind: "camp", name: "prod" }] as never,
			}),
		).toThrow(/parsed Yard objects/u);
	});
});
