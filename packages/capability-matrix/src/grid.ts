/**
 * The coordinate space of the capability matrix.
 *
 * The grid is the cross product of the two closed vocabularies owned by
 * `@hobo/capability-profiles`, computed here rather than transcribed, so a new
 * Bindle primitive or runtime model widens the matrix by editing exactly one
 * package. Nothing in this file knows what is covered — only which questions
 * exist.
 */
import {
	BINDLE_PRIMITIVES,
	BINDLE_RUNTIMES,
	type BindlePrimitive,
	type BindleRuntime,
} from "@hobo/capability-profiles";

export type CapabilityMatrixCellKey = `${BindlePrimitive}/${BindleRuntime}`;

export type CapabilityMatrixCoordinate = {
	readonly key: CapabilityMatrixCellKey;
	readonly primitive: BindlePrimitive;
	readonly runtime: BindleRuntime;
};

export function cellKey(
	primitive: BindlePrimitive,
	runtime: BindleRuntime,
): CapabilityMatrixCellKey {
	return `${primitive}/${runtime}`;
}

/**
 * Every coordinate, primitive-major then runtime-minor.
 *
 * This order is the canonical one: the generator fills cells in it, the
 * renderer walks rows in it, and the digest covers cells in it. Sorting is
 * therefore never re-derived from a locale-sensitive comparison.
 */
export const CAPABILITY_MATRIX_COORDINATES: readonly CapabilityMatrixCoordinate[] =
	BINDLE_PRIMITIVES.flatMap((primitive) =>
		BINDLE_RUNTIMES.map((runtime) => ({
			key: cellKey(primitive, runtime),
			primitive,
			runtime,
		})),
	);

/** How many cells a complete matrix carries. Ten primitives, five runtimes. */
export const CAPABILITY_MATRIX_CELL_COUNT: number =
	BINDLE_PRIMITIVES.length * BINDLE_RUNTIMES.length;

const COORDINATE_INDEX: ReadonlyMap<CapabilityMatrixCellKey, number> = new Map(
	CAPABILITY_MATRIX_COORDINATES.map((coordinate, index) => [
		coordinate.key,
		index,
	]),
);

/** Position of a coordinate in canonical order, or -1 when it is not one. */
export function coordinateIndex(key: string): number {
	// SAFETY: callers receive -1 for keys outside the closed coordinate vocabulary.
	return COORDINATE_INDEX.get(key as CapabilityMatrixCellKey) ?? -1;
}
