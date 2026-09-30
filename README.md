# @mesgme/serve-token-expiry

Warn before swamp serve tokens expire, so a service token does not lapse and
take its clients down silently.

This is a reusable model type for any swamp repo. It reads token metadata — never
secret material — from `swamp access token list --json`, classifies each active
token as `expired`, `warn`, or `ok`, and writes a `status` resource that a
workflow can act on (for example, pushing an ntfy alert).

## Install

```bash
swamp extension pull @mesgme/serve-token-expiry
```

## Model: `@mesgme/serve-token-expiry`

### Global arguments

| Argument     | Type   | Default   | Description                                                        |
| ------------ | ------ | --------- | ------------------------------------------------------------------ |
| `repoDir`    | string | required  | Absolute path to the swamp repo whose tokens are checked           |
| `warnDays`   | number | `7`       | Warn when a token expires within this many days                    |
| `swampBin`   | string | `"swamp"` | swamp executable. Set an absolute path under launchd (see below)   |
| `tokenNames` | string | `""`      | Comma-separated token names to check; empty means all active tokens |

### Method: `check`

Lists the tokens, classifies them against `warnDays`, and writes one `status`
resource. Read-only: it never reveals or alters a token secret.

```bash
swamp model create @mesgme/serve-token-expiry serve-token-expiry \
  --global-arg repoDir=/Users/you/dev/your-repo \
  --global-arg warnDays=7

swamp model method run serve-token-expiry check
swamp data get serve-token-expiry status --json
```

The `status` resource:

```json
{
  "tokens": [
    { "name": "ci-service-token", "status": "warn", "daysRemaining": 5, "expiresAt": "2026-10-06T00:00:00.000Z" }
  ],
  "needsWarning": true,
  "summary": "ci-service-token expires in 5 days (2026-10-06)"
}
```

- `expired` — expiry is at or before now.
- `warn` — `daysRemaining <= warnDays`. `daysRemaining` is always floored, never rounded.
- `ok` — anything else.
- Revoked tokens (`effectiveState != "active"`) are ignored.
- `summary` lists the tokens at risk, worst first.

## Running under swamp serve (launchd)

The serve daemon runs with launchd's minimal `PATH`, which does not include
`swamp`. Create the model with `swampBin` set to the absolute path from
`which swamp` (e.g. `/Users/you/.local/bin/swamp`) or the method will fail to
find the CLI.

## Example workflow

```yaml
name: token-expiry-check
jobs:
  - name: token-expiry-check
    steps:
      - name: check
        task:
          type: model_method
          modelIdOrName: serve-token-expiry
          methodName: check
      - name: notify
        dependsOn:
          - step: check
            condition:
              type: succeeded
        guard: >-
          ${{ data.latest("serve-token-expiry", "status").attributes.needsWarning != true }}
        task:
          type: model_method
          modelIdOrName: ntfy
          methodName: send
          inputs:
            title: swamp serve token expiring
            message: ${{ data.latest("serve-token-expiry", "status").attributes.summary }}
            priority: 4
```

A truthy guard means *skip*, so the notify step runs only while a token is at
risk.

## Development

```bash
DENO=$(swamp doctor extensions --json | jq -r '.denoPath')
$DENO check extensions/models/serve_token_expiry.ts
$DENO test extensions/models/serve_token_expiry_test.ts
```

## Licence

Apache-2.0 — see `LICENSE`.
