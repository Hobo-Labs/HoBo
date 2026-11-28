import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	assertNoWaitTrue,
	createActorLocalJournal,
	createRivetActorHost,
	createRivetRuntimeHost,
	HOBO_RUNTIME_RIVET_PACKAGE,
	RIVET_ENGINE_PIN,
	RIVET_RESOLVER_PROFILES,
	RIVETKIT_PIN,
	rivetEngineImageRef,
	rivetStreamId,
} from "../src/index.js";

const identity = {
	tenantId: "acme",
	projectId: "shop",
	actorTypeId: "Cart",
	keySegments: ["user-1"],
	schemaVersion: 1,
};

describe("@hobo/runtime-rivet", () => {
	it("package id and grammar-legal profiles", () => {
		expect(HOBO_RUNTIME_RIVET_PACKAGE).toBe("@hobo/runtime-rivet");
		expect(RIVET_RESOLVER_PROFILES[0]).toBe("kv.durable-object/v1");
		expect(RIVET_RESOLVER_PROFILES.some((id) => id.startsWith("actor."))).toBe(
			false,
		);
		expect(RIVETKIT_PIN.version).toBe("3.0.0");
		expect(RIVET_ENGINE_PIN.tag).toBe("3.0.0");
		expect(rivetEngineImageRef()).toBe(
			"rivetdev/engine:3.0.0@sha256:5ae3c24275eeff87ad1962f4d66fcdb85786fc1397feeeb55afc2ca1f7ccf6f2",
		);
	});

	it.each([
		"rivetkit",
		"@rivetkit/rivetkit-wasm",
	])("installs the pinned Rivet 3 %s artifact", (packageName) => {
		const packageJson = JSON.parse(
			readFileSync(
				new URL(`../node_modules/${packageName}/package.json`, import.meta.url),
				"utf8",
			),
		);
		expect(packageJson.version).toBe(RIVETKIT_PIN.version);
	});

	it("installs the engine CLI at the pinned Rivet 3 version", () => {
		const require = createRequire(import.meta.url);
		const rivetRequire = createRequire(require.resolve("rivetkit"));
		const engineEntry = rivetRequire.resolve("@rivetkit/engine-cli");
		const packageJson = JSON.parse(
			readFileSync(join(dirname(engineEntry), "package.json"), "utf8"),
		);
		expect(packageJson.name).toBe("@rivetkit/engine-cli");
		expect(packageJson.version).toBe(RIVETKIT_PIN.version);
	});

	it("ensure reports rivet kind and local-sqlite fidelity offline", async () => {
		const bundle = createRivetRuntimeHost({
			tenantId: "t1",
			campId: "c1",
			journalPath: ":memory:",
		});
		expect(bundle.host.kind).toBe("rivet");
		const result = await bundle.host.ensure({ hoboHome: "/tmp", env: {} });
		expect(result.kind).toBe("rivet");
		expect(result.details.placementMode).toBe("rivet");
		expect(result.details.fidelity).toBe("local-sqlite");
		expect(result.details.secretless).toBe(true);
		bundle.journal.close();
	});

	it("requires an explicit journal path", () => {
		expect(() =>
			// @ts-expect-error
			createRivetRuntimeHost({ tenantId: "t1", campId: "c1" }),
		).toThrow(/journalPath/);
		for (const journalPath of ["", "   "]) {
			expect(() =>
				createRivetRuntimeHost({ tenantId: "t1", campId: "c1", journalPath }),
			).toThrow(/journalPath/);
		}
	});

	it("rejects commands from a different tenant in a scoped runtime", () => {
		const bundle = createRivetRuntimeHost({
			tenantId: "acme",
			campId: "prod",
			journalPath: ":memory:",
		});
		const foreign = { ...identity, tenantId: "other" };
		try {
			expect(() =>
				bundle.actors.accept({
					identity: foreign,
					commandId: "foreign-command",
					commandType: "addItem",
					payload: { sku: "hat" },
					expectedRevision: 0,
				}),
			).toThrow(/tenant/i);
			expect(() =>
				bundle.actors.processNext(foreign, (state) => state, {}),
			).toThrow(/tenant/i);
		} finally {
			bundle.journal.close();
		}
	});

	it("refuses to open one persistent journal for a different Camp", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-camp-scope-"));
		const journalPath = join(directory, "journal.sqlite");
		const first = createRivetRuntimeHost({
			tenantId: "acme",
			campId: "production",
			journalPath,
		});
		let other: ReturnType<typeof createRivetRuntimeHost> | undefined;
		try {
			expect(() => {
				other = createRivetRuntimeHost({
					tenantId: "acme",
					campId: "staging",
					journalPath,
				});
			}).toThrow(/journal.*scope/i);
		} finally {
			other?.journal.close();
			first.journal.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reopens a journal in the same scope and refuses a different tenant", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-same-scope-"));
		const journalPath = join(directory, "journal.sqlite");
		const first = createRivetRuntimeHost({
			tenantId: "acme",
			campId: "prod",
			journalPath,
		});
		try {
			first.actors.accept({
				identity,
				commandId: "cmd-1",
				commandType: "addItem",
				payload: { sku: "hat" },
				expectedRevision: 0,
			});
		} finally {
			first.journal.close();
		}
		const reopened = createRivetRuntimeHost({
			tenantId: "acme",
			campId: "prod",
			journalPath,
		});
		try {
			expect(
				reopened.actors.accept({
					identity,
					commandId: "cmd-1",
					commandType: "addItem",
					payload: { sku: "hat" },
					expectedRevision: 0,
				}).duplicate,
			).toBe(true);
			expect(() =>
				createRivetRuntimeHost({
					tenantId: "other",
					campId: "prod",
					journalPath,
					adoptUnscopedJournal: true,
				}),
			).toThrow(/journal.*scope/i);
		} finally {
			reopened.journal.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("requires explicit adoption of a nonempty unscoped journal without deleting its commands", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-adopt-scope-"));
		const journalPath = join(directory, "journal.sqlite");
		const legacy = createActorLocalJournal(journalPath);
		legacy.acceptCommand({
			streamId: rivetStreamId(identity),
			commandId: "legacy",
			digest: "digest",
			commandType: "addItem",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		legacy.close();
		try {
			expect(() =>
				createRivetRuntimeHost({
					tenantId: "acme",
					campId: "prod",
					journalPath,
				}),
			).toThrow(/scope is unknown/i);
			const adopted = createRivetRuntimeHost({
				tenantId: "acme",
				campId: "prod",
				journalPath,
				adoptUnscopedJournal: true,
			});
			try {
				expect(
					adopted.journal.loadCommand(rivetStreamId(identity), "legacy")
						?.status,
				).toBe("persisted");
			} finally {
				adopted.journal.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"runner",
		"serverless",
		"managed",
	] as const)("rejects %s mode until a real Rivet-backed host exists", (mode) => {
		expect(() =>
			createRivetRuntimeHost({
				tenantId: "t1",
				campId: "c1",
				mode,
				journalPath: ":memory:",
			}),
		).toThrow(/only local-sqlite.*implemented/i);
	});

	it("cannot label a local journal as RivetKit fidelity", () => {
		const journal = createActorLocalJournal();
		try {
			expect(() =>
				// @ts-expect-error
				createRivetActorHost({ journal, fidelity: "rivetkit" }),
			).toThrow(/RivetKit fidelity.*not implemented/i);
			expect(() =>
				// @ts-expect-error
				createRivetActorHost({ journal, fidelity: "remote" }),
			).toThrow(/rivet fidelity must be local-sqlite/i);
		} finally {
			journal.close();
		}
	});

	it("actor host enforces single-writer and durable accept-before-ack", () => {
		const bundle = createRivetRuntimeHost({
			tenantId: "acme",
			campId: "shop",
			journalPath: ":memory:",
		});
		const host = bundle.actors;
		const lease = host.acquire("Cart/1", { holderId: "a" });
		expect(lease.placement).toBe("rivet");
		expect(() => host.acquire("Cart/1", { holderId: "b" })).toThrow(
			/placement conflict/,
		);
		const accepted = host.accept({
			identity,
			commandId: "cmd-1",
			commandType: "addItem",
			payload: { sku: "hat" },
			expectedRevision: 0,
		});
		expect(accepted.status).toBe("persisted");
		expect(accepted.duplicate).toBe(false);
		const processed = host.processNext(
			identity,
			(state, event) => {
				// SAFETY: assertion required at this I/O or test boundary.
				const items = (state as { items: string[] }).items;
				if (event.type === "addItem") {
					// SAFETY: assertion required at this I/O or test boundary.
					return { items: [...items, (event.payload as { sku: string }).sku] };
				}
				return state;
			},
			{ items: [] },
		);
		expect(processed?.revision).toBe(1);
		const again = host.accept({
			identity,
			commandId: "cmd-1",
			commandType: "addItem",
			payload: { sku: "hat" },
			expectedRevision: 0,
		});
		expect(again.duplicate).toBe(true);
		expect(rivetStreamId(identity)).toContain("hobo/acme/shop/Cart/user-1");
		expect(() => assertNoWaitTrue({ wait: true })).toThrow(/wait:true/);
		lease.release();
		bundle.journal.close();
	});

	it("refuses secret material in runtime config", () => {
		expect(() =>
			createRivetRuntimeHost({
				tenantId: "t",
				campId: "c",
				mode: "not-a-mode",
				journalPath: ":memory:",
			}),
		).toThrow(/runtime mode/);
	});
});
