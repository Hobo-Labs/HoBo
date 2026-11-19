import { createPortDescriptor, portKey } from "./ports.js";
import { cloneAsJson, type JsonValue } from "./json.js";

export interface Container {
  register<T>(descriptor: JsonValue, implementation: T): void;
  resolve<T>(descriptor: JsonValue): T;
}

export function createContainer(): Container {
  const implementations = new Map<string, object>();
  return {
    register<T>(descriptorInput: JsonValue, implementation: T) {
      const descriptor = createPortDescriptor(cloneAsJson(descriptorInput));
      const key = portKey(descriptor);
      if (implementations.has(key)) {
        throw new Error(`port ${key} is already registered`);
      }
      implementations.set(key, Object(implementation));
    },
    resolve<T>(descriptorInput: JsonValue): T {
      const descriptor = createPortDescriptor(cloneAsJson(descriptorInput));
      const key = portKey(descriptor);
      if (!implementations.has(key)) {
        throw new Error(`port ${key} is not registered`);
      }
      return implementations.get(key) as T;
    },
  };
}
