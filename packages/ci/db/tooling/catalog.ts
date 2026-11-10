/**
 * Reads a database's schema out of the PostgreSQL catalog, and compares two.
 *
 * This is the instrument the equivalence proof uses, so it reads what the
 * database built rather than what any DDL said: `pg_get_indexdef` and
 * `pg_get_constraintdef` render the stored definition, which is the same text
 * however the object was declared. Two databases with the same facts were, as
 * far as PostgreSQL is concerned, given the same schema.
 */

import type { Pool } from "pg";

/** One catalog fact: what it is about, and its full rendered value. */
export interface CatalogFact {
	readonly subject: string;
	readonly value: string;
}

interface FactRow {
	readonly subject: string;
	readonly value: string;
}

const RELATIONS = `
	SELECT c.oid, c.relname, c.relkind FROM pg_catalog.pg_class c
	JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = current_schema()`;

/**
 * Tables; columns with position, type (with length and precision), nullability,
 * default, identity and generation; primary-key, unique, foreign-key, check
 * and exclusion constraints by rendered definition; every index by rendered
 * definition (method, key columns and expressions, ordering, predicate) with
 * its uniqueness, primary and validity flags; and each owned sequence.
 */
const FACTS = `
WITH relations AS (${RELATIONS}),
tables AS (SELECT * FROM relations WHERE relkind = 'r' AND relname LIKE $1)
SELECT 'table ' || t.relname AS subject, 'ordinary table' AS value FROM tables t
UNION ALL
SELECT 'column ' || t.relname || '.' || a.attname,
	concat_ws(' | ',
		'position ' || a.attnum,
		'type ' || pg_catalog.format_type(a.atttypid, a.atttypmod),
		CASE WHEN a.attnotnull THEN 'not null' ELSE 'nullable' END,
		'default ' || coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '(none)'),
		'identity ' || CASE a.attidentity WHEN '' THEN '(none)' ELSE a.attidentity::text END,
		'generated ' || CASE a.attgenerated WHEN '' THEN '(none)' ELSE a.attgenerated::text END,
		'collation ' || coalesce(co.collname, '(none)'))
FROM tables t
JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation AND a.attcollation <> (
	SELECT typcollation FROM pg_catalog.pg_type ty WHERE ty.oid = a.atttypid)
UNION ALL
SELECT 'constraint ' || t.relname || '.' || k.conname,
	concat_ws(' | ',
		'kind ' || CASE k.contype WHEN 'p' THEN 'primary key' WHEN 'u' THEN 'unique'
			WHEN 'f' THEN 'foreign key' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion'
			ELSE k.contype::text END,
		pg_catalog.pg_get_constraintdef(k.oid, true),
		CASE WHEN k.convalidated THEN 'validated' ELSE 'not validated' END)
FROM tables t JOIN pg_catalog.pg_constraint k ON k.conrelid = t.oid
UNION ALL
SELECT 'index ' || t.relname || '.' || ic.relname,
	concat_ws(' | ',
		pg_catalog.pg_get_indexdef(i.indexrelid),
		CASE WHEN i.indisunique THEN 'unique' ELSE 'not unique' END,
		CASE WHEN i.indisprimary THEN 'primary' ELSE 'not primary' END,
		CASE WHEN i.indisvalid THEN 'valid' ELSE 'invalid' END,
		'predicate ' || coalesce(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '(none)'))
FROM tables t
JOIN pg_catalog.pg_index i ON i.indrelid = t.oid
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
UNION ALL
SELECT 'sequence ' || s.relname,
	concat_ws(' | ',
		'owned by ' || t.relname || '.' || a.attname,
		'type ' || pg_catalog.format_type(q.seqtypid, NULL),
		'start ' || q.seqstart, 'increment ' || q.seqincrement,
		'min ' || q.seqmin, 'max ' || q.seqmax,
		CASE WHEN q.seqcycle THEN 'cycle' ELSE 'no cycle' END)
FROM tables t
JOIN pg_catalog.pg_depend dep ON dep.refobjid = t.oid AND dep.deptype = 'a'
	AND dep.classid = 'pg_catalog.pg_class'::regclass
JOIN relations s ON s.oid = dep.objid AND s.relkind = 'S'
JOIN pg_catalog.pg_sequence q ON q.seqrelid = s.oid
JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
ORDER BY 1`;

/** Every catalog fact about the tables whose name matches `tablePattern`. */
export async function readCatalog(
	pool: Pool,
	tablePattern: string,
): Promise<CatalogFact[]> {
	const result = await pool.query<FactRow>(FACTS, [tablePattern]);
	return result.rows.map((row) => ({ subject: row.subject, value: row.value }));
}

/** Facts about `table` itself and everything that belongs to it. */
export function factsOutsideTable(
	facts: readonly CatalogFact[],
	table: string,
): CatalogFact[] {
	return facts.filter(
		(fact) =>
			!new RegExp(
				`^(table ${table}$|(column|constraint|index) ${table}\\.)`,
				"u",
			).test(fact.subject),
	);
}

/**
 * Every difference between two catalogs, one line each. An empty list is the
 * claim "these two databases have the same schema".
 */
export function compareCatalogs(
	left: { readonly label: string; readonly facts: readonly CatalogFact[] },
	right: { readonly label: string; readonly facts: readonly CatalogFact[] },
): string[] {
	const leftFacts = new Map(left.facts.map((f) => [f.subject, f.value]));
	const rightFacts = new Map(right.facts.map((f) => [f.subject, f.value]));
	const differences: string[] = [];
	for (const subject of [
		...new Set([...leftFacts.keys(), ...rightFacts.keys()]),
	].sort()) {
		const leftValue = leftFacts.get(subject);
		const rightValue = rightFacts.get(subject);
		if (leftValue === rightValue) continue;
		if (leftValue === undefined)
			differences.push(`${subject}: only in ${right.label} (${rightValue})`);
		else if (rightValue === undefined)
			differences.push(`${subject}: only in ${left.label} (${leftValue})`);
		else
			differences.push(
				`${subject}: ${left.label} has (${leftValue}); ${right.label} has (${rightValue})`,
			);
	}
	return differences;
}
