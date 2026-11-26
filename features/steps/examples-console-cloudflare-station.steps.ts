/**
 * Cucumber steps for features/examples-console-cloudflare-station.feature.
 * Delegates to the Playwright feature runner (same gate as examples:regression).
 * The runner needs `astro dev` serving EXAMPLES_BASE_URL; these steps boot it
 * themselves (and tear it down) when nothing is already listening, so a cold
 * checkout does not need a manually started dev server. The feature stamps a
 * live Cloudflare station, so it runs only under cucumber.yaml's `live`
 * profile, never in the offline `test:behavior` lane.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AfterAll, Given, Then, When, setDefaultTimeout } from "@cucumber/cucumber";

const STEP_TIMEOUT_MS = 300_000;
// Below the step timeout so a stuck run is killed and reported, not orphaned.
const FEATURE_TIMEOUT_MS = 270_000;
// astro dev is ready in about a second; this bounds a dev server that never binds.
const READY_TIMEOUT_MS = 60_000;
setDefaultTimeout(STEP_TIMEOUT_MS);

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(
	REPO_ROOT,
	"site/scripts/examples-console-regression.mts",
);
const BASE_URL = process.env.EXAMPLES_BASE_URL ?? "http://127.0.0.1:4321/HoBo/";
const HEALTH_URL = new URL("api/cf-temp", BASE_URL).toString();
const { hostname: DEV_HOST, port: DEV_PORT } = new URL(BASE_URL);

let featurePassed = false;
let devServer: ChildProcess | undefined;
let devServerFailure = "";

const execFileAsync = promisify(execFile);

async function healthOk(): Promise<boolean> {
	try {
		const response = await fetch(HEALTH_URL);
		return response.ok;
	} catch {
		return false;
	}
}

async function ensureDevServer(): Promise<void> {
	if (await healthOk()) return;
	if (!devServer) {
		try {
			await execFileAsync(
				"pnpm",
				[
					"--filter",
					"@hobo/wasp",
					"--filter",
					"@hobo/convex",
					"--filter",
					"@hobo/provider-convex",
					"build",
				],
				{ cwd: REPO_ROOT, env: process.env, timeout: 180_000 },
			);
		} catch (error) {
			throw new Error(`site dependency build failed: ${String(error)}`);
		}
		// Bind where the health probe looks: `astro dev` defaults to `localhost`,
		// which resolves to ::1 first on Debian and Node >= 17, so a 127.0.0.1
		// probe never connects.
		devServer = spawn(
			"pnpm",
			[
				"--filter",
				"hobo-site",
				"run",
				"dev",
				"--host",
				DEV_HOST.replace(/^\[|\]$/gu, ""),
				"--port",
				DEV_PORT || "4321",
			],
			{
				cwd: REPO_ROOT,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			},
		);
		const collect = (chunk: Buffer) => {
			devServerFailure = `${devServerFailure}${chunk.toString("utf8")}`.slice(
				-4000,
			);
		};
		devServer.stdout?.on("data", collect);
		devServer.stderr?.on("data", collect);
		devServer.on("error", (error) => {
			devServerFailure = String(error);
			devServer = undefined;
		});
		devServer.on("exit", (code, signal) => {
			devServerFailure =
				devServerFailure || `astro dev exited ${code ?? signal ?? "unknown"}`;
			devServer = undefined;
		});
	}
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await healthOk()) return;
		if (!devServer) {
			throw new Error(`astro dev failed to start: ${devServerFailure}`);
		}
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000));
	}
	throw new Error(
		`astro dev never became healthy at ${HEALTH_URL} within ${READY_TIMEOUT_MS / 1000}s — start it manually with \`pnpm --filter hobo-site run dev --host ${DEV_HOST}\`\n${devServerFailure}`,
	);
}

AfterAll(() => {
	if (devServer?.pid !== undefined) {
		try {
			process.kill(-devServer.pid, "SIGTERM");
		} catch {
			devServer.kill("SIGTERM");
		}
	}
});

async function runPlaywrightFeature(): Promise<void> {
	if (featurePassed) return;
	await ensureDevServer();
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
			cwd: REPO_ROOT,
			env: process.env,
			stdio: "inherit",
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`examples-console Playwright feature exceeded ${FEATURE_TIMEOUT_MS / 1000}s and was killed`,
				),
			);
		}, FEATURE_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				featurePassed = true;
				resolve();
				return;
			}
			reject(new Error(`examples-console Playwright feature exited ${code}`));
		});
	});
}

Given(
	"yard deploy surfaces forbid waspApp cli and Bindle app packaging",
	async () => {
		await runPlaywrightFeature();
	},
);

Given("the examples console is open on the static site", async () => {
	await runPlaywrightFeature();
});

When("the operator selects the Cloudflare yard", async () => {
	await runPlaywrightFeature();
});

Then("Stage Source shows the Cloudflare stationBootstrap surface", async () => {
	await runPlaywrightFeature();
});

When("the operator deploys stations for Cloudflare", async () => {
	await runPlaywrightFeature();
});

Then("an anonymous Cloudflare Environment Station is ready", async () => {
	await runPlaywrightFeature();
});

Then(
	"an anonymous Cloudflare Environment Station is ready on workers.dev",
	async () => {
		await runPlaywrightFeature();
	},
);

Then(
	"Playwright can navigate to the station URL and read health",
	async () => {
		await runPlaywrightFeature();
	},
);

Then("Ship is unlocked without requiring examples:bridge", async () => {
	await runPlaywrightFeature();
});
