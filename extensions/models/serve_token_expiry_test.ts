/**
 * Tests for serve_token_expiry.ts — the pure expiry evaluator and the
 * injectable token-list loader.
 *
 * All tests inject a fixed `now`; none touch the real clock or a real
 * `swamp` binary.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type CommandResult,
  type CommandRunner,
  evaluateTokenExpiry,
  loadTokens,
  parseTokenList,
  type TokenInfo,
} from "./serve_token_expiry.ts";

const NOW = new Date("2026-10-01T00:00:00.000Z");

function token(
  name: string,
  expiresAt: string,
  effectiveState = "active",
): TokenInfo {
  return { name, effectiveState, expiresAt };
}

// ---------------------------------------------------------------------------
// evaluateTokenExpiry — status classification
// ---------------------------------------------------------------------------

Deno.test("token expiring in 5 days is warn and needsWarning (acceptance)", () => {
  const report = evaluateTokenExpiry(
    [token("puddle-ui-service", "2026-10-06T00:00:00.000Z")],
    NOW,
    7,
  );
  assertEquals(report.tokens[0].status, "warn");
  assertEquals(report.tokens[0].daysRemaining, 5);
  assertEquals(report.needsWarning, true);
  assertEquals(report.summary.includes("puddle-ui-service"), true);
  assertEquals(report.summary.includes("5 days"), true);
  assertEquals(report.summary.includes("2026-10-06"), true);
});

Deno.test("token expiring in 30 days is ok and needsWarning false", () => {
  const report = evaluateTokenExpiry(
    [token("admin-local", "2026-10-31T00:00:00.000Z")],
    NOW,
    7,
  );
  assertEquals(report.tokens[0].status, "ok");
  assertEquals(report.tokens[0].daysRemaining, 30);
  assertEquals(report.needsWarning, false);
});

Deno.test("6.9 days remaining floors to 6 and still warns", () => {
  const report = evaluateTokenExpiry(
    [token("admin-local", "2026-10-07T21:36:00.000Z")],
    NOW,
    7,
  );
  assertEquals(report.tokens[0].daysRemaining, 6);
  assertEquals(report.tokens[0].status, "warn");
  assertEquals(report.needsWarning, true);
});

Deno.test("already-expired token is expired and needsWarning", () => {
  const report = evaluateTokenExpiry(
    [token("admin-local", "2026-09-29T00:00:00.000Z")],
    NOW,
    7,
  );
  assertEquals(report.tokens[0].status, "expired");
  assertEquals(report.needsWarning, true);
});

Deno.test("an expired token sorts ahead of a warn token in the summary", () => {
  const report = evaluateTokenExpiry(
    [
      token("puddle-ui-service", "2026-10-06T00:00:00.000Z"),
      token("admin-local", "2026-09-29T00:00:00.000Z"),
    ],
    NOW,
    7,
  );
  assertEquals(report.tokens[0].name, "admin-local");
  assertEquals(report.summary.startsWith("admin-local"), true);
});

Deno.test("a revoked token is ignored", () => {
  const report = evaluateTokenExpiry(
    [
      token("admin-local", "2026-10-31T00:00:00.000Z"),
      token("dead-token", "2026-10-02T00:00:00.000Z", "revoked"),
    ],
    NOW,
    7,
  );
  assertEquals(report.tokens.length, 1);
  assertEquals(report.tokens[0].name, "admin-local");
  assertEquals(report.needsWarning, false);
});

Deno.test("tokenNames filter limits evaluation to named tokens", () => {
  const report = evaluateTokenExpiry(
    [
      token("puddle-ui-service", "2026-10-02T00:00:00.000Z"),
      token("admin-local", "2026-10-31T00:00:00.000Z"),
    ],
    NOW,
    7,
    ["admin-local"],
  );
  assertEquals(report.tokens.length, 1);
  assertEquals(report.tokens[0].name, "admin-local");
  assertEquals(report.needsWarning, false);
});

Deno.test("empty token list needs no warning", () => {
  const report = evaluateTokenExpiry([], NOW, 7);
  assertEquals(report.tokens.length, 0);
  assertEquals(report.needsWarning, false);
});

// ---------------------------------------------------------------------------
// parseTokenList — zod parsing of `swamp access token list --json`
// ---------------------------------------------------------------------------

Deno.test("parseTokenList parses the CLI array shape", () => {
  const stdout = JSON.stringify([
    {
      name: "puddle-ui-service",
      state: "active",
      effectiveState: "active",
      principalId: "user:abc",
      principalEmail: "user:abc",
      createdAt: "2026-09-30T15:02:24.599Z",
      expiresAt: "2026-12-29T15:02:24.599Z",
    },
  ]);
  const tokens = parseTokenList(stdout);
  assertEquals(tokens.length, 1);
  assertEquals(tokens[0].name, "puddle-ui-service");
  assertEquals(tokens[0].effectiveState, "active");
});

Deno.test("parseTokenList rejects non-array JSON", () => {
  let threw = false;
  try {
    parseTokenList(JSON.stringify({ nope: true }));
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// ---------------------------------------------------------------------------
// loadTokens — injectable command runner
// ---------------------------------------------------------------------------

function runnerReturning(result: CommandResult): CommandRunner {
  return () => Promise.resolve(result);
}

Deno.test("loadTokens passes the right args and parses output", async () => {
  let seenCmd = "";
  let seenArgs: string[] = [];
  const runner: CommandRunner = (cmd, args) => {
    seenCmd = cmd;
    seenArgs = args;
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([
        {
          name: "admin-local",
          state: "active",
          effectiveState: "active",
          principalId: "user:abc",
          principalEmail: "user:abc",
          createdAt: "2026-09-30T15:06:06.386Z",
          expiresAt: "2026-12-29T15:06:06.386Z",
        },
      ]),
      stderr: "",
    });
  };
  const tokens = await loadTokens(runner, "swamp", "/tmp/repo");
  assertEquals(seenCmd, "swamp");
  assertEquals(seenArgs, [
    "access",
    "token",
    "list",
    "--repo-dir",
    "/tmp/repo",
    "--json",
  ]);
  assertEquals(tokens.length, 1);
});

Deno.test("loadTokens throws a clear error on non-zero exit", async () => {
  await assertRejects(
    () =>
      loadTokens(
        runnerReturning({ code: 2, stdout: "", stderr: "boom" }),
        "swamp",
        "/tmp/repo",
      ),
    Error,
    "swamp access token list failed (exit 2): boom",
  );
});
