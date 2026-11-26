import { cloneAsJson, type JsonValue } from "./json.js";
import { createPortDescriptor, type PortDescriptor, portKey } from "./ports.js";

export interface Container {
	register<T>(descriptor: PortDescriptor | JsonValue, implementation: T): void;
	resolve<T>(descriptor: PortDescriptor | JsonValue): T;
}

export function createContainer(): Container {
	const implementations = new Map<string, unknown>();
	return {
		register<T>(
			descriptorInput: PortDescriptor | JsonValue,
			implementation: T,
		) {
			const descriptor = createPortDescriptor(cloneAsJson(descriptorInput));
			const key = portKey(descriptor);
			if (implementations.has(key)) {
				throw new Error(`port ${key} is already registered`);
			}
			implementations.set(key, implementation);
		},
		resolve<T>(descriptorInput: PortDescriptor | JsonValue): T {
			const descriptor = createPortDescriptor(cloneAsJson(descriptorInput));
			const key = portKey(descriptor);
			if (!implementations.has(key)) {
				throw new Error(`port ${key} is not registered`);
			}
			// SAFETY: assertion required at this I/O or test boundary.
			return implementations.get(key) as T;
		},
	};
}
