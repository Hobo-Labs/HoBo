import {
  createRawView,
  defineProjectionSink,
  type MongoRawDriver,
  type PostgresRawDriver,
  type RawResult,
} from "../src/raw-driver-escape-hatch.js";

function assertRawDriverTypes() {
  const postgresView = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "postgres",
      rawAccess: true,
      source: "projected",
    }),
  );

  const mongoView = createRawView(
    defineProjectionSink({
      name: "tickets",
      driver: "mongo",
      rawAccess: true,
      source: "projected",
    }),
  );

  const postgresRows: RawResult = postgresView.raw((pg: PostgresRawDriver) =>
    pg.query("select * from tickets where tenant_id = $1", ["tenant-a"], { tenantScope: "tenant-a" }),
  );
  const mongoRows: RawResult = mongoView.raw((mongo: MongoRawDriver) =>
    mongo.collection("tickets").find({ tenantId: "tenant-a" }, { tenantScope: "tenant-a" }),
  );

  // @ts-expect-error Postgres raw callbacks cannot use Mongo driver APIs.
  postgresView.raw((pg) => pg.collection("tickets").find({}));

  // @ts-expect-error Mongo raw callbacks cannot use Postgres driver APIs.
  mongoView.raw((mongo) => mongo.query("select * from tickets"));

  void postgresRows;
  void mongoRows;
}

void assertRawDriverTypes;
