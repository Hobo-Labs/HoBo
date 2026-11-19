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
  const api = b.api(() => { process.env.HOBO_TEST_CYCLE_INITIALIZED = "yes"; return () => new Response("api"); });
  const web = b.web(() => () => new Response("web"));
  api.dependsOn(web);
  web.dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_TEST_CYCLE_INITIALIZED", "no");
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
	expect(process.env.HOBO_TEST_CYCLE_INITIALIZED).toBe("no");
});

it("injects a dependency address before its consumer is initialized", async () => {
	const directory = await project(`export default bindle("startup-app", b => {
  const api = b.api(() => {
    const value = process.env.HOBO_TEST_STARTUP_VALUE;
    if (value !== "available") throw new Error("missing bindle environment");
    return () => new Response(value);
  }).with({ provider: "hobo", option: "env", config: { HOBO_TEST_STARTUP_VALUE: "available" } });
  const web = b.web(() => {
    const apiUrl = process.env.services__api__http__0;
    if (!apiUrl || apiUrl === "previous") throw new Error("missing api address");
    return () => fetch(apiUrl);
  }).dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	vi.stubEnv("HOBO_TEST_STARTUP_VALUE", "old-value");
	vi.stubEnv("services__api__http__0", "previous");
	vi.stubEnv("services__api__http__0__named", "previous-named");
	vi.stubEnv("HOBO_NAMED_API_URL", "previous-url");
	const running = await serveBindleOnLocalYard({
		projectDir: directory,
		hoboHome,
		port: 0,
	});
	try {
		expect(await (await fetch(running.primaryUrl)).text()).toBe("available");
	} finally {
		await running.close();
	}
	expect(process.env.HOBO_TEST_STARTUP_VALUE).toBe("old-value");
	expect(process.env.services__api__http__0).toBe("previous");
	expect(process.env.services__api__http__0__named).toBe("previous-named");
	expect(process.env.HOBO_NAMED_API_URL).toBe("previous-url");
});

it("tears down started dependencies and restores the environment when startup fails", async () => {
	const directory =
		await project(`export default bindle("failed-startup-app", b => {
  const api = b.api(() => () => new Response("api"));
  const web = b.web(() => { throw new Error("startup failed"); }).dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("services__api__http__0", "previous");
	const previousFetch = globalThis.fetch;
	const events: Array<{ type: string; componentId: string }> = [];
	await expect(
		serveBindleOnLocalYard({
			projectDir: directory,
			hoboHome,
			port: 0,
			emitProgress: (line) => {
				if (!line.startsWith("{")) return;
				const event = JSON.parse(line);
				if (event.type && event.componentId) events.push(event);
			},
		}),
	).rejects.toThrow("startup failed");
	expect(
		events.map(({ type, componentId }) => `${type}:${componentId}`),
	).toEqual(["component.Loaded:api", "component.TornDown:api"]);
	expect(process.env.services__api__http__0).toBe("previous");
	expect(globalThis.fetch).toBe(previousFetch);
});

it("makes a public dependency reachable before initializing its consumer", async () => {
	const directory =
		await project(`export default bindle("public-dependency-app", b => {
  const backend = b.web(() => () => new Response("backend"));
  const frontend = b.web(() => {
    const address = process.env.services__backend__http__0;
    if (!address) throw new Error("missing backend address");
    return () => fetch(address);
  }).dependsOn(backend);
  return { frontend, backend };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	const running = await serveBindleOnLocalYard({
		projectDir: directory,
		hoboHome,
		port: 0,
	});
	try {
		const frontend = running.endpoints.find(
			(endpoint) => endpoint.resourceName === "frontend",
		);
		if (!frontend) throw new Error("frontend endpoint was not started");
		expect(await (await fetch(frontend.url)).text()).toBe("backend");
	} finally {
		await running.close();
	}
});

it("closes a started public dependency if its consumer cannot initialize", async () => {
	const directory =
		await project(`export default bindle("failed-public-app", b => {
  const backend = b.web(() => () => new Response("backend"));
  const frontend = b.web(() => { throw new Error("consumer failed"); }).dependsOn(backend);
  return { frontend, backend };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("services__backend__http__0", "previous");
	let backendUrl = "";
	await expect(
		serveBindleOnLocalYard({
			projectDir: directory,
			hoboHome,
			port: 0,
			emitProgress: (line) => {
				const match = /Yard exposed web:backend at (http:\/\/\S+)/.exec(line);
				if (match?.[1]) backendUrl = match[1];
			},
		}),
	).rejects.toThrow("consumer failed");
	expect(backendUrl).not.toBe("");
	await expect(fetch(backendUrl)).rejects.toThrow();
	expect(process.env.services__backend__http__0).toBe("previous");
});

it("does not initialize a consumer when its HTTP dependency has no handler", async () => {
	const directory =
		await project(`export default bindle("missing-handler-app", b => {
  const api = b.api(() => "not a handler");
  const web = b.web(() => { process.env.HOBO_TEST_CONSUMER_STARTED = "yes"; return () => new Response("web"); }).dependsOn(api);
  return { web, api };
});`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_TEST_CONSUMER_STARTED", "no");
	await expect(
		serveBindleOnLocalYard({ projectDir: directory, hoboHome, port: 0 }),
	).rejects.toThrow("local component web requires api, which did not start");
	expect(process.env.HOBO_TEST_CONSUMER_STARTED).toBe("no");
});

it("preserves session replay wrapping on initialized components", async () => {
	const directory = await project(`export default bindle("replay-app", b => ({
  web: b.web(() => () => new Response("<html><body>page</body></html>", { headers: { "content-type": "text/html" } }))
}));`);
	const hoboHome = join(directory, "home");
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	vi.stubEnv("HOBO_REPLAY", "1");
	const running = await serveBindleOnLocalYard({
		projectDir: directory,
		hoboHome,
		port: 0,
	});
	try {
		const response = await fetch(running.primaryUrl);
		expect(await response.text()).toContain('data-hobo-replay="1"');
	} finally {
		await running.close();
	}
});
