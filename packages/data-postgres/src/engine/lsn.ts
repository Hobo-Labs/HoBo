/**
 * Write-ahead-log positions. An LSN is a 64-bit byte offset the server prints
 * as two hexadecimal halves (`16/B374D848`); it is the `Position` this engine
 * mints. Text comparison would order `9/0` after `10/0`, so every comparison
 * goes through the parsed integer.
 */
import { PostgresDataError } from "../errors.js";

const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/u;

/** The one constructor for an LSN. A position minted elsewhere is refused. */
export function parseLsn(text: string): bigint {
	const match = LSN_PATTERN.exec(text);
	if (match === null) {
		throw new PostgresDataError(
			"CAPTURE_POSITION_INVALID",
			"a capture position for this engine is a write-ahead-log location such as 16/B374D848",
			{ detail: { field: "position" } },
		);
	}
	return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}

export function formatLsn(value: bigint): string {
	const high = (value >> 32n).toString(16).toUpperCase();
	const low = (value & 0xffff_ffffn).toString(16).toUpperCase();
	return `${high}/${low}`;
}

export function maxLsn(left: bigint, right: bigint): bigint {
	return left >= right ? left : right;
}
