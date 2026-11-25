// Vector BLOBs are little-endian IEEE-754 float32. SQLite is a derived
// read-store / materialized view of catalog vectors, never the source of truth.

const CODEC_ID = "f32le-l2";

export type EncodedVector = {
	readonly encoderId: string;
	readonly dimensions: number;
	readonly values: Float32Array;
};

export function encodeVectorBlob(vector: EncodedVector): Uint8Array {
	const out = new Uint8Array(vector.dimensions * 4);
	const view = new DataView(out.buffer);
	for (let i = 0; i < vector.dimensions; i++) {
		const value = vector.values[i] ?? 0;
		if (!Number.isFinite(value)) {
			throw new Error(`vector value ${i} is not finite`);
		}
		view.setFloat32(i * 4, value, true);
	}
	return out;
}

export function decodeVectorBlob(
	blob: Uint8Array,
	expectedDimensions: number,
	encoderId = "hobo-ontology-vector-v1",
): EncodedVector {
	if (blob.byteLength !== expectedDimensions * 4) {
		throw new Error(
			`vector blob length ${blob.byteLength} != ${expectedDimensions * 4}`,
		);
	}
	const values = new Float32Array(expectedDimensions);
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	for (let i = 0; i < expectedDimensions; i++) {
		const value = view.getFloat32(i * 4, true);
		if (!Number.isFinite(value)) {
			throw new Error(`vector value ${i} is not finite`);
		}
		values[i] = value;
	}
	return { encoderId, dimensions: expectedDimensions, values };
}

export function cosineSimilarity(
	left: EncodedVector,
	right: EncodedVector,
): number {
	if (left.dimensions !== right.dimensions) {
		throw new Error("vector dimension mismatch");
	}
	let sum = 0;
	for (let i = 0; i < left.dimensions; i++) {
		sum += (left.values[i] ?? 0) * (right.values[i] ?? 0);
	}
	return sum;
}

export function vectorCodecId(): string {
	return CODEC_ID;
}
