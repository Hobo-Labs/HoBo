import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHoboCli } from "@hobo/cli";
import { afterEach, expect, it, vi } from "vitest";
import { initBareMetalYard } from "../src/bare-metal-yard.js";
import {
	createLocalDeploymentDownCommand,
	startLocalDeployment,
} from "../src/local-deployment.js";
import { localDeploymentLogPath } from "../src/local-deployment-log.js";
import { createLogsCommand } from "../src/logs-command.js";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryProject() {
	const project = await mkdtemp(join(tmpdir(), "hobo-logs-"));
	directories.push(project);
	await mkdir(join(project, "src"));
	await writeFile(
		join(project, "package.json"),
		JSON.stringify({ type: "module" }),
	);
	return project;
}

function cli() {
	return createHoboCli({
		commands: {
			logs: createLogsCommand(),
			down: createLocalDeploymentDownCommand(),
		},
	});
}

it("reports no log history without starting a demo deployment", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	const result = await cli().run(["logs", "--json"], { cwd: project });
	const envelope = JSON.parse(result.stdout);
	expect(result.exitCode).toBe(0);
	expect(envelope.status).toBe("no_history");
	expect(envelope.data.lines).toEqual([]);
});

it("returns the most recent real log lines for the selected project", async () => {
	const project = await temporaryProject();
	await writeFile(join(project, "hobo.bindle.json"), "{}\n");
	await mkdir(join(project, ".hobo"));
	await writeFile(
		localDeploymentLogPath(project),
		`${Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n")}\n`,
	);
	const result = await cli().run(["logs", "--json"], { cwd: project });
	const envelope = JSON.parse(result.stdout);
	expect(result.exitCode).toBe(0);
	expect(envelope.status).toBe("tailed");
	expect(envelope.data.lines).toHaveLength(200);
	expect(envelope.data.lines[0]).toBe("line-5");
	expect(envelope.data.lines.at(-1)).toBe("line-204");
	expect(envelope.data.truncated).toBe(true);
});

it("reads the running deployment's application output and component events", async () => {
	const project = await temporaryProject();
	const hoboHome = join(project, "home");
	const bindles = fileURLToPath(
		new URL("../../bindles/dist/index.js", import.meta.url),
	);
	await writeFile(
		join(project, "src/bindle.mjs"),
		`import { bindle } from ${JSON.stringify(bindles)};
export default bindle("logs-app", b => ({ web: b.web(() => request => {
  console.log("actual-app-request", new URL(request.url).pathname);
  return new Response("actual app");
}) }));
`,
	);
	initBareMetalYard({ hoboHome, componentHost: "local" });
	vi.stubEnv("HOBO_PORTLESS", "0");
	const shell = cli();
	let started = false;
	try {
		const deployment = await startLocalDeployment({
			projectDir: project,
			hoboHome,
			componentHost: "local",
			campId: "logs-camp",
			providerId: "bare-metal",
			brokerId: "local",
			bindleName: "logs-app",
			port: 0,
			ttlSeconds: 0,
		});
		started = true;
		const response = await fetch(
			`${deployment.receipt.primaryUrl.replace(/\/$/u, "")}/real-activity`,
		);
		expect(await response.text()).toBe("actual app");
		const result = await shell.run(["logs", "--json"], { cwd: project });
		const envelope = JSON.parse(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(envelope.data.lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("actual-app-request /real-activity"),
				expect.stringContaining('"type":"component.Invoked"'),
			]),
		);
	} finally {
		if (started) {
			const down = await shell.run(["down", "--json"], { cwd: project });
			expect(down.exitCode).toBe(0);
		}
	}
}, 90_000);
