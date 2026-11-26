import { aws, azure, database, service } from "../src/provider-options-contract.js";

database("db", { engine: "postgres", require: "managed" }).with(
  aws.rds({ multiAz: true, backupRetentionDays: 7 }),
  azure.flexibleServer({ haMode: "zoneRedundant" })
);

service("api").with(aws.fargate({ cpu: 512 }));

// @ts-expect-error fargate is a component/service option, not a database option.
database("db").with(aws.fargate({ cpu: 512 }));

// @ts-expect-error RDS multiAz is boolean.
database("db").with(aws.rds({ multiAz: "yes" }));
