import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const witRoot = join(packageRoot, "..", "..", "wit");
const requireFromWit = createRequire(join(witRoot, "package.json"));
const jcoApi = requireFromWit.resolve("@bytecodealliance/jco");
const componentize = requireFromWit.resolve("componentize-qjs");
const jcoTranspile = requireFromWit.resolve("@bytecodealliance/jco-transpile");
const jcoCli = join(dirname(jcoApi), "jco.js");
const fixture = fileURLToPath(
	new URL("./fixtures/rivet-topic-async-live.mjs", import.meta.url),
);
const loader = createRequire(import.meta.url).resolve("tsx");
const interfaceName = "hobo:durable-messaging/messaging@0.1.0";

it("routes a real native async component through the Rivet client to a live bus actor", {
	timeout: 540_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-rivet-async-"));
	try {
		const original = await readFile(
			join(
				witRoot,
				"wit/deps/hobo-durable-messaging/hobo-durable-messaging.wit",
			),
			"utf8",
		);
		const witPath = join(directory, "probe.wit");
		await writeFile(
			witPath,
			`${original}\nworld bridge-test {\n  import messaging;\n  export run: async func() -> string;\n  export expire-check: async func() -> string;\n}\n`,
		);
		const guest = `import { limits, ensureTopic, ensureSubscription, publish, consume, nack, ack, compact, events } from '${interfaceName}';
const expiry = 1700000060000n;
const op = (n) => ({ id: 'v1.1700000060000.' + String(n).padStart(16, '0'), expiresAtMs: expiry });
const must = (outcome, label) => { if (outcome.tag !== 'committed') throw new Error(label + ':' + outcome.tag); return outcome.val; };
const settle = (delivery) => ({ topic: delivery.topic, consumerGroup: delivery.consumerGroup, messageId: delivery.message.id, sequence: delivery.sequence, leaseId: delivery.leaseId });
let stale;
export async function run() {
  if ((await limits()).nameBytes !== 128) throw new Error('unexpected messaging limits');
  const denied = await ensureTopic({ operation: op(1), topic: 'forbidden' });
  if (denied.tag !== 'unknown') throw new Error('component scope denial');
  for (const [n, topic] of [[2,'orders'],[3,'dlq'],[4,'archive']]) must(await ensureTopic({ operation: op(n), topic }), 'topic');
  must(await ensureSubscription({ operation: op(5), subscription: { topic: 'orders', consumerGroup: 'workers', deadLetterTopic: 'dlq', maxDeliveryAttempts: 1, startAt: 'earliest' } }), 'subscription');
  must(await ensureSubscription({ operation: op(6), subscription: { topic: 'dlq', consumerGroup: 'reader', deadLetterTopic: 'archive', maxDeliveryAttempts: 1, startAt: 'earliest' } }), 'dlq subscription');
  const publication = { operation: op(7), topic: 'orders', message: { id: 'msg', subject: 'created', payload: new Uint8Array([0,1,254,255]), attributes: [{ key: 'type', value: 'binary' }] } };
  if ((await publish(publication)).tag !== 'unknown') throw new Error('lost publish response');
  const receipt = must(await publish(publication), 'publish replay');
  if (receipt.messageId !== 'msg' || receipt.sequence !== 1n) throw new Error('wrong publish receipt');
  const first = must(await consume({ operation: op(8), topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 100n }), 'consume')[0];
  if (!first || first.sequence !== 1n || first.message.payload[2] !== 254 || first.message.attributes[0].value !== 'binary') throw new Error('delivery changed');
  const fail = { operation: op(9), ...settle(first), reason: 'fatal' };
  if ((await nack(fail)).tag !== 'unknown') throw new Error('lost nack response');
  const deadReceipt = must(await nack(fail), 'nack replay');
  if (deadReceipt.tag !== 'dead-lettered') throw new Error('missing DLQ receipt');
  const dead = must(await consume({ operation: op(10), topic: 'dlq', consumerGroup: 'reader', maxMessages: 1, visibilityTimeoutMs: 100n }), 'dlq consume')[0];
  if (!dead || dead.message.id !== deadReceipt.val.deadLetterMessageId || dead.sequence !== deadReceipt.val.deadLetterSequence || dead.message.payload[3] !== 255 || !dead.deadLetter || dead.deadLetter.cause.tag !== 'nack' || dead.deadLetter.cause.val !== 'fatal' || dead.deadLetter.originalSequence !== 1n) throw new Error('dead letter changed');
  must(await ack({ operation: op(11), ...settle(dead) }), 'dlq ack');
  const compacted = must(await compact({ operation: op(12), topic: 'orders', throughSequence: 1n }), 'compact');
  if (compacted.removedMessages !== 1 || compacted.firstAvailableSequence !== 2n) throw new Error('bad compaction');
  must(await publish({ operation: op(13), topic: 'orders', message: { id: 'msg', subject: 'created', payload: new Uint8Array([7]), attributes: [] } }), 'republish');
  stale = must(await consume({ operation: op(14), topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 100n }), 'stale lease')[0];
  if (!stale || stale.sequence !== 2n || stale.leaseId === first.leaseId) throw new Error('identity reuse');
  return 'guest-run-ok';
}
export async function expireCheck() {
  const denied = await ack({ operation: op(15), ...settle(stale) });
  if (denied.tag !== 'rejected' || denied.val !== 'lease-lost') throw new Error('expired lease accepted');
  const moved = must(await consume({ operation: op(16), topic: 'orders', consumerGroup: 'workers', maxMessages: 1, visibilityTimeoutMs: 100n }), 'expire transfer');
  if (moved.length !== 0) throw new Error('expired source leased');
  const dead = must(await consume({ operation: op(17), topic: 'dlq', consumerGroup: 'reader', maxMessages: 1, visibilityTimeoutMs: 100n }), 'expired dlq')[0];
  if (!dead || !dead.deadLetter || dead.deadLetter.cause.tag !== 'lease-expired' || dead.deadLetter.originalSequence !== 2n || dead.message.payload[0] !== 7) throw new Error('expired provenance');
  must(await ack({ operation: op(18), ...settle(dead) }), 'expiry ack');
  const audit = await events({ afterSequence: 0n, limit: 100 });
  if (audit.tag !== 'ok' || !audit.val.events.some((event) => event.kind === 'dead-lettered')) throw new Error('missing audit');
  return 'guest-expiry-ok';
}`;
		const binaryPath = join(directory, "probe.wasm");
		const builderPath = join(directory, "build.mjs");
		const outputDirectory = join(directory, "compiled");
		await writeFile(
			builderPath,
			`import { componentize } from ${JSON.stringify(pathToFileURL(componentize).href)};
import { transpile, writeFiles } from ${JSON.stringify(pathToFileURL(jcoTranspile).href)};
import { writeFile } from 'node:fs/promises';
const built = await componentize({ witPath: ${JSON.stringify(witPath)}, jsSource: ${JSON.stringify(guest)}, world: 'bridge-test', stubWasi: true });
await writeFile(${JSON.stringify(binaryPath)}, built.component);
const operations = ['limits', 'ensure-topic', 'ensure-subscription', 'publish', 'consume', 'ack', 'nack', 'compact', 'events'];
const output = await transpile(${JSON.stringify(binaryPath)}, { name: 'probe', instantiation: 'async', asyncMode: 'jspi', asyncImports: operations.map((operation) => ${JSON.stringify(interfaceName)} + '#' + operation), asyncExports: ['run', 'expire-check'], wasiShim: false });
await writeFiles(output.files, { baseDir: ${JSON.stringify(outputDirectory)} });
`,
		);
		await execFileAsync(process.execPath, [builderPath], {
			cwd: packageRoot,
			timeout: 120_000,
			maxBuffer: 2_000_000,
		});
		const digest = `sha256:${createHash("sha256")
			.update(await readFile(binaryPath))
			.digest("hex")}`;
		const { stdout: metadata } = await execFileAsync(
			process.execPath,
			[jcoCli, "wit", binaryPath],
			{ cwd: packageRoot, timeout: 60_000, maxBuffer: 2_000_000 },
		);
		const imports = [...metadata.matchAll(/^\s*import ([^;]+);/gmu)].map(
			(match) => match[1],
		);
		expect(imports).toEqual([interfaceName]);

		const result = await new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
			timedOut: boolean;
		}>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-wasm-stack-switching",
					"--import",
					loader,
					fixture,
					outputDirectory,
					digest,
					JSON.stringify(imports),
				],
				{
					cwd: directory,
					detached: process.platform !== "win32",
					env: {
						PATH: process.env.PATH,
						TMPDIR: directory,
						XDG_CACHE_HOME: directory,
						NODE_ENV: "test",
					},
				},
			);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const stop = () => {
				try {
					if (process.platform !== "win32" && child.pid !== undefined)
						process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch (error) {
					/* SAFETY: process signalling errors expose an errno. */ if (
						(error as NodeJS.ErrnoException).code !== "ESRCH"
					)
						throw error;
				}
			};
			const timer = setTimeout(() => {
				timedOut = true;
				stop();
			}, 180_000);
			child.stdout.on("data", (chunk) => {
				stdout = (stdout + String(chunk)).slice(-20_000);
			});
			child.stderr.on("data", (chunk) => {
				stderr = (stderr + String(chunk)).slice(-20_000);
			});
			child.once("exit", stop);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (status) => {
				clearTimeout(timer);
				resolve({ status, stdout, stderr, timedOut });
			});
		});
		expect(result.timedOut, result.stderr).toBe(false);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain(
			"rivet-async-bus-live-ok component=observed actor=observed host-grants=fixture source-fence=unverified owner-fence=unverified ingress=unverified process-restart=unverified fault-placement=unverified",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
