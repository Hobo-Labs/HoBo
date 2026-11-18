import { expect, it } from "vitest";
import { createLocalServeScope } from "../src/local-serve-scope.js";

it("keeps a later serving scope active when an earlier one closes", async () => {
	const key = "HOBO_TEST_LOCAL_SERVE_SCOPE";
	const original = process.env[key];
	const first = createLocalServeScope();
	const second = createLocalServeScope();
	try {
		process.env[key] = "original";
		first.setEnv(key, "first");
		second.setEnv(key, "second");
		await first.close();
		expect(process.env[key]).toBe("second");
		await second.close();
		expect(process.env[key]).toBe("original");
	} finally {
		await first.close();
		await second.close();
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

it("does not overwrite an external change while scopes close", async () => {
	const key = "HOBO_TEST_LOCAL_SERVE_EXTERNAL";
	const original = process.env[key];
	const first = createLocalServeScope();
	const second = createLocalServeScope();
	try {
		first.setEnv(key, "first");
		second.setEnv(key, "second");
		process.env[key] = "external";
		await second.close();
		await first.close();
		expect(process.env[key]).toBe("external");
	} finally {
		await second.close();
		await first.close();
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

it("runs all cleanups in reverse order and restores the environment after a failure", async () => {
	const key = "HOBO_TEST_LOCAL_SERVE_CLEANUP";
	const original = process.env[key];
	const scope = createLocalServeScope();
	const seen: string[] = [];
	try {
		process.env[key] = "original";
		scope.setEnv(key, "active");
		scope.defer(() => {
			seen.push("first");
		});
		scope.defer(() => {
			seen.push("second");
			throw new Error("cleanup failed");
		});
		await expect(scope.close()).rejects.toThrow("cleanup failed");
		expect(seen).toEqual(["second", "first"]);
		expect(process.env[key]).toBe("original");
		await expect(scope.close()).rejects.toThrow("cleanup failed");
		expect(seen).toEqual(["second", "first"]);
	} finally {
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

it("restores an external value when a surviving scope writes again", async () => {
	const key = "HOBO_TEST_LOCAL_SERVE_REWRITE";
	const original = process.env[key];
	const first = createLocalServeScope();
	const second = createLocalServeScope();
	try {
		first.setEnv(key, "first");
		second.setEnv(key, "second");
		process.env[key] = "first";
		await second.close();
		first.setEnv(key, "replacement");
		await first.close();
		expect(process.env[key]).toBe("first");
	} finally {
		await second.close();
		await first.close();
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});
