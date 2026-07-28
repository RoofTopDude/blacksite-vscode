import { describe, expect, it } from "vitest";
import { classifyQuery, describeForConfirmation, isReadOnly } from "../../src/data/query-guard.js";

describe("classifyQuery — UPDATE/DELETE without a top-level WHERE", () => {
  it("treats a plain unfiltered UPDATE as destructive", () => {
    const c = classifyQuery("UPDATE users SET active = 0");
    expect(c.overall).toBe("destructive");
    expect(c.destructive).toBe(true);
  });

  it("treats an UPDATE with a top-level WHERE as an ordinary write", () => {
    const c = classifyQuery("UPDATE users SET active = 0 WHERE id = 1");
    expect(c.overall).toBe("write");
    expect(c.destructive).toBe(false);
  });

  it("does not let a WHERE inside a subquery stand in for a top-level filter", () => {
    // No clause restricts which rows of `users` get updated — every row is hit — even
    // though the text contains "WHERE" inside the nested SELECT.
    const c = classifyQuery("UPDATE users SET name = (SELECT name FROM archive WHERE id = users.id)");
    expect(c.overall).toBe("destructive");
    expect(c.destructive).toBe(true);
    expect(describeForConfirmation(c)).toMatch(/Destructive operation/);
  });

  it("still recognizes a genuine top-level WHERE alongside a subquery that also has one", () => {
    const c = classifyQuery("DELETE FROM t WHERE id IN (SELECT id FROM u WHERE flag = 1)");
    expect(c.overall).toBe("write");
    expect(c.destructive).toBe(false);
  });

  it("is not fooled by the literal word WHERE inside a string literal", () => {
    const c = classifyQuery("UPDATE notes SET body = 'no WHERE clause here'");
    expect(c.overall).toBe("destructive");
  });
});

describe("classifyQuery — read-only fast path", () => {
  it("classifies a SELECT as read-only", () => {
    expect(isReadOnly("SELECT * FROM users")).toBe(true);
  });

  it("classifies DROP as destructive", () => {
    const c = classifyQuery("DROP TABLE users");
    expect(c.overall).toBe("destructive");
  });
});
