import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DURABLE_MESSAGING_JSPI_INTERFACE } from "../src/durable-messaging-host.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const witRoot = join(packageRoot, "..", "wit");
const requireFromWit = createRequire(join(witRoot, "package.json"));
const jcoApi = requireFromWit.resolve("@bytecodealliance/jco");
const componentize = join(
	dirname(dirname(dirname(jcoApi))),
	"componentize-js/src/componentize.js",
);
const jcoCli = join(dirname(jcoApi), "jco.js");

it("executes a verified real JSPI component across delayed and lost replies", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hobo-messaging-jspi-"));
	try {
		const original = await readFile(
			join(
				witRoot,
				"wit/deps/hobo-durable-messaging-jspi/hobo-durable-messaging-jspi.wit",
			),
			"utf8",
		);
		const witPath = join(dir, "probe.wit");
		await writeFile(
			witPath,
			`${original}\nworld bridge-test {\n  import messaging;\n  export run: func() -> string;\n}\n`,
		);
		const guest = `import { ensureTopic, publish, consume } from '${DURABLE_MESSAGING_JSPI_INTERFACE}';
export function run() {
  const request = { operation: { id: 'v1.2000000000000.abcdefghijklmnop', expiresAtMs: 2000000000000n }, topic: 'orders' };
  const lost = ensureTopic(request);
  const replay = ensureTopic(request);
  const published = publish({ operation: { id: 'v1.2000000000000.publishnonce1234', expiresAtMs: 2000000000000n }, topic: 'orders', message: { id: 'msg', subject: 'created', payload: new Uint8Array([4, 5]), attributes: [] } });
  const received = consume({ operation: { id: 'v1.2000000000000.consumenonce1234', expiresAtMs: 2000000000000n }, topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 10n });
  return lost.tag + ':' + replay.tag + ':' + replay.val.topic + ':' + published.val.sequence + ':' + received.val[0].message.payload[0];
}`;
		const binaryPath = join(dir, "probe.wasm");
		const builderPath = join(dir, "build.mjs");
		await writeFile(
			builderPath,
			`import { componentize } from ${JSON.stringify(pathToFileURL(componentize).href)};
import { writeFile } from 'node:fs/promises';
const built = await componentize(${JSON.stringify(guest)}, { witPath: ${JSON.stringify(witPath)}, worldName: 'bridge-test', sourceName: 'guest.js', disableFeatures: ['stdio', 'random', 'clocks', 'http', 'fetch-event'], env: { XDG_CACHE_HOME: ${JSON.stringify(dir)} } });
await writeFile(${JSON.stringify(binaryPath)}, built.component);
`,
		);
		await execFileAsync(process.execPath, [builderPath], {
			cwd: packageRoot,
			timeout: 120_000,
			maxBuffer: 2_000_000,
		});
		const binary = await readFile(binaryPath);
		const digest = `sha256:${createHash("sha256").update(binary).digest("hex")}`;
		const { stdout: metadata } = await execFileAsync(
			process.execPath,
			[jcoCli, "wit", binaryPath],
			{ cwd: packageRoot, timeout: 60_000, maxBuffer: 2_000_000 },
		);
		const imports = [...metadata.matchAll(/^\s*import ([^;]+);/gmu)].map(
			(match) => match[1],
		);
		expect(imports).toEqual([DURABLE_MESSAGING_JSPI_INTERFACE]);
		const out = join(dir, "compiled");
		const operations = [
			"ensure-topic",
			"ensure-subscription",
			"publish",
			"consume",
			"ack",
			"nack",
			"compact",
			"events",
		];
		await execFileAsync(
			process.execPath,
			[
				jcoCli,
				"transpile",
				binaryPath,
				"-o",
				out,
				"--instantiation",
				"async",
				"--async-mode",
				"jspi",
				"--async-imports",
				...operations.map(
					(operation) => `${DURABLE_MESSAGING_JSPI_INTERFACE}#${operation}`,
				),
				"--async-exports",
				"run",
				"--no-wasi-shim",
			],
			{ cwd: packageRoot, timeout: 120_000, maxBuffer: 2_000_000 },
		);
		const driver = join(dir, "driver.mjs");
		const hostUrl = pathToFileURL(
			join(packageRoot, "src/durable-messaging-host.ts"),
		).href;
		const coreUrl = pathToFileURL(
			join(packageRoot, "../core/dist/index.js"),
		).href;
		const moduleUrl = pathToFileURL(join(out, "probe.js")).href;
		await writeFile(
			driver,
			`import { readFile } from 'node:fs/promises';
import { createDurableMessagingWitHost, createDurableMessagingLifecycle, createDurableMessagingLimitsGrant, instantiateDurableMessagingJspi, DURABLE_MESSAGING_JSPI_INTERFACE } from ${JSON.stringify(hostUrl)};
import { DURABLE_MESSAGING_LIMITS } from ${JSON.stringify(coreUrl)};
import { instantiate } from ${JSON.stringify(moduleUrl)};
let attempts = 0;
let durable = false;
const seen = new Map();
const claim = (method, op) => { const existing = seen.get(op.id); if (existing && existing !== method) throw new Error('conflicting operation reuse'); seen.set(op.id, method); };
const unused = async () => { throw new Error('unexpected method'); };
const port = { limits: DURABLE_MESSAGING_LIMITS, async ensureTopic(input) { claim('ensureTopic', input.operation); await new Promise((resolve) => setTimeout(resolve, 5)); attempts++; if (!durable) { durable = true; throw new Error('lost reply after commit'); } return { status: 'committed', value: { topic: input.topic } }; }, async publish(input) { claim('publish', input.operation); await new Promise((resolve) => setTimeout(resolve, 5)); if (input.message.payload[0] !== 4) throw new Error('wrong input bytes'); return { status: 'committed', value: { messageId: input.message.id, sequence: 7 } }; }, async consume(input) { claim('consume', input.operation); await new Promise((resolve) => setTimeout(resolve, 5)); return { status: 'committed', value: [{ message: { id: 'msg', subject: 'created', payload: new Uint8Array([9]), attributes: [] }, sequence: 7, topic: input.topic, consumerGroup: input.consumerGroup, leaseId: 'lease', leaseExpiresAtMs: 2000000000010, deliveryAttempt: 1 }] }; }, ensureSubscription: unused, ack: unused, nack: unused, compact: unused, events: unused };
const factory = (imports) => instantiate(async (name) => WebAssembly.compile(await readFile(new URL('./compiled/' + name, import.meta.url))), imports);
const component = { digest: ${JSON.stringify(digest)}, imports: ${JSON.stringify(imports)}, instantiate: factory };
const host = createDurableMessagingWitHost(port, { authorize: () => true, limitsGrant: createDurableMessagingLimitsGrant(), lifecycle: createDurableMessagingLifecycle() });
const started = await instantiateDurableMessagingJspi(host, { component, verify: (candidate) => candidate.digest === component.digest && candidate.instantiate === factory && candidate.imports.length === 1 && candidate.imports[0] === DURABLE_MESSAGING_JSPI_INTERFACE });
if (started.status !== 'started') throw new Error('component start unresolved');
const result = await started.value.run();
if (result !== 'unknown:committed:orders:7:9' || attempts !== 2 || !durable) throw new Error('unexpected component response: ' + result);
console.log('verified-component-ok');
`,
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			["--experimental-wasm-stack-switching", "--import", "tsx", driver],
			{ cwd: packageRoot, timeout: 60_000, maxBuffer: 2_000_000 },
		);
		expect(stdout).toContain("verified-component-ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 240_000);
