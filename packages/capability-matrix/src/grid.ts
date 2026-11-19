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

export const CAPABILITY_MATRIX_COORDINATES: readonly CapabilityMatrixCoordinate[] =
	BINDLE_PRIMITIVES.flatMap((primitive) =>
		BINDLE_RUNTIMES.map((runtime) => ({
			key: cellKey(primitive, runtime),
			primitive,
			runtime,
		})),
	);

export const CAPABILITY_MATRIX_CELL_COUNT: number =
	BINDLE_PRIMITIVES.length * BINDLE_RUNTIMES.length;

const COORDINATE_INDEX: ReadonlyMap<CapabilityMatrixCellKey, number> = new Map(
	CAPABILITY_MATRIX_COORDINATES.map((coordinate, index) => [
		coordinate.key,
		index,
	]),
);

export function coordinateIndex(key: string): number {
	return COORDINATE_INDEX.get(key as CapabilityMatrixCellKey) ?? -1;
}
