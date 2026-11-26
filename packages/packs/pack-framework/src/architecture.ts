/**
 * Target architectures a pack may declare.
 *
 * The set is closed on purpose. An open string would let a manifest claim
 * `linux/riscv64` with an amd64 digest behind it, and nothing downstream would
 * be able to tell. Values use the `os/arch[/variant]` spelling from the OCI
 * image specification's platform object.
 */
import { PackError } from "./errors.js";

export const PACK_ARCHITECTURES = [
	"linux/amd64",
	"linux/arm64",
	"linux/arm64/v8",
	"linux/arm/v7",
	"linux/386",
	"linux/ppc64le",
	"linux/s390x",
] as const;

export type PackArchitecture = (typeof PACK_ARCHITECTURES)[number];

export function isPackArchitecture(value: string): value is PackArchitecture {
	for (const architecture of PACK_ARCHITECTURES) {
		if (architecture === value) return true;
	}
	return false;
}

export function parsePackArchitecture(input: string): PackArchitecture {
	if (!isPackArchitecture(input)) {
		throw new PackError(
			"ARCHITECTURE_UNSUPPORTED",
			`architecture ${JSON.stringify(input)} is not one of the supported OCI platforms`,
			{ detail: { supported: PACK_ARCHITECTURES.join(",") } },
		);
	}
	return input;
}

/**
 * `linux/arm64` and `linux/arm64/v8` name the same hardware in practice, and
 * registries are inconsistent about which they publish. Equivalence is declared
 * here once rather than guessed at each comparison site.
 */
const EQUIVALENT: readonly (readonly PackArchitecture[])[] = [
	["linux/arm64", "linux/arm64/v8"],
];

export function architecturesMatch(
	declared: PackArchitecture,
	requested: PackArchitecture,
): boolean {
	if (declared === requested) return true;
	return EQUIVALENT.some(
		(group) => group.includes(declared) && group.includes(requested),
	);
}
