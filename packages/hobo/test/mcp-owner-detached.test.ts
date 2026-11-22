import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { OwnerStoreOperationUncertainError } from "@hobo/hobo-ci";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeHoboMcp } from "../src/mcp-serve.js";
import { supportsOwnerGuard } from "./support/owner-guard-support.js";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "hobo-owner-detached-"));
	vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function session() {
	return composeHoboMcp({
		output: new PassThrough(),
		projectDir: home,
		remote: true,
	});
}

describe.runIf(supportsOwnerGuard())("detached owner writes", () => {
	for (const [outerFamily, innerFamily] of [
		["ci", "cd"],
		["cd", "ci"],
	] as const) {
		it(`holds ${outerFamily} while a detached ${innerFamily} write runs`, async () => {
			const first = session();
			const second = session();
			const release = deferred();
			const entered = deferred();
			try {
				const outer = first.owner.storeSettingsFor?.(outerFamily, home);
				const inner = first.owner.storeSettingsFor?.(innerFamily, home);
				const outerPeer = second.owner.storeSettingsFor?.(outerFamily, home);
				const innerPeer = second.owner.storeSettingsFor?.(innerFamily, home);
				if (
					!outer?.runStoreWrite ||
					!inner?.runStoreWrite ||
					!outerPeer?.runStoreWrite ||
					!innerPeer?.runStoreWrite
				)
					throw new Error("No owner guards.");
				const writer = outer.runStoreWrite(async () => {
					void inner.runStoreWrite?.(async () => {
						entered.resolve();
						await release.promise;
					});
					await entered.promise;
				});
				await entered.promise;
				const state = await Promise.race([
					writer.then(() => "finished"),
					new Promise<string>((resolve) =>
						setTimeout(() => resolve("pending"), 30),
					),
				]);
				expect(state).toBe("pending");
				expect(() => outerPeer.assertCurrent?.()).toThrow(
					OwnerStoreOperationUncertainError,
				);
				expect(() => innerPeer.assertCurrent?.()).toThrow(
					OwnerStoreOperationUncertainError,
				);
				release.resolve();
				await writer;
				await expect(
					outerPeer.runStoreWrite(async () => "ready"),
				).resolves.toBe("ready");
				await expect(
					innerPeer.runStoreWrite(async () => "ready"),
				).resolves.toBe("ready");
			} finally {
				release.resolve();
				await first.close();
				await second.close();
			}
		});
	}

	it("fences both families when a detached cross-family effect fails", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		const entered = deferred();
		let child: Promise<void> | undefined;
		try {
			const ci = first.owner.storeSettingsFor?.("ci", home);
			const cd = first.owner.storeSettingsFor?.("cd", home);
			const ciPeer = second.owner.storeSettingsFor?.("ci", home);
			const cdPeer = second.owner.storeSettingsFor?.("cd", home);
			if (!ci?.runStoreWrite || !cd?.runStoreWrite || !ciPeer || !cdPeer)
				throw new Error("No owner guards.");
			const writer = ci.runStoreWrite(async () => {
				child = cd.runStoreWrite?.(async () => {
					entered.resolve();
					await release.promise;
					throw new Error("synthetic provider failure");
				});
				await entered.promise;
			});
			const failure = expect(writer).rejects.toBeInstanceOf(
				OwnerStoreOperationUncertainError,
			);
			await entered.promise;
			release.resolve();
			await failure;
			expect(() => ciPeer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
			expect(() => cdPeer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			release.resolve();
			await child?.catch(() => undefined);
			await first.close();
			await second.close();
		}
	});

	it("does not fence an ancestor for a pre-dispatch cross-family refusal", async () => {
		const first = session();
		const second = session();
		try {
			const ci = first.owner.storeSettingsFor?.("ci", home);
			const cd = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("ci", home);
			if (!ci?.runStoreWrite || !cd?.runStoreWrite || !peer?.runStoreWrite)
				throw new Error("No owner guards.");
			let dispatched = false;
			await ci.runStoreWrite(async () => {
				await expect(
					cd.runStoreWrite?.(
						async () => {
							dispatched = true;
						},
						() => {
							throw new Error("synthetic refusal");
						},
					),
				).rejects.toThrow(/synthetic refusal/u);
			});
			expect(dispatched).toBe(false);
			await expect(peer.runStoreWrite(async () => "ready")).resolves.toBe(
				"ready",
			);
		} finally {
			await first.close();
			await second.close();
		}
	});

	it("allows an active descendant to reenter its retained ancestor", async () => {
		const first = session();
		const second = session();
		const proceed = deferred();
		const release = deferred();
		const entered = deferred();
		const nested = deferred();
		try {
			const ci = first.owner.storeSettingsFor?.("ci", home);
			const cd = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("ci", home);
			if (!ci?.runStoreWrite || !cd?.runStoreWrite || !peer)
				throw new Error("No owner guards.");
			const writer = ci.runStoreWrite(async () => {
				void cd.runStoreWrite?.(async () => {
					entered.resolve();
					await proceed.promise;
					await ci.runStoreWrite?.(async () => {
						nested.resolve();
						await release.promise;
					});
				});
				await entered.promise;
			});
			await entered.promise;
			proceed.resolve();
			await nested.promise;
			expect(() => peer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
			release.resolve();
			await writer;
		} finally {
			proceed.resolve();
			release.resolve();
			await first.close();
			await second.close();
		}
	});

	it("revalidates CI and CD while a second CD handle reenters both scopes", async () => {
		const first = session();
		try {
			const ci = first.owner.storeSettingsFor?.("ci", home);
			const cd = first.owner.storeSettingsFor?.("cd", home);
			const barrier = first.owner.storeSettingsFor?.("cd", home);
			if (
				!ci?.runStoreWrite ||
				!ci.selectionRevision ||
				!cd?.runStoreWrite ||
				!cd.selectionRevision ||
				!barrier?.runStoreWrite
			)
				throw new Error("No scoped owner guards.");
			const ciRevision = ci.selectionRevision();
			const cdRevision = cd.selectionRevision();
			let checks = 0;
			let dispatched = false;
			await ci.runStoreWrite(async () => {
				await cd.runStoreWrite?.(async () => {
					await barrier.runStoreWrite?.(
						async () => {
							dispatched = true;
						},
						() => {
							checks++;
							if (
								ci.selectionRevision?.() !== ciRevision ||
								cd.selectionRevision?.() !== cdRevision
							)
								throw new Error("synthetic authority changed");
							return true;
						},
					);
				});
			});
			expect(checks).toBe(2);
			expect(dispatched).toBe(true);
		} finally {
			await first.close();
		}
	});

	it("keeps both families fenced when a detached cross-family effect is canceled", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		const entered = deferred();
		let child: Promise<void> | undefined;
		try {
			const ci = first.owner.storeSettingsFor?.("ci", home);
			const cd = first.owner.storeSettingsFor?.("cd", home);
			const ciPeer = second.owner.storeSettingsFor?.("ci", home);
			const cdPeer = second.owner.storeSettingsFor?.("cd", home);
			if (!ci?.runStoreWrite || !cd?.runStoreWrite || !ciPeer || !cdPeer)
				throw new Error("No scoped owner guards.");
			const writer = ci.runStoreWrite(async () => {
				child = cd.runStoreWrite?.(async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
			});
			const canceled = expect(writer).rejects.toThrow(/session changed/u);
			await entered.promise;
			await first.close();
			await canceled;
			expect(() => ciPeer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
			expect(() => cdPeer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			release.resolve();
			await child?.catch(() => undefined);
			await first.close();
			await second.close();
		}
	});

	it("holds the outer nonce until detached nested descendants complete", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		const entered = deferred();
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !peer?.runStoreWrite)
				throw new Error("No owner guard.");
			const writer = settings.runStoreWrite(async () => {
				void settings.runStoreWrite?.(async () => {
					void settings.runStoreWrite?.(async () => {
						entered.resolve();
						await release.promise;
					});
					await entered.promise;
				});
				await entered.promise;
			});
			await entered.promise;
			const state = await Promise.race([
				writer.then(() => "finished"),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("pending"), 30),
				),
			]);
			expect(state).toBe("pending");
			expect(() => peer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
			release.resolve();
			await writer;
			await expect(peer.runStoreWrite(async () => "ready")).resolves.toBe(
				"ready",
			);
		} finally {
			release.resolve();
			await first.close();
			await second.close();
		}
	});

	it("retains uncertainty even if a started nested failure is caught", async () => {
		const first = session();
		const second = session();
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !peer) throw new Error("No owner guard.");
			await expect(
				settings.runStoreWrite(async () => {
					try {
						await settings.runStoreWrite?.(async () => {
							throw new Error("synthetic failure");
						});
					} catch {}
				}),
			).rejects.toBeInstanceOf(OwnerStoreOperationUncertainError);
			expect(() => peer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			await first.close();
			await second.close();
		}
	});

	it("retains uncertainty when a detached nested effect fails", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		const entered = deferred();
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !peer) throw new Error("No owner guard.");
			const writer = settings.runStoreWrite(async () => {
				void settings.runStoreWrite?.(async () => {
					entered.resolve();
					await release.promise;
					throw new Error("synthetic provider failure");
				});
				await entered.promise;
			});
			const failure = expect(writer).rejects.toBeInstanceOf(
				OwnerStoreOperationUncertainError,
			);
			await entered.promise;
			release.resolve();
			await failure;
			expect(() => peer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			release.resolve();
			await first.close();
			await second.close();
		}
	});

	it("cancels a detached writer while keeping its in-flight effect fenced", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		const entered = deferred();
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !peer) throw new Error("No owner guard.");
			const writer = settings.runStoreWrite(async () => {
				void settings.runStoreWrite?.(async () => {
					entered.resolve();
					await release.promise;
				});
				await entered.promise;
			});
			const failure = expect(writer).rejects.toThrow(/session changed/u);
			await entered.promise;
			await first.close();
			await failure;
			expect(() => peer.assertCurrent?.()).toThrow(
				OwnerStoreOperationUncertainError,
			);
		} finally {
			release.resolve();
			await first.close();
			await second.close();
		}
	});

	it("rejects work inherited from a closed write scope", async () => {
		const first = session();
		const second = session();
		const release = deferred();
		try {
			const settings = first.owner.storeSettingsFor?.("cd", home);
			const peer = second.owner.storeSettingsFor?.("cd", home);
			if (!settings?.runStoreWrite || !peer?.runStoreWrite)
				throw new Error("No owner guard.");
			let dispatched = false;
			let late: Promise<void> = Promise.resolve();
			await settings.runStoreWrite(async () => {
				late = release.promise.then(async () => {
					await settings.runStoreWrite?.(async () => {
						dispatched = true;
					});
				});
			});
			release.resolve();
			await expect(late).rejects.toThrow(/write scope has closed/u);
			expect(dispatched).toBe(false);
			await expect(peer.runStoreWrite(async () => "ready")).resolves.toBe(
				"ready",
			);
		} finally {
			release.resolve();
			await first.close();
			await second.close();
		}
	});
});
