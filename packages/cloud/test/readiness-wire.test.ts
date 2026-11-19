import { fromBinary, fromJson, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ResourceIntentSchema,
	ResourcePlanSchema,
} from "../src/_generated/cloud_pb.js";

describe("readiness dependency wire records", () => {
	it("round-trips conditions on a resource intent", () => {
		const input = fromJson(ResourceIntentSchema, {
			name: "api",
			port: "compute",
			readyDeps: ["database"],
			completedDeps: ["migration"],
		});
		const decoded = fromBinary(
			ResourceIntentSchema,
			toBinary(ResourceIntentSchema, input),
		);
		expect(decoded.readyDeps).toEqual(["database"]);
		expect(decoded.completedDeps).toEqual(["migration"]);
	});

	it("round-trips conditions on a resource plan", () => {
		const input = fromJson(ResourcePlanSchema, {
			name: "api",
			port: "compute",
			readyDeps: ["database"],
			completedDeps: ["migration"],
		});
		const decoded = fromBinary(
			ResourcePlanSchema,
			toBinary(ResourcePlanSchema, input),
		);
		expect(decoded.readyDeps).toEqual(["database"]);
		expect(decoded.completedDeps).toEqual(["migration"]);
	});
});
