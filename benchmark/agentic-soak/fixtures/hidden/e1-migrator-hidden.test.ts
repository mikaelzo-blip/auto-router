import test from "node:test";
import assert from "node:assert";
import { InMemoryDatabase, SchemaMigrator } from "../src/db/migrator.js";

test("Hidden: SchemaMigrator - setNotNullConstraint must fail if null values remain in table", () => {
  const db = new InMemoryDatabase();
  db.createTable("accounts", [
    { name: "id", type: "string", nullable: false }
  ], [
    { id: "acc1" },
    { id: "acc2" }
  ]);

  const migrator = new SchemaMigrator(db);
  migrator.addNullableColumn("accounts", "tier", "string");

  // Only partially backfill (leave acc2 null)
  const table = db.getTable("accounts")!;
  table.rows[0]!.tier = "premium";

  // Setting NOT NULL MUST throw an error because acc2 still has null!
  assert.throws(
    () => migrator.setNotNullConstraint("accounts", "tier"),
    /null/i,
    "Cannot apply NOT NULL constraint when null rows exist"
  );
});

test("Hidden: SchemaMigrator - idempotent addNullableColumn does not overwrite existing data", () => {
  const db = new InMemoryDatabase();
  db.createTable("products", [
    { name: "id", type: "string", nullable: false }
  ], [
    { id: "p1" }
  ]);

  const migrator = new SchemaMigrator(db);
  migrator.addNullableColumn("products", "status", "string");
  db.getTable("products")!.rows[0]!.status = "active";

  // Re-running addNullableColumn must be idempotent and NOT reset existing values to null!
  migrator.addNullableColumn("products", "status", "string");
  assert.strictEqual(db.getTable("products")!.rows[0]!.status, "active");
});
