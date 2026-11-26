import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { JobSchema, LeaseSchema } from "../src/_generated/ci_pb.js";

describe("CI budget fields preserve existing protobuf wire numbers", () => {
	it("keeps persisted job name and memory fields alongside its queue deadline", () => {
		const bytes = Uint8Array.from([
			0x5a, 4, 0x74, 0x65, 0x73, 0x74, 0x62, 5, 0x68, 0x65, 0x61, 0x76, 0x79,
			0x68, 0x80, 0x20, 0x72, 5, 0x6c, 0x61, 0x74, 0x65, 0x72,
		]);
		const job = fromBinary(JobSchema, bytes);
		expect(job).toMatchObject({
			name: "test",
			memoryClass: "heavy",
			memoryMb: 4096,
			queueDeadlineAt: "later",
		});
		expect(toBinary(JobSchema, job)).toEqual(bytes);
	});

	it("keeps existing lease metadata alongside its shared budget identity", () => {
		const bytes = Uint8Array.from([
			0xea, 0x02, 5, 0x68, 0x65, 0x61, 0x76, 0x79, 0xf0, 0x02, 0x80, 0x20, 0xfa,
			0x02, 4, 0x74, 0x65, 0x73, 0x74, 0x82, 0x03, 1, 0x74, 0x8a, 0x03, 1, 0x70,
			0x9a, 0x03, 1, 0x62,
		]);
		const lease = fromBinary(LeaseSchema, bytes);
		expect(lease).toMatchObject({
			memoryClass: "heavy",
			memoryMb: 4096,
			jobName: "test",
			dispatchingAt: "t",
			providerAccountId: "p",
			budgetId: "b",
		});
		expect(toBinary(LeaseSchema, lease)).toEqual(bytes);
	});
});
