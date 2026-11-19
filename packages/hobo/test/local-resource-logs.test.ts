import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, it } from "vitest";
import {
	installLocalResourceLogCapture,
	localLogResourcesPath,
	localResourceLogPath,
	registerLocalLogResources,
	withLocalResource,
} from "../src/local-resource-logs.js";

it("captures concurrent resource stdout and stderr without mixing output", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "hobo-resource-logs-"));
	const output: string[] = [];
	const stdout = new Writable({
		write(chunk, _encoding, done) {
			output.push(chunk.toString());
			done();
		},
	});
	const stderr = new Writable({
		write(chunk, _encoding, done) {
			output.push(chunk.toString());
			done();
		},
	});
	const original = stdout.write;
	const capture = installLocalResourceLogCapture({
		projectDir,
		stdout,
		stderr,
	});
	try {
		registerLocalLogResources(["web", "api"]);
		stdout.write("host\n");
		await Promise.all([
			withLocalResource("web", async () => {
				stdout.write("hello ");
				await new Promise<void>((resolve) => setImmediate(resolve));
				stdout.write("world\n");
			}),
			withLocalResource("api", async () => {
				stderr.write("failure\n");
				await new Promise<void>((resolve) => setImmediate(resolve));
				stdout.write(Buffer.from("reply\n"));
				await new Promise<void>((resolve, reject) =>
					stdout.write("f09f9880", "hex", (error) =>
						error ? reject(error) : resolve(),
					),
				);
			}),
		]);
		expect(
			JSON.parse(await readFile(localLogResourcesPath(projectDir), "utf8")),
		).toEqual({ names: ["api", "web"] });
		expect(
			await readFile(localResourceLogPath(projectDir, "web"), "utf8"),
		).toBe("hello world\n");
		expect(
			await readFile(localResourceLogPath(projectDir, "api"), "utf8"),
		).toBe("failure\nreply\n😀");
		expect(output.join("")).toContain("host\n");
	} finally {
		capture.close();
		await rm(projectDir, { recursive: true, force: true });
	}
	expect(stdout.write).toBe(original);
});
