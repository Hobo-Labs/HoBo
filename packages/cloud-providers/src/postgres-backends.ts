/**
 * The PostgreSQL backend catalog: every PostgreSQL offering HoBo can name,
 * with what it realizes and where each fact was read.
 *
 * STATUS — read this first: this is a catalog of **cited claims**. Nothing
 * here has been provisioned, connected to, or exercised from this repository.
 * Each claim was read in the vendor's own documentation on
 * {@link POSTGRES_BACKEND_CATALOG_OBSERVED_ON} and carries that URL; a claim
 * that could not be confirmed from a primary source is recorded as `unknown`
 * with what is missing, and is never matched. No prices and no free-tier
 * allowances are recorded: both are volatile, and ranking input belongs in
 * `@hobo/pricing` with its own evidence, not in a capability table.
 *
 * Why it lives here and not in `@hobo/core`: the vocabulary and the parser are
 * core's (`parseDataStoreCatalogEntry`); the vendor facts are dated
 * observations that will be refreshed, and nothing depends on this package, so
 * a refresh rebuilds this package alone.
 *
 * Every entry is parsed at module load, so an unsourced assertion cannot ship:
 * the parser refuses a non-`unknown` claim with no dated source.
 */
import {
	type DataStoreCatalogEntry,
	type DataStoreProvider,
	type DataStoreProviderProfile,
	dataStoreCatalogEvidence,
	dataStoreProfileOf,
	parseDataStoreCatalogEntry,
} from "@hobo/core";

/** UTC day every source below was read. One sweep, one date. */
// public-contract: the observed-at date every catalog source carries.
export const POSTGRES_BACKEND_CATALOG_OBSERVED_ON = "2026-11-10";

function src(url: string, note: string) {
	return { url, checkedAt: POSTGRES_BACKEND_CATALOG_OBSERVED_ON, note };
}

type Source = ReturnType<typeof src>;
type Options = {
	readonly detail?: string;
	readonly features?: readonly string[];
	readonly stability?: "stable" | "preview" | "experimental";
};

function claim(realization: string) {
	return (offering: string, sources: readonly Source[], options?: Options) => ({
		offering,
		realization,
		sources: [...sources],
		detail: options?.detail ?? "",
		features: [...(options?.features ?? [])],
		stability: options?.stability ?? "stable",
	});
}

const native = claim("native");
const operator = claim("operator");
const unsupported = claim("unsupported");

/** Not confirmed from a primary source; `detail` says what is missing. */
function unknown(offering: string, detail: string) {
	return { offering, realization: "unknown", detail };
}

/** Both SQL offerings follow from one fact: it is a PostgreSQL server. */
function postgres(source: Source) {
	return [
		native("sql.relational", [source]),
		native("sql.transactions", [source]),
	];
}

const NOT_DOCUMENTED = "no statement found in the vendor pages read";

const NEON = "https://neon.com/docs";
const PRISMA = "https://www.prisma.io/docs/postgres/database";
const SUPABASE = "https://supabase.com/docs/guides";
const PLANETSCALE = "https://planetscale.com/docs/postgres";
const AZURE = "https://learn.microsoft.com/en-us/azure/postgresql";
const HORIZON = "https://learn.microsoft.com/azure/horizondb";
const RDS = "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide";
const AURORA = "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide";
const CLOUDSQL = "https://cloud.google.com/sql/docs/postgres";
const ALLOYDB = "https://cloud.google.com/alloydb/docs";
const PGDOC = "https://www.postgresql.org/docs/current";

const neonReplication = src(
	`${NEON}/guides/logical-replication-neon`,
	"covers Neon as the publisher and has a 'Neon as a subscriber' section; subscribers must use a direct, not pooled, connection; inactive slots are removed after about 40 hours",
);
const supabaseFeatures = src(
	`${SUPABASE}/getting-started/features`,
	"feature-status table: Database Postgres GA, Point-in-Time Recovery GA, Read Replicas GA; 'Every project is a full Postgres database'",
);
const supabaseConnect = src(
	`${SUPABASE}/database/connecting-to-postgres`,
	"host:port table: direct db.[project-id].supabase.co:5432; shared pooler (Supavisor) aws-[region].pooler.supabase.com:5432 session, :6543 transaction; dedicated pooler (PgBouncer) db.[project-id].supabase.co:6543 transaction only, paid plans",
);
const planetscaleConnect = src(
	`${PLANETSCALE}/connecting`,
	"port 5432 direct, port 6432 PgBouncer; 'All managed PgBouncers run in transaction pooling mode'; 'Session pooling is not offered'; username is {role}.{branch_id}; examples use sslmode=verify-full sslrootcert=system",
);
const planetscaleReplicas = src(
	`${PLANETSCALE}/scaling/replicas`,
	"'By default, production databases (excluding single node) are created with 2 replicas'; append |replica to the username on port 5432; 'our system will automatically elect a new primary node from the available replicas'",
);
const azureReliability = src(
	"https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql",
	"zone-redundant HA keeps a synchronous standby and fails over automatically (typically 60-120 seconds); 'uses an active-passive configuration where the primary server ... handles all database connections and queries'",
);
const azureReplicas = src(
	`${AZURE}/read-replica/concepts-read-replicas`,
	"up to five asynchronous read replicas, 'within the same region or across different global Azure regions'; not on the Burstable tier",
);
const azureLogical = src(
	`${AZURE}/configure-maintain/concepts-logical`,
	"native logical replication, pglogical and logical decoding; 'The publisher is the ... database that sends data', 'The subscriber is the ... database that receives data'; wal_level must be logical",
);
const azureEntra = src(
	`${AZURE}/security/security-entra-concepts`,
	"three modes: PostgreSQL authentication only, Microsoft Entra only, or both; 'This token is your password for signing in'; user tokens valid up to 1 hour",
);
const horizonOverview = src(
	`${HORIZON}/overview`,
	"'Azure HorizonDB is currently in preview'; limitations table: cross-region read replicas not yet available, connection pooling (PgBouncer) not yet available, backup retention fixed at seven days",
);
const horizonConnect = src(
	`${HORIZON}/connectivity/how-to-connect-query-guide`,
	"read-write endpoint and reader endpoint on port 5432 with sslmode=require; 'fully compatible with existing PostgreSQL clients, drivers, ORMs, and SQL syntax'",
);
const horizonContinuity = src(
	`${HORIZON}/backup-restore/concepts-business-continuity`,
	"'supports in region replicas ... Replicas also act as failover targets for primary cluster'; at least two compute replicas for zonal resilience",
);
const rdsLogical = src(
	`${RDS}/PostgreSQL.Concepts.General.FeatureSupport.LogicalReplication.html`,
	"'You can use logical replication to replicate data from source tables to target tables in RDS for PostgreSQL'; set rds.logical_replication to 1; 'The creation of a subscription in the target database creates a replication slot in the source database'",
);
const rdsIam = src(
	`${RDS}/UsingWithRDS.IAMDBAuth.html`,
	"'you don't need to use a password when you connect to a DB instance. Instead, you use an authentication token'; 'Each token has a lifetime of 15 minutes'",
);
const rdsProxy = src(
	`${RDS}/rds-proxy.howitworks.html`,
	"'By default, RDS Proxy can reuse a connection after each transaction in your session. This transaction-level reuse is called multiplexing'",
);
const rdsTls = src(
	`${RDS}/UsingWithRDS.SSL.html`,
	"'the database instance requires a trust certificate from Amazon RDS'; CAs are named 'Amazon RDS region-identifier Root CA ...' and shipped as downloadable certificate bundles",
);
const auroraIam = src(
	`${AURORA}/UsingWithRDS.IAMDBAuth.html`,
	"'you don't need to use a password when you connect to a DB cluster'; 'Each token has a lifetime of 15 minutes'",
);
const auroraGlobal = src(
	`${AURORA}/aurora-global-database.html`,
	"'An Aurora global database consists of one primary AWS Region where your data is written, and up to 10 read-only secondary AWS Regions'",
);
const cloudsqlLogical = src(
	`${CLOUDSQL}/replication/configure-logical-replication`,
	"'You can use logical replication and decoding features in Cloud SQL for PostgreSQL. These features enable logical replication workflows and change data capture (CDC) workflows'; the worked example runs CREATE SUBSCRIPTION on a Cloud SQL instance",
);
const cloudsqlPooling = src(
	`${CLOUDSQL}/managed-connection-pooling`,
	"'transaction (default): pools connections at a transaction level'; 'TCP port 5432: used for direct connections by the Postgres database server', 'TCP port 6432: used for direct connections by the Managed Connection Pooling server'",
);
const cloudsqlIam = src(
	`${CLOUDSQL}/iam-authentication`,
	"'IAM database authentication uses OAuth 2.0 access tokens, which are short-lived and valid for only one hour'",
);
const alloydbOverview = src(
	`${ALLOYDB}/overview`,
	"'a primary instance and multiple load-balanced read pool instances'; 'redundant nodes located in different zones, with automatic failover between them'",
);
const alloydbPooling = src(
	`${ALLOYDB}/configure-managed-connection-pooling`,
	"'Managed connection pooling listens on port 6432'; connection mode is 'transaction (default) or session'",
);
const pgLogical = src(
	`${PGDOC}/logical-replication.html`,
	"'Logical replication uses a publish and subscribe model with one or more subscribers subscribing to one or more publications on a publisher node'",
);
const pgStandby = src(
	`${PGDOC}/hot-standby.html`,
	"'Hot standby is the term used to describe the ability to connect to the server and run read-only queries while the server is in archive recovery or standby mode'",
);

const ENTRIES = [
	{
		provider: "neon-postgres",
		vendor: "Neon",
		product: "Neon Postgres",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${NEON}/connect/connection-pooling`,
				"product documentation carries no preview or beta marker on the pages read; no general-availability statement was read",
			),
		],
		claims: [
			...postgres(
				src(
					`${NEON}/connect/connect-securely`,
					"standard postgresql://[user]:[password]@[neon_hostname]/[dbname] connection string",
				),
			),
			native(
				"backup.pitr",
				[
					src(
						`${NEON}/introduction/branch-restore`,
						"instant restore 'lets you revert a Neon root branch to any earlier state within your plan's history window'",
					),
				],
				{
					detail:
						"root branches only; the history window differs by plan and was not read",
				},
			),
			native("replica.read", [
				src(
					`${NEON}/introduction/read-replicas`,
					"'Neon read replicas are independent computes designed to perform read operations on the same data'",
				),
			]),
			unsupported(
				"replica.multi-region",
				[
					src(
						`${NEON}/introduction/read-replicas`,
						"'Neon only supports creating read replicas in the same region as your database'",
					),
				],
				{
					detail:
						"the vendor's suggested alternative is logical replication to a separate project in another region",
				},
			),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			unknown("ha.failover", NOT_DOCUMENTED),
			native("cdc.stream", [neonReplication]),
			native("replicate.logical-publish", [neonReplication], {
				detail:
					"enable logical replication on the project; a connected subscriber keeps the compute from scaling to zero",
			}),
			native("replicate.logical-subscribe", [neonReplication]),
			native(
				"pool.transaction",
				[
					src(
						`${NEON}/connect/connection-pooling`,
						"'Neon uses PgBouncer in transaction mode'; 'Add -pooler to your endpoint ID'",
					),
				],
				{
					detail:
						"pooled endpoint is the same hostname with -pooler appended to the endpoint id; the unsuffixed hostname is direct",
					features: ["pgbouncer", "endpoint:hostname-suffix"],
				},
			),
			native(
				"auth.password",
				[
					src(
						`${NEON}/connect/connect-securely`,
						"user and password in the connection string; channel_binding=require uses SCRAM-SHA-256-PLUS",
					),
				],
				{ features: ["scram-sha-256"] },
			),
			unknown("auth.identity-token", NOT_DOCUMENTED),
			native("tls.public-ca", [
				src(
					`${NEON}/connect/connect-securely`,
					"'Neon uses the public ISRG Root X1 certificate issued by Let's Encrypt'; sslmode require, verify-ca and verify-full are supported",
				),
			]),
		],
	},
	{
		provider: "prisma-postgres",
		vendor: "Prisma",
		product: "Prisma Postgres",
		management: "managed",
		stability: "stable",
		stabilityBasis: "vendor-stated",
		stabilitySources: [
			src(
				"https://www.prisma.io/blog/prisma-postgres-the-future-of-serverless-databases",
				"'This post announced the General Availability of Prisma Postgres in February 2025'; direct TCP connections GA since October 2025",
			),
		],
		claims: [
			...postgres(
				src(
					`${PRISMA}/direct-connections`,
					"direct connection to db.prisma.io on port 5432 with any PostgreSQL client",
				),
			),
			unsupported(
				"backup.pitr",
				[
					src(
						`${PRISMA}/backups`,
						"'Snapshots are created daily'; 'Point-in-time recovery is coming to Prisma Postgres in November 2026'",
					),
				],
				{
					detail:
						"daily snapshots only at the observed date; the vendor announces PITR as coming, so re-check",
				},
			),
			unknown("replica.read", NOT_DOCUMENTED),
			unknown("replica.multi-region", NOT_DOCUMENTED),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			unknown("ha.failover", NOT_DOCUMENTED),
			unknown("cdc.stream", NOT_DOCUMENTED),
			unknown("replicate.logical-publish", NOT_DOCUMENTED),
			unknown("replicate.logical-subscribe", NOT_DOCUMENTED),
			native(
				"pool.transaction",
				[
					src(
						`${PRISMA}/connection-pooling`,
						"'a tenant-isolated PgBouncer instance running in transactional pool mode'; pooled hostname pooled.db.prisma.io, direct hostname db.prisma.io",
					),
				],
				{
					detail:
						"pooled and direct endpoints differ by hostname only (pooled.db.prisma.io vs db.prisma.io), same port 5432 and credentials",
					features: ["pgbouncer", "endpoint:hostname"],
				},
			),
			native("auth.password", [
				src(
					`${PRISMA}/connecting-to-your-database`,
					"database user and password generated in the Console; 'Both strings share the same credentials'",
				),
			]),
			unknown("auth.identity-token", NOT_DOCUMENTED),
			unknown(
				"tls.public-ca",
				"sslmode=require is mandatory, but the issuing certificate authority is not documented in the pages read",
			),
		],
	},
	{
		provider: "supabase-postgres",
		vendor: "Supabase",
		product: "Supabase Postgres",
		management: "managed",
		stability: "stable",
		stabilityBasis: "vendor-stated",
		stabilitySources: [supabaseFeatures],
		claims: [
			...postgres(supabaseFeatures),
			native(
				"backup.pitr",
				[
					src(
						`${SUPABASE}/platform/backups`,
						"'Pro, Team and Enterprise Plan projects can enable PITR as an add-on'; needs at least a Small compute add-on; worst-case RPO two minutes",
					),
				],
				{ detail: "paid add-on; replaces daily backups while enabled" },
			),
			native("replica.read", [supabaseFeatures]),
			native("replica.multi-region", [
				src(
					`${SUPABASE}/platform/read-replicas`,
					"'Deploy read-only databases across multiple regions'",
				),
			]),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native(
				"ha.failover",
				[
					src(
						`${SUPABASE}/database/multigres`,
						"Multigres 'High availability' runs Postgres across multiple nodes 'so reads and writes continue if a node fails'; Private Alpha, not covered by the uptime SLA",
					),
				],
				{
					stability: "experimental",
					detail:
						"Private Alpha only, on paid plans; Multigres projects lose PITR, Realtime and cross-region replicas",
				},
			),
			native("cdc.stream", [
				src(
					`${SUPABASE}/database/replication`,
					"manual replication uses Postgres logical replication for tools that support it",
				),
			]),
			native(
				"replicate.logical-publish",
				[
					src(
						`${SUPABASE}/database/postgres/setup-replication-external`,
						"create a publication and slot on the Supabase database, then subscribe from the external database; 'This needs a direct connection (not a Connection Pooler)'",
					),
				],
				{
					detail: "direct connection is IPv6 unless the IPv4 add-on is enabled",
				},
			),
			unknown(
				"replicate.logical-subscribe",
				"no vendor page read states that a project may subscribe to an external publisher; the backups page only mentions projects that 'use subscriptions'",
			),
			native("pool.transaction", [supabaseConnect], {
				detail:
					"transaction mode is port 6543 (shared pooler host, or the project host on paid plans); port 5432 is session mode on the pooler host and direct on the project host",
				features: ["supavisor", "pgbouncer", "endpoint:port-6543"],
			}),
			native("auth.password", [
				src(
					`${SUPABASE}/database/connecting-to-postgres`,
					"username and database password from the dashboard; password reset in project settings",
				),
			]),
			unknown("auth.identity-token", NOT_DOCUMENTED),
			unsupported(
				"tls.public-ca",
				[
					src(
						`${SUPABASE}/platform/ssl-enforcement`,
						"'download the Supabase CA certificate for your database' from Database Settings and add it to the trusted certificates; verify-full recommended",
					),
				],
				{ detail: "server certificates chain to the provider's own CA" },
			),
		],
	},
	{
		provider: "pgedge-cloud",
		vendor: "pgEdge",
		product: "pgEdge Distributed PostgreSQL: Cloud Edition",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				"https://docs.pgedge.com/cloud/",
				"no preview, beta or deprecation marker on the Cloud Edition overview; no general-availability statement was read",
			),
		],
		claims: [
			...postgres(
				src(
					"https://docs.pgedge.com/cloud/connecting/",
					"'Any client that can negotiate a connection using libpq can connect to the PostgreSQL server (port 5432)'",
				),
			),
			unknown(
				"backup.pitr",
				"Cloud backup stores hold pgBackRest backups, but point-in-time restore in the Cloud Edition was not confirmed",
			),
			unknown("replica.read", NOT_DOCUMENTED),
			native(
				"replica.multi-region",
				[
					src(
						"https://docs.pgedge.com/cloud/",
						"'single node or fully-distributed PostgreSQL, deployable across multiple cloud regions or data centers'; clusters are provisioned on AWS, Azure and Google Cloud",
					),
				],
				{
					detail:
						"the other-region copies are writable cluster nodes, not read-only replicas",
				},
			),
			native(
				"write.multi-writer",
				[
					src(
						"https://www.pgedge.com/solutions/benefit/multi-master",
						"'asynchronous multi-master replication with conflict resolution' through the Spock extension; 'read and write transactions on any master node simultaneously'",
					),
				],
				{
					detail:
						"asynchronous, with timestamp-based conflict resolution; applies to a multi-node cluster, not a single node",
					features: ["spock", "asynchronous", "conflict-resolution"],
				},
			),
			unknown("ha.failover", NOT_DOCUMENTED),
			unknown("cdc.stream", NOT_DOCUMENTED),
			unknown("replicate.logical-publish", NOT_DOCUMENTED),
			unknown("replicate.logical-subscribe", NOT_DOCUMENTED),
			unknown("pool.transaction", NOT_DOCUMENTED),
			unknown(
				"auth.password",
				"the connecting page requires SSL and an SSH key but does not describe database credentials",
			),
			unknown("auth.identity-token", NOT_DOCUMENTED),
			unknown(
				"tls.public-ca",
				"clients must 'require an SSL connection', but the issuing certificate authority is not documented in the pages read",
			),
		],
	},
	{
		provider: "planetscale-postgres",
		vendor: "PlanetScale",
		product: "PlanetScale Postgres",
		management: "managed",
		stability: "stable",
		stabilityBasis: "vendor-stated",
		stabilitySources: [
			src(
				"https://planetscale.com/blog/planetscale-for-postgres",
				"'Update: PlanetScale for Postgres is now Generally Available.'",
			),
		],
		claims: [
			...postgres(
				src(
					"https://planetscale.com/blog/planetscale-for-postgres",
					"'We run Postgres v17'",
				),
			),
			native(
				"backup.pitr",
				[
					src(
						`${PLANETSCALE}/backups`,
						"'supports precise point-in-time recovery (PITR) using Write-Ahead Log (WAL) files'; restore to 'any timestamp between your oldest backup and 5 minutes prior to the current time'",
					),
				],
				{ detail: "a restore creates a new branch" },
			),
			native("replica.read", [planetscaleReplicas], {
				detail:
					"replicas are reached on port 5432 with |replica appended to the username; the local PgBouncer on 6432 does not route to replicas",
			}),
			unknown(
				"replica.multi-region",
				"the replicas page says the default replicas 'run within the primary cluster and its location' and points elsewhere for other locations; that page was not read",
			),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native("ha.failover", [planetscaleReplicas], {
				detail: "cluster is distributed across 3 availability zones",
			}),
			native("cdc.stream", [
				src(
					`${PLANETSCALE}/integrations/logical-cdc`,
					"'PlanetScale Postgres supports logical replication, enabling CDC through various tools and integrations'",
				),
			]),
			native(
				"replicate.logical-publish",
				[
					src(
						`${PLANETSCALE}/integrations/logical-cdc`,
						"requires wal_level = logical; 'create logical replication slots with the failover option enabled'",
					),
				],
				{
					detail:
						"a slot without failover enabled does not survive a switchover",
				},
			),
			native("replicate.logical-subscribe", [
				src(
					`${PLANETSCALE}/imports/postgres-migrate-walstream`,
					"'Create the subscription on PlanetScale referencing the existing slot': CREATE SUBSCRIPTION against an external publisher",
				),
			]),
			native("pool.transaction", [planetscaleConnect], {
				detail:
					"pooled and direct endpoints differ by port on the same host: 6432 is PgBouncer, 5432 is direct",
				features: ["pgbouncer", "endpoint:port-6432"],
			}),
			native("auth.password", [planetscaleConnect], {
				detail:
					"per-role credentials; the default postgres role is not for applications",
			}),
			unknown("auth.identity-token", NOT_DOCUMENTED),
			native("tls.public-ca", [planetscaleConnect], {
				detail:
					"read off the vendor's own connection examples, which verify against the system trust store (sslrootcert=system); the issuing CA is not named",
			}),
		],
	},
	{
		provider: "azure-postgres-flexible",
		vendor: "Microsoft Azure",
		product: "Azure Database for PostgreSQL flexible server",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				"https://learn.microsoft.com/en-us/azure/reliability/reliability-database-postgresql",
				"no preview marker; the page states uptime SLAs of 99.99%, 99.95% and 99.9% by high-availability configuration",
			),
		],
		yardProductId: "azure.postgres-flexible/v1",
		claims: [
			...postgres(azureLogical),
			native(
				"backup.pitr",
				[
					src(
						`${AZURE}/backup-restore/concepts-backup-restore`,
						"'You can then do a point-in-time recovery (PITR) within a retention period that you specify'; retention 7 (default) to 35 days",
					),
				],
				{ detail: "a restore always creates a new server" },
			),
			native("replica.read", [azureReplicas]),
			native("replica.multi-region", [azureReplicas], {
				detail: "promotion of a cross-region replica is manual",
			}),
			unsupported("write.multi-writer", [azureReliability]),
			native("ha.failover", [azureReliability], {
				detail: "General Purpose and Memory Optimized tiers only",
			}),
			native("cdc.stream", [azureLogical]),
			native("replicate.logical-publish", [azureLogical]),
			native("replicate.logical-subscribe", [azureLogical]),
			native(
				"pool.transaction",
				[
					src(
						`${AZURE}/connectivity/concepts-pgbouncer`,
						"built-in PgBouncer 'runs on port 6432 on your database server'; 'use the same host name, but change the port to 6432'; pgbouncer.pool_mode defaults to transaction",
					),
				],
				{
					detail:
						"pooled and direct endpoints differ by port on the same host: 6432 is PgBouncer, 5432 is direct; not on the Burstable tier; opt-in per server",
					features: ["pgbouncer", "endpoint:port-6432"],
				},
			),
			native("auth.password", [azureEntra]),
			native("auth.identity-token", [azureEntra], {
				detail:
					"Microsoft Entra access token used as the password; system-assigned managed identity tokens are valid up to 24 hours",
				features: ["microsoft-entra", "token-ttl:1h"],
			}),
			native(
				"tls.public-ca",
				[
					src(
						`${AZURE}/security/security-tls`,
						"server certificates are 'anchored by the following root CAs': DigiCert Global Root G2 and Microsoft RSA Root CA 2017",
					),
				],
				{
					detail:
						"the vendor names the roots; that DigiCert Global Root G2 is in common public trust stores is this catalog's reading, not a vendor statement. Do not pin intermediates",
				},
			),
		],
	},
	{
		provider: "azure-horizondb",
		vendor: "Microsoft Azure",
		product: "Azure HorizonDB",
		management: "managed",
		stability: "preview",
		stabilityBasis: "vendor-stated",
		stabilitySources: [horizonOverview],
		claims: [
			...postgres(horizonConnect),
			native(
				"backup.pitr",
				[
					src(
						`${HORIZON}/backup-restore/concepts-backup-restore`,
						"WAL archiving with periodic snapshots 'supports point-in-time restore (PITR)'; retention seven days; restore point at least five minutes in the past",
					),
				],
				{ detail: "retention is fixed at seven days during preview" },
			),
			native("replica.read", [horizonConnect, horizonContinuity], {
				detail:
					"reader endpoint is <cluster>-reader.<region>.horizondb.azure.com; in-region only",
			}),
			unsupported("replica.multi-region", [horizonOverview]),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native("ha.failover", [horizonContinuity]),
			unknown("cdc.stream", NOT_DOCUMENTED),
			unknown("replicate.logical-publish", NOT_DOCUMENTED),
			unknown("replicate.logical-subscribe", NOT_DOCUMENTED),
			unsupported("pool.transaction", [horizonOverview], {
				detail:
					"the vendor suggests an external pooler until built-in pooling ships",
			}),
			native("auth.password", [
				src(
					`${HORIZON}/connectivity/connect-java`,
					"quickstart connects with a username and password over sslmode=require",
				),
			]),
			unknown(
				"auth.identity-token",
				"Microsoft Entra sign-in is mentioned for the VS Code extension only; no HorizonDB authentication page was read",
			),
			unknown(
				"tls.public-ca",
				"TLS is required, but the HorizonDB TLS page naming the root CAs was not read",
			),
		],
	},
	{
		provider: "aws-rds-postgres",
		vendor: "Amazon Web Services",
		product: "Amazon RDS for PostgreSQL",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${RDS}/USER_PIT.html`,
				"no preview marker in the Amazon RDS User Guide pages read",
			),
		],
		yardProductId: "aws.rds-postgres/v1",
		claims: [
			...postgres(rdsLogical),
			native("backup.pitr", [
				src(
					`${RDS}/USER_PIT.html`,
					"'You can restore to any point in time within your backup retention period'",
				),
			]),
			native("replica.read", [
				src(
					`${RDS}/USER_PostgreSQL.Replication.ReadReplicas.html`,
					"'RDS for PostgreSQL uses native replication mechanisms of PostgreSQL to keep read replicas up to date'",
				),
			]),
			unknown(
				"replica.multi-region",
				"RDS documents cross-Region read replicas generically; the per-engine availability table for PostgreSQL was not read",
			),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native("ha.failover", [
				src(
					`${RDS}/Concepts.MultiAZSingleStandby.html`,
					"Multi-AZ 'automatically provisions and maintains a synchronous standby replica in a different Availability Zone'; PostgreSQL is listed among the engines using the failover technology",
				),
			]),
			native("cdc.stream", [rdsLogical]),
			native("replicate.logical-publish", [rdsLogical]),
			native("replicate.logical-subscribe", [rdsLogical]),
			native("pool.transaction", [rdsProxy], {
				detail:
					"RDS Proxy is a separate resource with its own endpoint hostname; the DB instance endpoint is direct. Pinned sessions are not multiplexed",
				features: ["rds-proxy", "endpoint:separate-host"],
			}),
			native("auth.password", [rdsIam]),
			native("auth.identity-token", [rdsIam], {
				detail:
					"AWS IAM authentication token (Signature Version 4) used as the password",
				features: ["aws-iam", "token-ttl:15m"],
			}),
			unsupported("tls.public-ca", [rdsTls], {
				detail:
					"server certificates chain to Amazon RDS's own regional CAs; clients need the RDS certificate bundle",
			}),
		],
	},
	{
		provider: "aws-aurora-postgres",
		vendor: "Amazon Web Services",
		product: "Amazon Aurora PostgreSQL-Compatible Edition",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${AURORA}/aurora-pitr.html`,
				"no preview marker in the Amazon Aurora User Guide pages read",
			),
		],
		yardProductId: "aws.aurora-serverless-postgres/v1",
		claims: [
			...postgres(
				src(
					`${AURORA}/AuroraPostgreSQL.Replication.Logical.html`,
					"PostgreSQL logical replication with Aurora PostgreSQL: publisher, publication, subscriber, subscription",
				),
			),
			native("backup.pitr", [
				src(
					`${AURORA}/aurora-pitr.html`,
					"'You can restore to any point in time within your backup retention period'",
				),
			]),
			native(
				"replica.read",
				[
					src(
						`${AURORA}/Aurora.Replication.html`,
						"'An Aurora DB cluster can contain up to 15 Aurora Replicas', reached through the cluster's reader endpoint",
					),
				],
				{ detail: "the reader endpoint is a separate hostname" },
			),
			native("replica.multi-region", [auroraGlobal], {
				detail: "Aurora global database",
			}),
			unsupported("write.multi-writer", [auroraGlobal], {
				detail:
					"one writer Region; global write forwarding relays writes to it and is not multi-writer",
			}),
			native("ha.failover", [
				src(
					`${AURORA}/Concepts.AuroraHighAvailability.html`,
					"'If the primary instance in a DB cluster fails, Aurora automatically fails over to a new primary instance'",
				),
			]),
			native("cdc.stream", [
				src(
					`${AURORA}/AuroraPostgreSQL.Replication.Logical.html`,
					"'The source, or publisher, sends WAL data for the specified tables to one or more recipients (subscriber)'",
				),
			]),
			native("replicate.logical-publish", [
				src(
					`${AURORA}/AuroraPostgreSQL.Replication.Logical.html`,
					"using PostgreSQL logical replication with Aurora: the publisher sends WAL data to subscribers",
				),
			]),
			unknown(
				"replicate.logical-subscribe",
				"the page read describes the publisher/subscriber model; no sentence read states an Aurora cluster may be the subscriber",
			),
			native(
				"pool.transaction",
				[
					src(
						`${AURORA}/rds-proxy.howitworks.html`,
						"'By default, RDS Proxy can reuse a connection after each transaction in your session'",
					),
				],
				{
					detail:
						"RDS Proxy is a separate resource with its own endpoint hostname; cluster endpoints are direct",
					features: ["rds-proxy", "endpoint:separate-host"],
				},
			),
			native("auth.password", [auroraIam]),
			native("auth.identity-token", [auroraIam], {
				detail: "AWS IAM authentication token used as the password",
				features: ["aws-iam", "token-ttl:15m"],
			}),
			unsupported(
				"tls.public-ca",
				[
					src(
						`${AURORA}/UsingWithRDS.SSL.html`,
						"'the database instance requires a trust certificate from Amazon RDS'; download certificate bundles for Aurora",
					),
				],
				{
					detail:
						"server certificates chain to Amazon RDS's own CAs; clients need the certificate bundle",
				},
			),
		],
	},
	{
		provider: "gcp-cloudsql-postgres",
		vendor: "Google Cloud",
		product: "Cloud SQL for PostgreSQL",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${CLOUDSQL}/replication`,
				"no preview marker on the Cloud SQL for PostgreSQL pages read",
			),
		],
		yardProductId: "gcp.cloud-sql-postgres/v1",
		claims: [
			...postgres(cloudsqlLogical),
			native(
				"backup.pitr",
				[
					src(
						`${CLOUDSQL}/backup-recovery/pitr`,
						"'A point-in-time recovery always creates a new instance; you cannot perform a PITR to an existing instance'",
					),
				],
				{ detail: "a restore always creates a new instance" },
			),
			native("replica.read", [
				src(
					`${CLOUDSQL}/replication`,
					"supported replica types: read replicas, cross-region read replicas, cascading read replicas, external read replicas",
				),
			]),
			native("replica.multi-region", [
				src(
					`${CLOUDSQL}/replication`,
					"'Cross-region read replicas' are a supported replica type",
				),
			]),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native("ha.failover", [
				src(
					`${CLOUDSQL}/high-availability`,
					"'In the event of an instance or zone failure, the standby instance becomes the new primary instance'",
				),
			]),
			native("cdc.stream", [cloudsqlLogical]),
			native("replicate.logical-publish", [cloudsqlLogical]),
			native("replicate.logical-subscribe", [cloudsqlLogical]),
			native("pool.transaction", [cloudsqlPooling], {
				detail:
					"pooled and direct endpoints differ by port: 6432 is Managed Connection Pooling, 5432 is direct",
				features: ["managed-connection-pooling", "endpoint:port-6432"],
			}),
			native("auth.password", [
				src(
					`${CLOUDSQL}/replication/configure-logical-replication`,
					"connection strings use a PostgreSQL user with a password",
				),
			]),
			native("auth.identity-token", [cloudsqlIam], {
				detail: "Google Cloud IAM OAuth 2.0 access token used as the password",
				features: ["gcp-iam", "token-ttl:1h"],
			}),
			unknown(
				"tls.public-ca",
				"three server-CA hierarchies are offered; the per-instance option is 'an internal CA dedicated to each Cloud SQL instance'. Whether any option chains to a public root, and which is the default, was not confirmed",
			),
		],
	},
	{
		provider: "gcp-alloydb",
		vendor: "Google Cloud",
		product: "AlloyDB for PostgreSQL",
		management: "managed",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${ALLOYDB}/overview`,
				"no preview marker on the AlloyDB for PostgreSQL pages read",
			),
		],
		claims: [
			...postgres(alloydbOverview),
			native("backup.pitr", [
				src(
					`${ALLOYDB}/backup/overview`,
					"continuous backup and recovery 'lets you restore an existing cluster to any moment from its recent history, with microsecond granularity, by using point-in-time recovery (PITR)'",
				),
			]),
			native("replica.read", [alloydbOverview], {
				detail: "read pool instances",
			}),
			native("replica.multi-region", [
				src(
					`${ALLOYDB}/cross-region-replication/about-cross-region-replication`,
					"cross-region replication 'lets you create secondary clusters and instances from a primary cluster in different regions'",
				),
			]),
			unknown("write.multi-writer", NOT_DOCUMENTED),
			native("ha.failover", [alloydbOverview]),
			unknown("cdc.stream", NOT_DOCUMENTED),
			unknown("replicate.logical-publish", NOT_DOCUMENTED),
			unknown("replicate.logical-subscribe", NOT_DOCUMENTED),
			native("pool.transaction", [alloydbPooling], {
				detail:
					"pooled and direct endpoints differ by port: 6432 is managed connection pooling; session mode is also selectable",
				features: ["managed-connection-pooling", "endpoint:port-6432"],
			}),
			native("auth.password", [
				src(
					`${ALLOYDB}/database-users/about`,
					"'a database user that authenticates with the database directly using a username and password, also known as built-in authentication'",
				),
			]),
			native(
				"auth.identity-token",
				[
					src(
						`${ALLOYDB}/manage-iam-authn`,
						"'IAM authentication complements database authentication through standard PostgreSQL users'",
					),
				],
				{
					detail: "token lifetime was not read",
					features: ["gcp-iam"],
				},
			),
			unknown(
				"tls.public-ca",
				"the server certificate authority is not documented in the pages read",
			),
		],
	},
	{
		provider: "self-hosted-postgres",
		vendor: "PostgreSQL Global Development Group",
		product: "PostgreSQL, self-managed on registered compute",
		management: "self-hosted",
		stability: "stable",
		stabilityBasis: "inferred",
		stabilitySources: [
			src(
				`${PGDOC}/logical-replication.html`,
				"the manual for the current supported release; 'current' is the project's stable documentation",
			),
		],
		claims: [
			...postgres(pgLogical),
			operator(
				"backup.pitr",
				[
					src(
						`${PGDOC}/continuous-archiving.html`,
						"continuous archiving 'supports point-in-time recovery: it is possible to restore the database to its state at any time since your base backup was taken'",
					),
				],
				{
					detail:
						"the engine can do it; the operator configures WAL archiving, takes base backups, stores them off the host and rehearses restores",
				},
			),
			operator("replica.read", [pgStandby], {
				detail: "the operator provisions and feeds the standby host",
			}),
			operator("replica.multi-region", [pgStandby], {
				detail:
					"a standby in another region is a second host the operator provisions, on a provider that offers that region",
			}),
			unsupported(
				"write.multi-writer",
				[
					src(
						`${PGDOC}/different-replication-solutions.html`,
						"on synchronous multimaster replication: 'PostgreSQL does not offer this type of replication'",
					),
				],
				{ detail: "core PostgreSQL; extensions are out of scope here" },
			),
			operator(
				"ha.failover",
				[
					src(
						`${PGDOC}/warm-standby-failover.html`,
						"'PostgreSQL does not provide the system software required to identify a failure on the primary and notify the standby database server'",
					),
				],
				{
					detail:
						"failure detection, promotion and client re-pointing are the operator's",
				},
			),
			native("cdc.stream", [pgLogical]),
			native("replicate.logical-publish", [pgLogical]),
			native("replicate.logical-subscribe", [pgLogical]),
			operator(
				"pool.transaction",
				[
					src(
						"https://www.pgbouncer.org/features.html",
						"PgBouncer transaction pooling: 'A server connection is assigned to a client only during a transaction'",
					),
				],
				{
					detail:
						"a pooler is separate software the operator runs; its endpoint is whatever port the operator binds",
				},
			),
			native(
				"auth.password",
				[
					src(
						`${PGDOC}/auth-password.html`,
						"'The method scram-sha-256 performs SCRAM-SHA-256 authentication'",
					),
				],
				{ features: ["scram-sha-256"] },
			),
			unknown(
				"auth.identity-token",
				"no identity-provider token method was read in the manual pages consulted",
			),
			operator(
				"tls.public-ca",
				[
					src(
						`${PGDOC}/ssl-tcp.html`,
						"the server certificate and key are files the administrator supplies (server.crt, server.key in the data directory by default)",
					),
				],
				{
					detail:
						"the operator issues, installs and renews the certificate; whether it chains to a public CA is the operator's choice",
				},
			),
		],
	},
];

/**
 * Every PostgreSQL backend in the catalog, parsed. Order is the order
 * {@link postgresBackendProfiles} hands to a resolver, and it is not a
 * ranking: callers rank by cost and policy before resolving.
 */
// public-contract: the PostgreSQL backend catalog consumers read.
export const POSTGRES_BACKEND_CATALOG: readonly DataStoreCatalogEntry[] =
	Object.freeze(
		ENTRIES.map((entry, index) =>
			parseDataStoreCatalogEntry(entry, `POSTGRES_BACKEND_CATALOG[${index}]`),
		),
	);

/**
 * PostgreSQL-shaped products deliberately given no `DataStoreProvider` id.
 *
 * Amazon Aurora DSQL speaks the PostgreSQL wire protocol and is marketed as
 * PostgreSQL-compatible, but the vendor's own guidance replaces database
 * triggers with application logic and its authentication uses expiring tokens. A
 * backend that the relay's standby mechanism cannot keep current with logical
 * replication, and that is not behaviour-compatible, is not a PostgreSQL
 * backend for this catalog. It is recorded here so the decision is visible and
 * nobody re-derives it.
 */
// public-contract: products considered for the catalog and excluded, with the reason.
export const POSTGRES_BACKEND_EXCLUSIONS = Object.freeze([
	{
		vendor: "Amazon Web Services",
		product: "Amazon Aurora DSQL",
		reason:
			"PostgreSQL-compatible, not PostgreSQL: the vendor directs trigger logic to the application layer, authentication uses expiring tokens, and no logical replication support was found in the pages read. Requests against this catalog assume real PostgreSQL behaviour, so it has no provider id.",
		sources: [
			src(
				"https://docs.aws.amazon.com/aurora-dsql/latest/userguide/what-is-aurora-dsql.html",
				"'Aurora DSQL is PostgreSQL-compatible'; active-active architecture with single- and multi-Region availability targets",
			),
			src(
				"https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html",
				"'Application-level logic instead of database triggers': move trigger logic to application code",
			),
			src(
				"https://docs.aws.amazon.com/aurora-dsql/latest/userguide/SECTION_authentication-token.html",
				"authentication tokens expire in 15 minutes by default",
			),
		],
	},
]);

/** The catalog entry for one provider id, if the catalog has one. */
export function postgresBackend(
	provider: DataStoreProvider,
): DataStoreCatalogEntry | undefined {
	return POSTGRES_BACKEND_CATALOG.find((entry) => entry.provider === provider);
}

/** Resolver-ready profiles, derived from the claims in catalog order. */
export function postgresBackendProfiles(): readonly DataStoreProviderProfile[] {
	return Object.freeze(POSTGRES_BACKEND_CATALOG.map(dataStoreProfileOf));
}

/** Cited-versus-unknown claim counts per entry, in catalog order. */
export function postgresBackendEvidence() {
	return Object.freeze(POSTGRES_BACKEND_CATALOG.map(dataStoreCatalogEvidence));
}
