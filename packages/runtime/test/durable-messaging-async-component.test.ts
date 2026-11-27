import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DURABLE_MESSAGING_WIT_INTERFACE } from "../src/durable-messaging-host.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const witRoot = join(packageRoot, "..", "wit");
const requireFromWit = createRequire(join(witRoot, "package.json"));
const jcoApi = requireFromWit.resolve("@bytecodealliance/jco");
const componentize = requireFromWit.resolve("componentize-qjs");
const jcoTranspile = requireFromWit.resolve("@bytecodealliance/jco-transpile");
const jcoCli = join(dirname(jcoApi), "jco.js");

it("executes a verified native async component across delayed and lost replies", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hobo-messaging-async-"));
	try {
		const original = await readFile(
			join(
				witRoot,
				"wit/deps/hobo-durable-messaging/hobo-durable-messaging.wit",
			),
			"utf8",
		);
		const witPath = join(dir, "probe.wit");
		await writeFile(
			witPath,
			`${original}\nworld bridge-test {\n  import messaging;\n  export run: async func() -> string;\n  export run-scoped: async func() -> string;\n}\n`,
		);
		const guest = `import { limits, ensureTopic, publish, consume } from '${DURABLE_MESSAGING_WIT_INTERFACE}';
export async function run() {
  if ((await limits()).nameBytes !== 128) throw new Error('unexpected messaging limits');
  const request = { operation: { id: 'v1.2000000000000.abcdefghijklmnop', expiresAtMs: 2000000000000n }, topic: 'orders' };
  const lost = await ensureTopic(request);
  const replay = await ensureTopic(request);
  const published = await publish({ operation: { id: 'v1.2000000000000.publishnonce1234', expiresAtMs: 2000000000000n }, topic: 'orders', message: { id: 'msg', subject: 'created', payload: new Uint8Array([4, 5]), attributes: [] } });
  const received = await consume({ operation: { id: 'v1.2000000000000.consumenonce1234', expiresAtMs: 2000000000000n }, topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 10n });
  return lost.tag + ':' + replay.tag + ':' + replay.val.topic + ':' + published.val.sequence + ':' + received.val[0].message.payload[0];
}
export async function runScoped() {
  const operation = { id: 'v1.2000000000000.scopednonce12345', expiresAtMs: 2000000000000n };
  const request = { operation, topic: 'orders', message: { id: 'msg', subject: 'created', payload: new Uint8Array([4, 5]), attributes: [] } };
  const allowed = await publish(request);
  const denied = await publish({ ...request, operation: { id: 'v1.2000000000000.deniednonce12345', expiresAtMs: 2000000000000n }, topic: 'other' });
  const received = await consume({ operation: { id: 'v1.2000000000000.scopedconsume123', expiresAtMs: 2000000000000n }, topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 10n });
  return allowed.tag + ':' + denied.tag + ':' + received.val[0].message.payload[0];
}`;
		const binaryPath = join(dir, "probe.wasm");
		const builderPath = join(dir, "build.mjs");
		const out = join(dir, "compiled");
		await writeFile(
			builderPath,
			`import { componentize } from ${JSON.stringify(pathToFileURL(componentize).href)};
import { transpile, writeFiles } from ${JSON.stringify(pathToFileURL(jcoTranspile).href)};
import { writeFile } from 'node:fs/promises';
const built = await componentize({ witPath: ${JSON.stringify(witPath)}, jsSource: ${JSON.stringify(guest)}, world: 'bridge-test', stubWasi: true });
await writeFile(${JSON.stringify(binaryPath)}, built.component);
const operations = ['limits', 'ensure-topic', 'ensure-subscription', 'publish', 'consume', 'ack', 'nack', 'compact', 'events'];
const output = await transpile(${JSON.stringify(binaryPath)}, { name: 'probe', instantiation: 'async', asyncMode: 'jspi', asyncImports: operations.map((operation) => ${JSON.stringify(DURABLE_MESSAGING_WIT_INTERFACE)} + '#' + operation), asyncExports: ['run', 'run-scoped'], wasiShim: false });
await writeFiles(output.files, { baseDir: ${JSON.stringify(out)} });
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
		expect(imports).toEqual([DURABLE_MESSAGING_WIT_INTERFACE]);

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
import { createBindleTopicWitHost, createDurableMessagingWitHost, createDurableMessagingLifecycle, createDurableMessagingLimitsGrant, instantiateDurableMessagingAsync, DURABLE_MESSAGING_WIT_INTERFACE } from ${JSON.stringify(hostUrl)};
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
const started = await instantiateDurableMessagingAsync(host, { component, verify: (candidate) => candidate.digest === component.digest && candidate.instantiate === factory && candidate.imports.length === 1 && candidate.imports[0] === DURABLE_MESSAGING_WIT_INTERFACE });
if (started.status !== 'started') throw new Error('component start unresolved');
const result = await started.value.run();
if (result !== 'unknown:committed:orders:7:9' || attempts !== 2 || !durable) throw new Error('unexpected component response: ' + result);
const scoped = createBindleTopicWitHost(port, {
  bindleName: 'shop',
  applicationName: 'web',
  resources: {
    web: { kind: 'web', name: 'web', declaredAllow: [], dependsOn: ['topic'] },
    orders: { kind: 'topic', name: 'orders', declaredAllow: ['publish', 'subscribe'], dependsOn: [] },
  },
  edges: [{ from: 'web', to: 'orders' }],
  bindings: [{ resourceName: 'orders', topic: 'orders', subscriptions: [{ consumerGroup: 'workers', deadLetterTopic: 'orders-dlq' }] }],
}, {
  limitsGrant: createDurableMessagingLimitsGrant(), lifecycle: createDurableMessagingLifecycle(),
  verify: (claim) => claim.port === port && claim.bindleName === 'shop' && claim.applicationName === 'web' && claim.binding.resourceName === 'orders' && (claim.subscription === undefined || claim.subscription.deadLetterTopic === 'orders-dlq'),
});
const scopedStarted = await instantiateDurableMessagingAsync(scoped.host, { component, verify: (candidate) => candidate.digest === component.digest && candidate.instantiate === factory && candidate.imports.length === 1 && candidate.imports[0] === DURABLE_MESSAGING_WIT_INTERFACE });
if (scopedStarted.status !== 'started') throw new Error('scoped component start unresolved');
const scopedResult = await scopedStarted.value.runScoped();
if (scopedResult !== 'committed:unknown:9' || seen.has('v1.2000000000000.deniednonce12345')) throw new Error('unexpected scoped component response: ' + scopedResult);
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
