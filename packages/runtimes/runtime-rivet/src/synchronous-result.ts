import { types as utilTypes } from "node:util";

const intrinsicApply = Reflect.apply;
const intrinsicPromiseThen = Promise.prototype.then;

export function synchronousResult(value: unknown): unknown {
	if (utilTypes.isPromise(value)) {
		try {
			void intrinsicApply(intrinsicPromiseThen, value, [undefined, () => undefined]);
		} catch {}
	}
	return value;
}
