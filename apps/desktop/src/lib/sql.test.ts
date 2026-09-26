import { describe, expect, it } from "vitest";
import { isReadOnly } from "./sql";

describe("isReadOnly", () => {
  it("accepte les lectures simples", () => {
    expect(isReadOnly("  -- commentaire\n SELECT 1")).toBe(true);
    expect(isReadOnly("/* x */ with a as (select 1) select * from a")).toBe(true);
    expect(isReadOnly("SELECT 1;")).toBe(true);
  });

  it("repère les écritures, même cachées", () => {
    for (const sql of [
      "DELETE FROM users",
      "update t set a=1",
      "SELECT 1; DROP TABLE users",
      "with d as (delete from sessions returning *) select count(*) from d",
      "SELECT * INTO OUTFILE '/tmp/x' FROM users",
      "EXPLAIN ANALYZE UPDATE users SET plan = 'pro'",
      "select 1 /* ; */ ; insert into t values (1)",
      "SELECT 'a\\'; DROP TABLE x; --'",
      "SELECT 1 # 2; DROP TABLE x",
    ]) {
      expect(isReadOnly(sql), sql).toBe(false);
    }
  });

  it("ignore les mots d'écriture dans les chaînes, commentaires et identifiants", () => {
    expect(isReadOnly("SELECT 'DROP TABLE x; DELETE' AS txt FROM logs -- update\n")).toBe(true);
    expect(isReadOnly(`select "update", created_at from "delete" where note = 'it''s; drop'`)).toBe(true);
    expect(isReadOnly("SELECT $$ drop table x $$ AS body")).toBe(true);
  });
});
