import { open, readFile, unlink, writeFile } from "node:fs/promises";
import {
	createSandboxProxyVmServer,
	installProxyFatalErrorHandler,
	parseProxyVmConfig,
} from "./sandbox-proxy-vm.js";

const configPath = "/vercel/sandbox/.hobo-ci-proxy-config.json";
const failurePath = "/vercel/sandbox/.hobo-ci-proxy-failure";
const noncePath = "/vercel/sandbox/.hobo-ci-proxy-nonce";
const readyPath = "/vercel/sandbox/.hobo-ci-proxy-ready";
type StartupStage = "marker" | "read_config" | "parse_config" | "listen";
let stage: StartupStage = "marker";
async function fail(failed: StartupStage) {
	// Only a fixed stage is emitted. Config, tokens and exception text stay private.
	await writeFile(failurePath, failed, { mode: 0o600 }).catch(() => undefined);
	try {
		process.stderr.write(
			`${JSON.stringify({ event: "hobo_ci_proxy_start_failure", stage: failed })}\n`,
		);
	} catch {
		// Telemetry must not change shutdown.
	}
	process.exitCode = 1;
}
try {
	// A persistent external intent still fences launch; this guard prevents a
	// second process from consuming a re-uploaded credential in the same VM.
	const marker = await open(
		"/vercel/sandbox/.hobo-ci-proxy-started",
		"wx",
		0o600,
	);
	await marker.close();
	stage = "read_config";
	const raw = await readFile(configPath, "utf8");
	const nonce = await readFile(noncePath, "utf8");
	await unlink(configPath);
	await unlink(noncePath);
	stage = "parse_config";
	if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("invalid readiness nonce");
	const config = parseProxyVmConfig(JSON.parse(raw));
	const server = createSandboxProxyVmServer(config);
	stage = "listen";
	// A failed listener must not continue serving a partially broken proxy.
	installProxyFatalErrorHandler(server, () => fail("listen"));
	server.once("listening", () => {
		void writeFile(readyPath, nonce, { mode: 0o600 }).catch(() =>
			fail("listen").finally(() => process.exit(1)),
		);
	});
	server.listen(config.port, "0.0.0.0");
} catch {
	await unlink(configPath).catch(() => undefined);
	await unlink(noncePath).catch(() => undefined);
	await fail(stage);
}
