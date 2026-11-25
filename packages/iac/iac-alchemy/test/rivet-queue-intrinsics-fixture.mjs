/* oxlint-disable unicorn/no-thenable -- SAFETY: this isolated process poisons thenable lookup. */
const { createRivetAsyncQueueClient, createRivetQueueActor } = await import(
	process.argv[2]
);
const { readRivetQueueStream } = await import(
	new URL("rivet-queue-stream.js", process.argv[2])
);
const apply = Reflect.apply;
const define = Object.defineProperty;
const remove = Reflect.deleteProperty;
const descriptor = Object.getOwnPropertyDescriptor;
const nativeThen = Promise.prototype.then;
const forgedAllow = Promise.resolve(true);
const saved = [];
let traps = 0;
let dispatches = 0;

function replace(owner, key, value) {
	saved.push([owner, key, descriptor(owner, key)]);
	define(owner, key, { configurable: true, writable: true, value });
}

function poison() {
	const trap = () => {
		traps++;
		throw new Error("unexpected mutable intrinsic");
	};
	const forgeAllow = () => {
		traps++;
		return forgedAllow;
	};
	replace(Promise, "race", forgeAllow);
	replace(Promise, "resolve", forgeAllow);
	replace(Promise.prototype, "then", forgeAllow);
	replace(WeakSet.prototype, "add", trap);
	replace(WeakSet.prototype, "has", trap);
	replace(EventTarget.prototype, "addEventListener", trap);
	replace(EventTarget.prototype, "removeEventListener", trap);
	replace(globalThis, "setTimeout", trap);
	replace(globalThis, "clearTimeout", trap);
	saved.push([
		AbortSignal.prototype,
		"aborted",
		descriptor(AbortSignal.prototype, "aborted"),
	]);
	define(AbortSignal.prototype, "aborted", { configurable: true, get: trap });
	saved.push([Object.prototype, "then", descriptor(Object.prototype, "then")]);
	define(Object.prototype, "then", { configurable: true, get: trap });
}

function restore() {
	for (let index = saved.length - 1; index >= 0; index--) {
		const [owner, key, previous] = saved[index];
		if (previous === undefined) remove(owner, key);
		else define(owner, key, previous);
	}
	saved.length = 0;
}

function checkStream() {
	const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
			controller.close();
		},
	});
	const verify = () => {
		replace(typedArrayPrototype, "set", () => {
			traps++;
			throw new Error("replaced set");
		});
		saved.push([
			typedArrayPrototype,
			"byteLength",
			descriptor(typedArrayPrototype, "byteLength"),
		]);
		define(typedArrayPrototype, "byteLength", {
			configurable: true,
			get() {
				traps++;
				throw new Error("replaced byteLength");
			},
		});
		return true;
	};
	apply(nativeThen, readRivetQueueStream(stream, 64, undefined, verify), [
		(box) => {
			restore();
			if (
				traps !== 0 ||
				box.value.length !== 3 ||
				box.value[0] !== 1 ||
				box.value[1] !== 2 ||
				box.value[2] !== 3
			) {
				process.stderr.write(`unexpected stream result: ${traps}`);
				process.exitCode = 1;
				return;
			}
			process.stdout.write("queue-intrinsics-ok");
		},
		() => {
			restore();
			process.exitCode = 1;
		},
	]);
}

function checkActor() {
	let transactions = 0;
	const actor = createRivetQueueActor({
		actorName: "jobs",
		now: () => 1000,
		authorize() {
			saved.push([
				Object.prototype,
				"status",
				descriptor(Object.prototype, "status"),
			]);
			define(Object.prototype, "status", {
				configurable: true,
				get() {
					traps++;
					return 200;
				},
				set() {
					traps++;
				},
			});
			replace(Object.prototype, "toJSON", () => {
				traps++;
				return "forged";
			});
			return false;
		},
	});
	const context = {
		name: "jobs",
		key: ["tenant"],
		db: {
			transaction() {
				transactions++;
			},
		},
	};
	const request = new Request("https://queue.test/dequeue", {
		method: "POST",
		body: "{}",
	});
	apply(nativeThen, actor.handle(context, request), [
		(response) => {
			restore();
			if (response.status !== 503 || traps !== 0 || transactions !== 0) {
				process.stderr.write(
					`unexpected actor result: ${response.status}, ${traps}, ${transactions}`,
				);
				process.exitCode = 1;
				return;
			}
			apply(nativeThen, response.json(), [
				(body) => {
					if (body.error !== "queue-unavailable") process.exitCode = 1;
					else checkStream();
				},
				() => {
					process.exitCode = 1;
				},
			]);
		},
		() => {
			restore();
			process.exitCode = 1;
		},
	]);
}

const client = createRivetAsyncQueueClient({
	scope: {
		tenantId: "tenant",
		instanceId: "instance",
		actorName: "jobs",
		actorKey: ["tenant"],
	},
	verifyDispatch() {
		poison();
		return false;
	},
	async fetch() {
		dispatches++;
		return new Response();
	},
});

apply(nativeThen, client.enqueue("key", 1), [
	() => {
		restore();
		process.stderr.write("queue accepted a denied request");
		process.exitCode = 1;
	},
	(error) => {
		restore();
		if (error.code !== "outcome-unknown" || dispatches !== 0 || traps !== 0) {
			process.stderr.write(
				`unexpected queue result: ${error.code}, ${dispatches}, ${traps}`,
			);
			process.exitCode = 1;
			return;
		}
		checkActor();
	},
]);
