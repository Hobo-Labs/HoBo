import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const witRoot = join(packageRoot, "../wit");
const requireFromWit = createRequire(join(witRoot, "package.json"));
const componentize = requireFromWit.resolve("componentize-qjs");
const jcoTranspile = requireFromWit.resolve("@bytecodealliance/jco-transpile");
const queueInterface = "hobo:queue/queue@0.1.0";

it("round trips a native async component through the durable queue host", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hobo-queue-async-"));
	try {
		const original = await readFile(
			join(witRoot, "wit/deps/hobo-queue/hobo-queue.wit"),
			"utf8",
		);
		const witPath = join(dir, "probe.wit");
		await writeFile(
			witPath,
			`${original}\nworld queue-probe {\n  import queue;\n  export run: async func() -> string;\n}\n`,
		);
		const guest = `import { limits, enqueue, dequeue } from '${queueInterface}';
export async function run() {
  const capabilities = await limits();
  const operation = { id: 'v1.2000000000000.abcdefghijklmnop', expiresAtMs: 2000000000000n };
  const input = { operation, message: { idempotencyKey: 'job-1', body: new Uint8Array([4, 5]), attributes: [{ key: 'kind', value: 'job' }] } };
  const unknown = await enqueue(input);
  const replay = await enqueue(input);
  const expiredOperation = { id: 'v1.1000.abcdefghijklmnop', expiresAtMs: 1000n };
  const expired = await dequeue({ operation: expiredOperation, maxMessages: 1, visibilityTimeoutMs: 100n });
  return capabilities.tag + ':' + capabilities.val.batchSize + ':' + unknown.tag + ':' + replay.tag + ':' + replay.val.messageId + ':' + expired.tag + ':' + expired.val.id;
}`;
		const binaryPath = join(dir, "probe.wasm");
		const builder = join(dir, "build.mjs");
		const out = join(dir, "compiled");
		await writeFile(
			builder,
			`import { componentize } from ${JSON.stringify(pathToFileURL(componentize).href)};
import { transpile, writeFiles } from ${JSON.stringify(pathToFileURL(jcoTranspile).href)};
import { writeFile } from 'node:fs/promises';
const built = await componentize({ witPath: ${JSON.stringify(witPath)}, jsSource: ${JSON.stringify(guest)}, world: 'queue-probe', stubWasi: true });
await writeFile(${JSON.stringify(binaryPath)}, built.component);
const operations = ['limits', 'enqueue', 'dequeue', 'complete', 'extend-lease', 'release'];
const output = await transpile(${JSON.stringify(binaryPath)}, { name: 'probe', instantiation: 'async', asyncMode: 'jspi', asyncImports: operations.map((operation) => ${JSON.stringify(queueInterface)} + '#' + operation), asyncExports: ['run'], wasiShim: false });
await writeFiles(output.files, { baseDir: ${JSON.stringify(out)} });
`,
		);
		await execFileAsync(process.execPath, [builder], {
			cwd: packageRoot,
			timeout: 120_000,
			maxBuffer: 2_000_000,
		});
		const driver = join(dir, "driver.mjs");
		await writeFile(
			driver,
			`import { readFile } from 'node:fs/promises';
import { instantiate } from ${JSON.stringify(pathToFileURL(join(out, "probe.js")).href)};
import { createDurableQueueWitHost } from ${JSON.stringify(pathToFileURL(join(packageRoot, "src/durable-queue-host.ts")).href)};
let attempts = 0;
const unused = async () => { throw new Error('unexpected operation'); };
const limits = { nameBytes: 128, payloadBytes: 65536, attributeCount: 32, attributeBytes: 8192, batchSize: 100, delayMs: 1000, leaseMs: 1000, operationWindowMs: 10000, deliveryAttempts: 10, retainedMessages: 100, retainedReceipts: 100 };
const provider = {
  limits: unused,
  async enqueue(input) { await new Promise((resolve) => setTimeout(resolve, 5)); if (input.message.body[0] !== 4 || input.message.attributes[0].value !== 'job') throw new Error('invalid input'); attempts++; return attempts === 1 ? { status: 'unknown', operation: input.operation } : { status: 'committed', value: { messageId: 'message-1', idempotencyKey: input.message.idempotencyKey } }; },
  dequeue: unused, complete: unused, extendLease: unused, release: unused,
};
const port = createDurableQueueWitHost(provider, { limits, maxInFlight: 4, timeoutMs: 1000, now: () => 1999999999500, authorize: () => true });
const app = await instantiate(async (name) => WebAssembly.compile(await readFile(new URL('./compiled/' + name, import.meta.url))), { ${JSON.stringify(queueInterface)}: port, 'hobo:queue/queue': port });
const result = await app.run();
if (result !== 'available:100:unknown:committed:message-1:expired:v1.1000.abcdefghijklmnop' || attempts !== 2) throw new Error('unexpected queue response: ' + result);
console.log('queue-component-ok');
`,
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			["--experimental-wasm-stack-switching", "--import", "tsx", driver],
			{ cwd: packageRoot, timeout: 60_000, maxBuffer: 2_000_000 },
		);
		expect(stdout).toContain("queue-component-ok");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 240_000);
