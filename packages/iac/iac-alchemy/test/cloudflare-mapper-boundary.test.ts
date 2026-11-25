import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	cloudflareBindleMappers,
	cloudflareViteApp,
} from "../src/cloudflare.js";

it("retains Vite entrypoint identity when WeakMap methods are replaced", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-cf-vite-"));
	mkdirSync(join(directory, "site"));
	const mappers = cloudflareBindleMappers({
		workerModules: {},
		projectRoot: directory,
		sourceFence: {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "test:isolated-runtime",
			verify: () => true,
		},
	});
	const validate = mappers.web.validate;
	if (validate === undefined) throw new Error("missing Vite validator");
	const weakGet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
	const weakSet = Object.getOwnPropertyDescriptor(WeakMap.prototype, "set");
	if (weakGet === undefined || weakSet === undefined)
		throw new Error("missing native WeakMap methods");
	let traps = 0;
	let legitError: unknown;
	let forgedError: unknown;
	try {
		Object.defineProperty(WeakMap.prototype, "get", {
			...weakGet,
			value() {
				traps++;
				return "site";
			},
		});
		Object.defineProperty(WeakMap.prototype, "set", {
			...weakSet,
			value() {
				traps++;
				return this;
			},
		});
		const marker = cloudflareViteApp("site");
		const input = {
			bindleName: "shop",
			requirements: {},
			declaration: {
				kind: "web",
				name: "web",
				stableId: "web:web",
				declaredAllow: [],
				dependsOn: [],
				annotations: [
					{
						provider: "hobo",
						option: "webapp",
						config: { framework: "vite", root: "site" },
					},
					{
						provider: "hobo",
						option: "session-replay",
						config: { enabled: false },
					},
				],
			},
			dependencyDeclarations: {},
			entrypoint: marker,
		};
		try {
			validate(input);
		} catch (error) {
			legitError = error;
		}
		try {
			validate({
				...input,
				entrypoint: () => {
					throw new Error("forged");
				},
			});
		} catch (error) {
			forgedError = error;
		}
	} finally {
		Object.defineProperty(WeakMap.prototype, "get", weakGet);
		Object.defineProperty(WeakMap.prototype, "set", weakSet);
		rmSync(directory, { recursive: true, force: true });
	}
	expect(legitError).toBeUndefined();
	expect(forgedError).toMatchObject({ code: "ENTRYPOINT_UNSUPPORTED" });
	expect(traps).toBe(0);
});
