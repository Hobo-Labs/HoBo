import { CapturePositionError } from "@hobo/data-core";

const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/u;

export function parseLsn(text: string): bigint {
	const match = LSN_PATTERN.exec(text);
	if (match === null) {
		throw new CapturePositionError(
			"",
			"a capture position for this engine is a write-ahead-log location such as 16/B374D848",
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
