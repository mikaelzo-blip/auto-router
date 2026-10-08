import test from "node:test";
import assert from "node:assert";
import { InMemoryDatabase, SchemaMigrator } from "../src/db/migrator.js";

test("SchemaMigrator - 3-phase safe rollout adds not-null column with backfill", () => {
  const db = new InMemoryDatabase();
  db.createTable("users", [
    { name: "id", type: "string", nullable: false },
    { name: "email", type: "string", nullable: false }
  ], [
    { id: "u1", email: "alice@example.com" },
    { id: "u2", email: "bob@example.com" }
  ]);

  const migrator = new SchemaMigrator(db);

  // Step 1: Add column as nullable
  migrator.addNullableColumn("users", "organization_id", "string");
  const tableAfterStep1 = db.getTable("users")!;
  assert.strictEqual(tableAfterStep1.columns.get("organization_id")?.nullable, true);
  assert.strictEqual(tableAfterStep1.rows[0]?.organization_id, null);

  // Step 2: Backfill data
  migrator.backfillColumn("users", "organization_id", (row) => `org_default_${row.id}`);
  assert.strictEqual(tableAfterStep1.rows[0]?.organization_id, "org_default_u1");
  assert.strictEqual(tableAfterStep1.rows[1]?.organization_id, "org_default_u2");

  // Step 3: Enforce NOT NULL constraint
  migrator.setNotNullConstraint("users", "organization_id");
  assert.strictEqual(tableAfterStep1.columns.get("organization_id")?.nullable, false);
});
