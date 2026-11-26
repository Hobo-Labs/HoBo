import { create } from "@bufbuild/protobuf";
import { type Quantity, QuantitySchema } from "./_generated/pricing_pb.js";
import { formatDecimal, multiplyDecimal, parseDecimal } from "./decimal.js";

const EXPLICIT_CONVERSIONS = new Map([
	["GB->byte", "1000000000"],
	["GiB->byte", "1073741824"],
	["MB->byte", "1000000"],
	["MiB->byte", "1048576"],
	["GB->GiB", "0.931322574615478515625"],
	["GiB->GB", "1.073741824"],
	["minute->second", "60"],
	["hour->second", "3600"],
	["hour->minute", "60"],
]);

export function convertQuantity(
	quantity: Quantity | undefined,
	targetUnit: string,
): Quantity | undefined {
	if (quantity === undefined) return undefined;
	const decimal = parseDecimal(quantity.decimal);
	if (decimal === undefined || quantity.unit.length === 0) return undefined;
	if (quantity.unit === targetUnit) {
		return create(QuantitySchema, {
			decimal: formatDecimal(decimal),
			unit: targetUnit,
		});
	}
	const factor = parseDecimal(
		EXPLICIT_CONVERSIONS.get(`${quantity.unit}->${targetUnit}`) ?? "",
	);
	if (factor === undefined) return undefined;
	return create(QuantitySchema, {
		decimal: formatDecimal(multiplyDecimal(decimal, factor)),
		unit: targetUnit,
	});
}
