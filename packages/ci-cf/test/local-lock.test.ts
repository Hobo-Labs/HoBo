import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	LocalRunReceiptSchema,
	LocalRunStateSchema,
} from "../src/_generated/readiness_pb.js";
import { acquirePreparationLock } from "../src/local-runtime.js";

it("uses one OS lock inode and requires explicit recovery of interrupted admissions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-cf-lock-"));
	const first = randomUUID(),
		second = randomUUID();
	try {
		const lock = await acquirePreparationLock(directory, first);
		try {
			await expect(acquirePreparationLock(directory, second)).rejects.toThrow(
				"another controller",
			);
		} finally {
			await lock.close();
		}
		const receipt = create(LocalRunReceiptSchema, {
			workflowId: first,
			state: create(LocalRunStateSchema, { phase: "running" }),
		});
		await writeFile(
			join(directory, `run-${first}.json`),
			toJsonString(LocalRunReceiptSchema, receipt),
		);
		await expect(acquirePreparationLock(directory, second)).rejects.toThrow(
			"requires --resume",
		);
		const recovered = await acquirePreparationLock(directory, first, first);
		await recovered.close();
		receipt.state = create(LocalRunStateSchema, {
			phase: "finished",
			shutdownConfirmed: true,
			outcome: "uncertain",
			exitCode: 2,
		});
		await writeFile(
			join(directory, `run-${first}.json`),
			toJsonString(LocalRunReceiptSchema, receipt),
		);
		const fresh = await acquirePreparationLock(directory, second);
		await fresh.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
