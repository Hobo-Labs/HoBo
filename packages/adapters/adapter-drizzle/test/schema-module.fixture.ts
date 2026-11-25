/**
 * A schema module in the form a consumer actually has one: named exports, read
 * through `import * as schema`. The namespace object that import yields is an
 * exotic `Module` object rather than a plain record, which is exactly the case
 * the ingestion boundary has to admit.
 */

import { column, table } from "./fixtures.js";

export const accounts = table("accounts", {
	id: column("id", { sqlType: "uuid", primary: true, notNull: true }),
});

export const notATable = "plain value";
