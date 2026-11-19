import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import { serveBindleOnLocalYard } from "../src/local-yard-serve.js";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function project(body: string) {
	const directory = await mkdtemp(join(tmpdir(), "hobo-local-order-"));
	directories.push(directory);
	await mkdir(join(directory, "src"));
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({ type: "module" }),
	);
	const bindles = fileURLToPath(
		new URL("../../bindles/dist/index.js", import.meta.url),
	);
	await writeFile(
		join(directory, "src/bindle.mjs"),
		`import { bindle } from ${JSON.stringify(bindles)};\n${body}\n`,
	);
	return directory;
}

it("loads dependencies before consumers and tears them down in reverse order", async () => {
	const directory = await project(`export default bindle("order-app", b => {
  const api = b.api(() => () => new Response("api"));
  const web = b.web(() => () => new Response("web")).dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	const events: Array<{ type: string; componentId: string }> = [];
	const running = await serveBindleOnLocalYard({
		projectDir: directory,
		hoboHome,
		port: 0,
		emitProgress: (line) => {
			if (!line.startsWith("{")) return;
			const event = JSON.parse(line);
			if (event.type && event.componentId) events.push(event);
		},
	});
	try {
		expect(await (await fetch(running.primaryUrl)).text()).toBe("web");
		expect(
			events
				.filter((event) => event.type === "component.Loaded")
				.map((event) => event.componentId),
		).toEqual(["api", "web"]);
	} finally {
		await running.close();
	}
	expect(
		events
			.filter((event) => event.type === "component.TornDown")
			.map((event) => event.componentId),
	).toEqual(["web", "api"]);
});

it("rejects a cycle before loading its components", async () => {
	const directory = await project(`export default bindle("cycle-app", b => {
  const api = b.api(() => () => new Response("api"));
  const web = b.web(() => () => new Response("web"));
  api.dependsOn(web);
  web.dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	const events: string[] = [];
	await expect(
		serveBindleOnLocalYard({
			projectDir: directory,
			hoboHome,
			port: 0,
			emitProgress: (line) => events.push(line),
		}),
	).rejects.toThrow(/dependency cycle/i);
	expect(
		events.some((line) => line.includes('"type":"component.Loaded"')),
	).toBe(false);
});
