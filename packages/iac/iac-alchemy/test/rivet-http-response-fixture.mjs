/* oxlint-disable unicorn/no-thenable -- SAFETY: the isolated fixture poisons response thenable lookup. */
const { createRivetHttpActor } = await import(process.argv[2]);
const NativeResponse = Response;
const NativeError = Error;
const NativeWeakMap = WeakMap;
const weakGet = Object.getOwnPropertyDescriptor(NativeWeakMap.prototype, "get");
const weakSet = Object.getOwnPropertyDescriptor(NativeWeakMap.prototype, "set");
const originalError = Object.getOwnPropertyDescriptor(globalThis, "Error");
const prototypeFields = ["status", "statusText", "headers", "toJSON"];
const originalFields = prototypeFields.map((field) =>
	Object.getOwnPropertyDescriptor(Object.prototype, field),
);
const original = Object.getOwnPropertyDescriptor(
	NativeResponse.prototype,
	"then",
);
const define = Object.defineProperty;
const remove = Reflect.deleteProperty;
const apply = Reflect.apply;
const nativeThen = Promise.prototype.then;
const context = { name: "web", key: ["tenant"], vars: {} };
let traps = 0;
const poison = () => {
	define(NativeResponse.prototype, "then", {
		configurable: true,
		get() {
			traps++;
			throw new Error("unexpected response then lookup");
		},
	});
	for (let index = 0; index < prototypeFields.length; index++) {
		const field = prototypeFields[index];
		if (field === undefined) continue;
		const property = Object.create(null);
		property.configurable = true;
		property.get = () => {
			traps++;
			return 200;
		};
		property.set = () => {
			traps++;
		};
		define(Object.prototype, field, property);
	}
};
const restore = () => {
	for (let index = 0; index < prototypeFields.length; index++) {
		const field = prototypeFields[index];
		if (field === undefined) continue;
		const previous = originalFields[index];
		if (previous === undefined) remove(Object.prototype, field);
		else define(Object.prototype, field, previous);
	}
	if (original === undefined) remove(NativeResponse.prototype, "then");
	else define(NativeResponse.prototype, "then", original);
	if (originalError === undefined) remove(globalThis, "Error");
	else define(globalThis, "Error", originalError);
	define(NativeWeakMap.prototype, "get", weakGet);
	define(NativeWeakMap.prototype, "set", weakSet);
};
const failure = () => {
	restore();
	process.stderr.write("adapter response failed or was assimilated");
	process.exitCode = 1;
};
setImmediate(() => {
	const denied = createRivetHttpActor({
		actorName: "web",
		authorize: () => {
			poison();
			return false;
		},
		entrypoint: () => () => new NativeResponse("unexpected"),
	});
	const failed = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			poison();
			throw new Error("application failed");
		},
	});
	const originalResponse = new NativeResponse("protected");
	const successful = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			poison();
			return originalResponse;
		},
	});
	const rejected = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		entrypoint: () => () => {
			const promise = Promise.reject("opaque rejection");
			globalThis.Error = new Proxy(NativeError, {
				construct() {
					traps++;
					throw new NativeError("unexpected Error constructor");
				},
			});
			return promise;
		},
	});
	const legitimateResponse = new NativeResponse("legitimate");
	const weakMapPoisoned = createRivetHttpActor({
		actorName: "web",
		authorize: () => {
			define(NativeWeakMap.prototype, "get", {
				configurable: true,
				value() {
					traps++;
					return { value: () => new NativeResponse("forged") };
				},
			});
			define(NativeWeakMap.prototype, "set", {
				configurable: true,
				value() {
					traps++;
					return this;
				},
			});
			return true;
		},
		entrypoint: () => () => legitimateResponse,
	});
	const runWeakMap = () => {
		apply(
			nativeThen,
			weakMapPoisoned.handle(context, new Request("https://example.test")),
			[
				(response) => {
					restore();
					if (response !== legitimateResponse || traps !== 0) return failure();
					process.stdout.write("http-response-intrinsics-ok");
				},
				failure,
			],
		);
	};
	const runRejected = () => {
		apply(
			nativeThen,
			rejected.handle(context, new Request("https://example.test")),
			[
				(response) => {
					restore();
					if (response.status !== 503 || traps !== 0) return failure();
					apply(nativeThen, response.json(), [
						(body) => {
							if (
								body.error !== "application-failed" ||
								body.execution !== "possibly-completed"
							)
								return failure();
							runWeakMap();
						},
						failure,
					]);
				},
				failure,
			],
		);
	};
	const runSuccessful = () => {
		apply(
			nativeThen,
			successful.handle(context, new Request("https://example.test")),
			[
				(response) => {
					restore();
					if (response !== originalResponse || traps !== 0) return failure();
					runRejected();
				},
				failure,
			],
		);
	};
	const runFailed = () => {
		apply(
			nativeThen,
			failed.handle(context, new Request("https://example.test")),
			[
				(response) => {
					restore();
					if (response.status !== 503 || traps !== 0) return failure();
					apply(nativeThen, response.json(), [
						(body) => {
							if (
								body.error !== "application-failed" ||
								body.execution !== "possibly-completed"
							)
								return failure();
							runSuccessful();
						},
						failure,
					]);
				},
				failure,
			],
		);
	};
	apply(
		nativeThen,
		denied.handle(context, new Request("https://example.test")),
		[
			(response) => {
				restore();
				if (response.status !== 403 || traps !== 0) return failure();
				apply(nativeThen, response.text(), [
					(body) => {
						if (body !== "Forbidden") return failure();
						runFailed();
					},
					failure,
				]);
			},
			failure,
		],
	);
});
