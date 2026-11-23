import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as z from "zod";

const harnesses = [".agents", ".claude", ".cursor", ".github"];

async function storeModule(harness: string) {
	const file = resolve(
		`${harness}/skills/impeccable/scripts/live/session-store.mjs`,
	);
	return import(pathToFileURL(file).href);
}

for (const harness of harnesses) {
	test(`${harness} preserves independent revisions and migrates legacy snapshots`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-live-revisions-"));
		try {
			const { createLiveSessionStore } = await storeModule(harness);
			let store = createLiveSessionStore({
				cwd: directory,
				sessionId: "session",
			});
			store.appendEvent({ type: "generate", count: 2 });
			store.appendEvent({
				type: "checkpoint",
				revision: 8,
				owner: "old",
				visibleVariant: 1,
			});
			store.appendEvent({
				type: "checkpoint",
				revision: 20,
				revisionDomain: "publication",
				arrivedVariants: 2,
			});
			let snapshot = store.getSnapshot();
			assert.equal(snapshot.browserCheckpointRevision, 8);
			assert.equal(snapshot.checkpointRevision, 8);
			assert.equal(snapshot.publicationCheckpointRevision, 20);
			assert.equal(snapshot.visibleVariant, 1);
			const snapshotPath = join(store.rootDir, "session.snapshot.json");
			const saved = JSON.parse(readFileSync(snapshotPath, "utf8"));
			assert.equal("checkpointRevision" in saved, false);
			saved.checkpointRevision = saved.browserCheckpointRevision;
			delete saved.browserCheckpointRevision;
			writeFileSync(snapshotPath, JSON.stringify(saved));
			store = createLiveSessionStore({ cwd: directory, sessionId: "session" });
			snapshot = store.getSnapshot();
			assert.equal(snapshot.browserCheckpointRevision, 8);
			assert.equal(snapshot.checkpointRevision, 8);
			assert.equal(snapshot.publicationCheckpointRevision, 20);
			store.appendEvent({
				type: "checkpoint",
				revision: 7,
				owner: "stale",
				visibleVariant: 2,
			});
			snapshot = store.appendEvent({
				type: "checkpoint",
				revision: 9,
				owner: "new",
				visibleVariant: 2,
			});
			assert.equal(snapshot.browserCheckpointRevision, 9);
			assert.equal(snapshot.checkpointRevision, 9);
			assert.equal(snapshot.publicationCheckpointRevision, 20);
			assert.equal(snapshot.visibleVariant, 2);
			assert.equal(snapshot.activeOwner, "new");
			assert.equal(
				snapshot.diagnostics.at(-1)?.error,
				"stale_checkpoint_ignored",
			);
			assert.equal(
				"checkpointRevision" in JSON.parse(readFileSync(snapshotPath, "utf8")),
				false,
			);
			assert.equal(store.flush().checkpointRevision, 9);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

async function waitFor<T>(
	read: () => T | undefined,
	timeout = 10000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error("Timed out waiting for live session recovery");
}

for (const withWrapper of [true, false]) {
	test(`a fresh browser recovers its revision ${withWrapper ? "with" : "without"} an existing wrapper`, {
		timeout: 30000,
	}, async (t) => {
		const { chromium } = await import("playwright");
		if (!existsSync(chromium.executablePath())) {
			t.skip("Playwright Chromium is not installed");
			return;
		}
		const directory = mkdtempSync(join(tmpdir(), "hobo-live-browser-"));
		const { createLiveSessionStore } = await storeModule(".agents");
		const store = createLiveSessionStore({
			cwd: directory,
			sessionId: "abcdef12",
		});
		store.appendEvent({ type: "generate", pageUrl: "/", count: 1 });
		store.appendEvent({
			type: "checkpoint",
			revision: 9,
			owner: "old",
			phase: "cycling",
			visibleVariant: 1,
			sourceFile: "component.html",
		});
		writeFileSync(join(directory, "component.html"), "<main>Variant</main>");
		store.appendEvent({
			type: "checkpoint",
			revision: 25,
			revisionDomain: "publication",
			arrivedVariants: 1,
		});
		const serverScript = resolve(
			".agents/skills/impeccable/scripts/live-server.mjs",
		);
		const child = spawn(process.execPath, [serverScript], {
			cwd: directory,
			stdio: "ignore",
		});
		let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
		const app = createServer();
		try {
			const infoPath = join(directory, ".impeccable/live/server.json");
			const info = await waitFor(() => {
				try {
					return JSON.parse(readFileSync(infoPath, "utf8"));
				} catch {
					return undefined;
				}
			});
			app.on("request", (_request, response) => {
				response.setHeader("content-type", "text/html");
				const wrapper = withWrapper
					? '<main data-impeccable-variants="abcdef12" data-impeccable-variant-count="1"><div data-impeccable-variant="1">Variant</div></main>'
					: "<main>Variant</main>";
				response.end(
					`<html><body>${wrapper}<script src="http://localhost:${info.port}/live.js?token=${info.token}"></script></body></html>`,
				);
			});
			app.listen(0, "127.0.0.1");
			await once(app, "listening");
			const address = z.object({ port: z.number() }).parse(app.address());
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${address.port}/`);
			const recovered = await waitFor(() => {
				const snapshot = store.getSnapshot();
				return snapshot.browserCheckpointRevision > 9 ? snapshot : undefined;
			});
			assert.equal(
				recovered.checkpointRevision,
				recovered.browserCheckpointRevision,
			);
			assert.equal(recovered.browserCheckpointRevision, 10);
			assert.equal(recovered.publicationCheckpointRevision, 25);
			assert.notEqual(recovered.activeOwner, "old");
			const status = z
				.object({
					activeSessions: z.array(
						z.object({
							checkpointRevision: z.number(),
							browserCheckpointRevision: z.number(),
						}),
					),
				})
				.parse(
					await fetch(
						`http://localhost:${info.port}/status?token=${info.token}`,
					).then((response) => response.json()),
				);
			const summary = status.activeSessions[0];
			assert(summary);
			assert.equal(summary.checkpointRevision, 10);
			assert.equal(summary.browserCheckpointRevision, 10);
		} finally {
			await browser?.close();
			if (app.listening)
				await new Promise<void>((resolveClose) =>
					app.close(() => resolveClose()),
				);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await once(child, "exit");
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
