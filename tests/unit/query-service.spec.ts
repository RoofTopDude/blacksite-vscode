import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../src/data/database-manager.js";
import { QueryService } from "../../src/data/query-service.js";

/* The query guard decides what needs confirmation from SQL text; the read path must not depend
   on that classification being perfect. Whatever reaches it runs with the engine refusing writes. */

const open: DatabaseManager[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function database(): DatabaseManager {
  const db = new DatabaseManager(":memory:");
  db.open();
  db.driver.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('a'), ('b');");
  open.push(db);
  return db;
}

describe("QueryService read path", () => {
  it("holds a WITH … DELETE for confirmation instead of running it as a read", async () => {
    const db = database();
    const result = await new QueryService(db).run("WITH x AS (SELECT 1) DELETE FROM notes");
    expect(result).toMatchObject({ ok: false, kind: "blocked", needsConfirmation: true });
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM notes")?.n).toBe(2);
  });

  it("refuses a write at the engine even when the text passes as a read", () => {
    const db = database();
    expect(() => db.allReadOnly("WITH x AS (SELECT 1) DELETE FROM notes RETURNING id")).toThrow(/readonly/i);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM notes")?.n).toBe(2);
    // The connection is writable again afterwards.
    db.driver.run("INSERT INTO notes (body) VALUES ('c')");
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM notes")?.n).toBe(3);
  });

  it("returns rows for an ordinary read", async () => {
    const result = await new QueryService(database()).run("SELECT body FROM notes ORDER BY id");
    expect(result).toMatchObject({ ok: true, kind: "read", rows: [{ body: "a" }, { body: "b" }] });
  });
});
