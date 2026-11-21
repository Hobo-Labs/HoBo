/** Conservative metered liability bounds from independently observed rates. */
export interface UpstashMeteredRates {
	readonly simpleMicrosPerMillion: number;
	readonly advancedMicrosPerMillion: number;
	readonly deleteMicrosPerMillion: number;
	readonly storageMicrosPerGbMonth: number;
	readonly egressMicrosPerGb: number;
	readonly mintMicrosPerCall: number;
}

/** Round each possible native operation up, and conservatively allow one
 * additional rounding unit per call for separately metered bytes. */
export function estimateUpstashBlobLiability(input: {
	readonly simple: number;
	readonly advanced: number;
	readonly deletes: number;
	readonly storage: number;
	readonly egress: number;
	readonly mint: number;
	readonly retentionMs: number;
	readonly rates: UpstashMeteredRates;
}): number {
	const values = [
		input.simple,
		input.advanced,
		input.deletes,
		input.storage,
		input.egress,
		input.mint,
		input.retentionMs,
		...Object.values(input.rates),
	];
	if (
		values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
		input.retentionMs < 1
	)
		throw new Error("invalid Upstash liability bounds");
	const ceil = (
		quantity: bigint,
		rate: number,
		divisor: number,
		multiplier = 1,
	): bigint => {
		const numerator = quantity * BigInt(rate) * BigInt(multiplier),
			denominator = BigInt(divisor);
		return (numerator + denominator - 1n) / denominator;
	};
	const months = Math.ceil(input.retentionMs / (28 * 86_400_000));
	const op = (count: number, rate: number) =>
		BigInt(count) * ceil(1n, rate, 1_000_000);
	const storage =
		ceil(
			BigInt(input.storage),
			input.rates.storageMicrosPerGbMonth,
			1_000_000_000,
			months,
		) +
		(input.storage && input.rates.storageMicrosPerGbMonth
			? BigInt(input.advanced)
			: 0n);
	const egress =
		ceil(BigInt(input.egress), input.rates.egressMicrosPerGb, 1_000_000_000) +
		(input.egress && input.rates.egressMicrosPerGb
			? BigInt(input.simple) +
				BigInt(input.advanced) +
				BigInt(input.deletes) +
				BigInt(input.mint)
			: 0n);
	const amount =
		op(input.simple, input.rates.simpleMicrosPerMillion) +
		op(
			input.advanced,
			Math.max(
				input.rates.advancedMicrosPerMillion,
				input.rates.deleteMicrosPerMillion,
			),
		) +
		op(input.deletes, input.rates.deleteMicrosPerMillion) +
		storage +
		egress +
		BigInt(input.mint) * BigInt(input.rates.mintMicrosPerCall);
	if (amount > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("Upstash liability exceeds safe bounds");
	return Number(amount);
}
