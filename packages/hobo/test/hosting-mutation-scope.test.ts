import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableHostingMutationScope } from "../src/hosting-mutation-scope.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-parent-lock-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	return () => {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		dispose.push(() => store.close());
		return createDurableHostingMutationScope({
			store,
			tenantId: "tenant",
			actor: { kind: "service", id: "worker" },
			fenceToken: 1n,
			nowMs: () => 1000,
		});
	};
}
const scope = {
	providerId: "digitalocean",
	providerAccountId: "acct",
	parentId: "native-app",
};
describe("durable native shared-parent mutation serialization", () => {
	it("serializes two independent SQLite connections before either reads and overwrites the same app", async () => {
		const connect = fixture(),
			a = connect(),
			b = connect();
		let entered = 0;
		let finish: () => void = () => {};
		let markEntered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = a.run(scope, async () => {
			entered += 1;
			markEntered();
			await gate;
			return "first";
		});
		await started;
		await expect(
			b.run(scope, async () => {
				entered += 1;
				return "second";
			}),
		).rejects.toThrow("in-flight or uncertain");
		expect(entered).toBe(1);
		finish();
		expect(await first).toBe("first");
		expect(await b.run(scope, async () => "second")).toBe("second");
	});
	it("keeps a lost response locked across process reopen and never expires on a timer", async () => {
		const connect = fixture();
		await expect(
			connect().run(scope, async () => {
				throw new Error("lost native acknowledgement");
			}),
		).rejects.toThrow("lost native");
		let effects = 0;
		await expect(
			connect().run(scope, async () => {
				effects += 1;
			}),
		).rejects.toThrow("uncertain");
		expect(effects).toBe(0);
	});
	it("allows independent native parents without serializing unrelated accounts", async () => {
		const connect = fixture(),
			a = connect(),
			b = connect();
		await expect(
			a.run(scope, async () =>
				b.run(
					{ ...scope, providerAccountId: "other" },
					async () => "independent",
				),
			),
		).resolves.toBe("independent");
	});
});
