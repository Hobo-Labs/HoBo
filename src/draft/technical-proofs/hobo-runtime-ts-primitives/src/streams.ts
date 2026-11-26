import { type JsonValue } from "./json.js";
export function getWritable<T>(): WritableStream<T> {
  return new WritableStream<T>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
}

const chunks: JsonValue[] = [];

export function drainWritableForTests(): JsonValue[] {
  const copy = [...chunks];
  chunks.length = 0;
  return copy;
}

export function getReadableFromRun(): ReadableStream<JsonValue> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
