/**
 * @mesgme/serve-token-expiry — warn before swamp serve tokens expire.
 *
 * Reads token metadata from `swamp access token list --json` (no secret
 * material) and reports which tokens are near or past expiry. Nothing here is
 * repo-specific: point `repoDir` at any swamp repo.
 *
 * The `check` method runs the `swamp` CLI through `Deno.Command`. No model type
 * wraps the token-list API (checked with `swamp model type search token`), so
 * shelling out is not a bypass.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenStatus = "expired" | "warn" | "ok";

/** The subset of `swamp access token list --json` fields we rely on. */
export interface TokenInfo {
  name: string;
  effectiveState: string;
  expiresAt: string;
}

export interface EvaluatedToken {
  name: string;
  status: TokenStatus;
  daysRemaining: number;
  expiresAt: string;
}

export interface ExpiryReport {
  tokens: EvaluatedToken[];
  needsWarning: boolean;
  summary: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and returns its exit code and captured output. */
export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<CommandResult>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TokenSchema = z.object({
  name: z.string(),
  state: z.string(),
  effectiveState: z.string(),
  principalId: z.string(),
  principalEmail: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().optional(),
});

const TokenListSchema = z.array(TokenSchema);

const EvaluatedTokenSchema = z.object({
  name: z.string(),
  status: z.enum(["expired", "warn", "ok"]),
  daysRemaining: z.number(),
  expiresAt: z.string(),
});

const ExpiryReportSchema = z.object({
  tokens: z.array(EvaluatedTokenSchema),
  needsWarning: z.boolean(),
  summary: z.string(),
});

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Classify one token. `expired` wins over `warn`; the boundary is inclusive
 * on both ends (expiry at or before now is expired; `daysRemaining <= warnDays`
 * is warn).
 */
export function classifyToken(
  expiresAt: string,
  now: Date,
  warnDays: number,
): { status: TokenStatus; daysRemaining: number } {
  const daysRemaining = Math.floor(
    (new Date(expiresAt).getTime() - now.getTime()) / MS_PER_DAY,
  );
  if (new Date(expiresAt).getTime() <= now.getTime()) {
    return { status: "expired", daysRemaining };
  }
  if (daysRemaining <= warnDays) {
    return { status: "warn", daysRemaining };
  }
  return { status: "ok", daysRemaining };
}

function dateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function describe(token: EvaluatedToken): string {
  if (token.status === "expired") {
    return `${token.name} expired on ${dateOnly(token.expiresAt)}`;
  }
  const unit = token.daysRemaining === 1 ? "day" : "days";
  return `${token.name} expires in ${token.daysRemaining} ${unit} (${
    dateOnly(token.expiresAt)
  })`;
}

/**
 * Evaluate token expiry. Non-active (revoked) tokens are ignored, never
 * rounded, and warnings list worst-first (expired before warn, then fewest
 * days remaining).
 */
export function evaluateTokenExpiry(
  tokens: TokenInfo[],
  now: Date,
  warnDays: number,
  tokenNames: string[] = [],
): ExpiryReport {
  const evaluated: EvaluatedToken[] = [];
  for (const token of tokens) {
    if (token.effectiveState !== "active") continue;
    if (tokenNames.length > 0 && !tokenNames.includes(token.name)) continue;
    const { status, daysRemaining } = classifyToken(
      token.expiresAt,
      now,
      warnDays,
    );
    evaluated.push({
      name: token.name,
      status,
      daysRemaining,
      expiresAt: token.expiresAt,
    });
  }

  const rank: Record<TokenStatus, number> = { expired: 0, warn: 1, ok: 2 };
  evaluated.sort((a, b) =>
    rank[a.status] - rank[b.status] ||
    a.daysRemaining - b.daysRemaining ||
    a.name.localeCompare(b.name)
  );

  const problems = evaluated.filter((t) => t.status !== "ok");

  const needsWarning = problems.length > 0;

  let summary: string;
  if (needsWarning) {
    summary = problems.map(describe).join("; ");
  } else if (evaluated.length === 0) {
    summary = "no active serve tokens to check";
  } else {
    summary = `all ${evaluated.length} active serve token(s) healthy`;
  }

  return { tokens: evaluated, needsWarning, summary };
}

export function parseTokenList(stdout: string): TokenInfo[] {
  const parsed = TokenListSchema.parse(JSON.parse(stdout));
  return parsed.map((t) => ({
    name: t.name,
    effectiveState: t.effectiveState,
    expiresAt: t.expiresAt,
  }));
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/** Real runner: shell out through Deno.Command, capturing stdout/stderr. */
export const defaultCommandRunner: CommandRunner = async (cmd, args) => {
  const process = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await process.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
};

export async function loadTokens(
  runner: CommandRunner,
  swampBin: string,
  repoDir: string,
): Promise<TokenInfo[]> {
  const result = await runner(swampBin, [
    "access",
    "token",
    "list",
    "--repo-dir",
    repoDir,
    "--json",
  ]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${swampBin} access token list failed (exit ${result.code}): ${detail}`,
    );
  }
  return parseTokenList(result.stdout);
}

// ---------------------------------------------------------------------------
// Context type (minimal — only what we use)
// ---------------------------------------------------------------------------

type ModelContext = {
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, ...args: unknown[]) => void;
  };
};

type CheckContext = ModelContext & {
  globalArgs: {
    repoDir: string;
    warnDays: number;
    swampBin: string;
    tokenNames: string;
  };
};

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

export const model = {
  type: "@mesgme/serve-token-expiry",
  version: "2026.09.30.1",
  globalArguments: z.object({
    repoDir: z
      .string()
      .describe("Absolute path to the swamp repo whose tokens are checked."),
    warnDays: z
      .number()
      .default(7)
      .describe("Warn when a token expires within this many days."),
    swampBin: z
      .string()
      .default("swamp")
      .describe(
        "swamp executable. Under launchd the serve environment has a minimal " +
          "PATH — set this to the absolute path from `which swamp`.",
      ),
    tokenNames: z
      .string()
      .default("")
      .describe(
        "Comma-separated token names to check. Empty means all active tokens.",
      ),
  }),

  resources: {
    status: {
      description:
        "Result of the most recent token-expiry check — per-token status, " +
        "needsWarning, and a one-line summary.",
      schema: ExpiryReportSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },

  methods: {
    check: {
      description:
        "List swamp serve tokens, classify each as expired/warn/ok against " +
        "warnDays, and write a `status` resource. Read-only: never reveals " +
        "or alters token secrets.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: CheckContext,
      ) => {
        const { repoDir, warnDays, swampBin, tokenNames } = context.globalArgs;

        const names = tokenNames
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const tokens = await loadTokens(
          defaultCommandRunner,
          swampBin,
          repoDir,
        );
        const report = evaluateTokenExpiry(tokens, new Date(), warnDays, names);

        context.logger.info("Token expiry check: {summary}", {
          summary: report.summary,
        });

        const handle = await context.writeResource(
          "status",
          "status",
          report as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
