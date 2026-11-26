import type * as ProviderAwsContract from "../src/provider-aws.d.mts";
import type { AwsProvider } from "../src/provider-aws.d.mts";
import { type JsonObject } from "../src/json.js";


declare const aws: typeof ProviderAwsContract.aws;
declare const createAwsProvider: typeof ProviderAwsContract.createAwsProvider;
declare const createAwsMultiCloudShopPlan: typeof ProviderAwsContract.createAwsMultiCloudShopPlan;

const provider: AwsProvider = createAwsProvider();
const rds = aws.with.rds({ engine: "postgres", instanceClass: "db.t4g.medium", storageGb: 50 });
const fargate = aws.with.fargate({ cpu: 512, memoryMb: 1024, publicIngress: false });
const appRunner = aws.with.appRunner({ ingress: "public" });
const manifest = provider.capabilityManifest();
const client = provider.client("database", {
  endpoint: "postgres://fixture",
  arn: "arn:aws:rds:us-east-1:123:cluster:orders",
  secretRef: "svid://token/orders"
});
const emission = provider.realize(createAwsMultiCloudShopPlan());

rds.options.storageGb satisfies number;
fargate.options.memoryMb satisfies number;
appRunner.options.ingress satisfies "public" | "private";
client.connectionString satisfies string;
emission satisfies JsonObject;
manifest.capabilities[0].resourceClasses satisfies string[];

// @ts-expect-error RDS options reject untyped option escape hatches.
aws.with.rds({ rawTerraformResourceType: "aws_db_instance" });

// @ts-expect-error client is typed to declared AWS ports only.
provider.client("email", {});
