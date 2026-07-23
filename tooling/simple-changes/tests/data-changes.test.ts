import { describe, expect, test } from "bun:test";
import {
  classifyDataChange,
  dataChangeKinds,
} from "../../../skills/simple-changes/scripts/lib/data-changes.ts";

describe("provider-agnostic data-change discovery", () => {
  test("classifies migration, schema, backfill, and index conventions", () => {
    expect(classifyDataChange("db/migrations/0042_add_account.sql")).toBe(
      "migration-history"
    );
    expect(classifyDataChange("prisma/schema.prisma")).toBe(
      "schema-definition"
    );
    expect(classifyDataChange("database/backfills/fill-slugs.ts")).toBe(
      "backfill-or-seed"
    );
    expect(classifyDataChange("storage/search-mappings/products.json")).toBe(
      "index-or-projection"
    );
    expect(classifyDataChange("alembic/versions/0043_add_account.py")).toBe(
      "migration-history"
    );
    expect(classifyDataChange("db/migrate/20260723_add_account.rb")).toBe(
      "migration-history"
    );
  });

  test("recognizes query languages only in a data-system context", () => {
    expect(classifyDataChange("database/routines/recommendations.cypher")).toBe(
      "query-or-routine"
    );
    expect(classifyDataChange("data/queries/catalog.rq")).toBe(
      "query-or-routine"
    );
    expect(classifyDataChange("docs/example.sql")).toBeNull();
    expect(classifyDataChange("docs/versions/v2.md")).toBeNull();
  });

  test("returns each detected class once", () => {
    expect(
      dataChangeKinds([
        "db/migrations/001.sql",
        "db/migrations/002.sql",
        "database/schema.sql",
      ])
    ).toEqual(["migration-history", "schema-definition"]);
  });
});
