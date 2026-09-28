# Basketball Scoreboard Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the identified scoreboard reliability and write-access gaps while preserving the no-account, read-only display workflow.

**Architecture:** Keep the current vanilla ES modules + Workers + D1 design. Add server-issued high-entropy controller credentials stored only as hashes; retain room-code read access. Make offline actions explicit and bounded, freeze untrusted display clocks, test real D1/browser behavior, and align documentation with implementation.

**Tech Stack:** Cloudflare Workers, D1/SQLite, vanilla JavaScript ES modules, Node.js tests, Wrangler, Playwright (if available/installable in the project environment).

---

## File map

- `worker/rules.mjs`, `worker/handler.mjs`, `worker/store-d1.mjs`, `worker/index.js`: authorization, safe state transitions, durable idempotency, request bounds.
- `migrations/0002_control_auth.sql`: add nullable controller-token hash for existing rows (legacy active games fail closed; finished cards stay readable).
- `dev/fake-store.mjs`, `dev/smoke.mjs`, `dev/attack.mjs`, `dev/store.mjs`, `dev/parity.mjs`, `dev/mutate.mjs`: regression and mutation coverage.
- `public/js/api.js`, `public/js/store.js`, `public/js/views/{home,room,control,display}.js`: credential handoff, offline queue rules, display stale/error behavior.
- `dev/d1-check.mjs`, `.github/workflows/test.yml`, `package.json`: real SQLite/D1 and browser CI coverage.
- `README.md`, `CONTRIBUTING.md`, `docs/plans/basketball-scoreboard-design.md`: current operational behavior and deployment/migration guidance.

## Task 1: Define and test write authorization

- [x] Add failing tests: anonymous GET works; unauthenticated/invalid POST apply is forbidden; valid controller token works; reset is rejected unless the match is finished; legacy rows without a token cannot be controlled.
- [x] Run the focused tests and verify failures are the expected missing behavior.
- [x] Add migration, secure token creation/hash verification, response redaction, D1 adapter field support, and fake-store support.
- [x] Add browser fragment handoff from create → room → control; never attach credentials to GET/display requests.
- [x] Re-run focused tests and all existing tests.

## Task 2: Fix no-op and idempotency boundaries

- [x] Add a failing regression test for nonce-bearing early `clock_zero` not changing state/version.
- [x] Persist accepted request IDs durably rather than only retaining the last 30 IDs in the game JSON; preserve CAS atomicity and bounded cleanup.
- [x] Test duplicate replay after more than 30 intervening writes and verify no extra score/version change.
- [x] Add both regressions to mutation coverage; run the full suite.

## Task 3: Bound and make offline operations safe

- [x] Add failing store tests for queue overflow and disallowed delayed actions.
- [x] Enforce one shared in-memory/persisted queue limit; never silently truncate unacknowledged operations.
- [x] Queue only explicitly safe scoring/stat actions; reject or require reconnection for undo, clock transitions, finish, and reset.
- [x] Surface pending/unconfirmed actions to the operator; preserve strict FIFO drain and nonce reuse.
- [x] Run store tests and full test suite.

## Task 4: Make display stale/error states trustworthy

- [x] Add failing tests for invalid-room rendering and freezing the last trusted clock when stale.
- [x] Render loading, missing-room, and recoverable network states instead of leaving a blank display.
- [x] Freeze display clock/shot clock while stale; refresh immediately on recovery; do not emit stale zero-time events.
- [ ] Verify the active and recovered display behavior in a browser test.（未做：本仓库没有浏览器测试基建。已用 displayPhase 单元测试 + display.js 静态断言 + store 冻结行为测试覆盖；要上真浏览器验证需先引入 Playwright，见 Task 5）

## Task 5: Add real integration gates

- [ ] Make `dev/d1-check.mjs` safe for automated local D1 execution and include auth, migration, CAS, idempotency, and anonymous-read checks.
- [ ] Add a repeatable Wrangler local-D1 integration command and CI job.
- [ ] Add browser-level coverage for create → room → control auth, display read-only behavior, stale/error UI, and key offline queue feedback.
- [ ] Keep credentials and production D1 out of CI; never run write probes against production by default.

## Task 6: Align operational documentation

- [ ] Update README/CONTRIBUTING with control-link handling, legacy-game migration behavior, offline guarantees, test commands, and current CI coverage.
- [ ] Mark the design document as implemented; remove stale paths/platform descriptions and correct test/CI counts.
- [ ] Verify documentation references and commands against the actual scripts/configuration.

## Verification

- [ ] `npm test`
- [ ] Local Wrangler/D1 migration and `dev/d1-check.mjs` against the local Worker.
- [ ] Headless browser tests for the named end-to-end flows.
- [ ] `git diff --check` and review final diff for accidental changes/secrets.
