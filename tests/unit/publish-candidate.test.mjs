import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const CADENCE_BIN = process.env.CADENCE_BIN ?? "cadence";

function buildAppCheckReport(tempDir) {
  const reportPath = join(tempDir, "app-check.json");
  const res = spawnSync(CADENCE_BIN, ["app", "check", "app", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.ok(
    res.status === 0 || res.status === 3,
    `cadence app check failed (${res.status}): ${res.stderr}`,
  );
  writeFileSync(reportPath, res.stdout);

  const assertCheck = spawnSync(
    "python3",
    [".github/scripts/assert-app-check.py", reportPath],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(assertCheck.status, 0, assertCheck.stderr);
  return reportPath;
}

test("publish.mjs DRY_RUN succeeds on refs/tags/v0.6.1 and refuses wrong tag or repository", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "minutes-pub-test-"));
  try {
    const reportPath = buildAppCheckReport(tempDir);
    const baseEnv = {
      ...process.env,
      APP_DIR: "app",
      APP_CHECK_JSON: reportPath,
      EXPECTED_REPOSITORY: "favcrm/cadence-app-meeting-minutes",
      GITHUB_REPOSITORY: "favcrm/cadence-app-meeting-minutes",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_REF: "refs/tags/v0.6.1",
      DRY_RUN: "1",
    };

    const ok = spawnSync("node", [".github/scripts/publish.mjs"], {
      cwd: ROOT,
      env: baseEnv,
      encoding: "utf8",
    });
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.entry.id, "meeting-minutes");
    assert.equal(parsed.entry.version, "0.6.1");
    assert.equal(
      parsed.entry.artifact.path,
      "marketplace/releases/meeting-minutes/0.6.1/upload.json",
    );
    assert.match(parsed.entry.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(parsed.native.ok, false);
    assert.equal(parsed.native.refusal, "app_check_content");

    const badTag = spawnSync("node", [".github/scripts/publish.mjs"], {
      cwd: ROOT,
      env: { ...baseEnv, GITHUB_REF: "refs/heads/main" },
      encoding: "utf8",
    });
    assert.notEqual(badTag.status, 0);
    assert.match(badTag.stderr, /refs\/tags\/v0\.6\.1/);

    const badRepo = spawnSync("node", [".github/scripts/publish.mjs"], {
      cwd: ROOT,
      env: { ...baseEnv, GITHUB_REPOSITORY: "favcrm/cadence-app-crm" },
      encoding: "utf8",
    });
    assert.notEqual(badRepo.status, 0);
    assert.match(badRepo.stderr, /favcrm\/cadence-app-meeting-minutes/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
