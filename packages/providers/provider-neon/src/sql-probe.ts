import { fromJsonString } from "@bufbuild/protobuf";
import { StructSchema } from "@bufbuild/protobuf/wkt";

/** The acceptance query is SELECT 1 AS hobo_validation. HTTP success or an
 * echoed query alone is insufficient; require its exact returned scalar. */
export function confirmsNeonSqlProbe(body: string): boolean {
	try {
		const decoded = fromJsonString(StructSchema, body);
		const rows = decoded.fields.rows?.kind;
		if (rows?.case !== "listValue" || rows.value.values.length !== 1)
			return false;
		const row = rows.value.values[0]?.kind;
		if (row?.case === "structValue") {
			const scalar = row.value.fields.hobo_validation?.kind;
			return scalar?.case === "numberValue"
				? scalar.value === 1
				: scalar?.case === "stringValue" && scalar.value === "1";
		}
		if (row?.case !== "listValue" || row.value.values.length !== 1)
			return false;
		const fields = decoded.fields.fields?.kind;
		if (fields?.case !== "listValue" || fields.value.values.length !== 1)
			return false;
		const field = fields.value.values[0]?.kind;
		if (field?.case !== "structValue") return false;
		const name = field.value.fields.name?.kind;
		if (name?.case !== "stringValue" || name.value !== "hobo_validation")
			return false;
		const scalar = row.value.values[0]?.kind;
		return scalar?.case === "numberValue"
			? scalar.value === 1
			: scalar?.case === "stringValue" && scalar.value === "1";
	} catch {
		return false;
	}
}
