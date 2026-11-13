import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("Toolchain locks, app-storage/v1 migration integrity, and manifest honesty", () => {
  test("app-kit.lock.json matches vendored @cadence/app-kit@0.5.0 files byte-for-byte", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "app-kit.lock.json"), "utf8"));
    expect(lock.schema).toBe("cadence-app-kit-lock/1");
    expect(lock.source).toEqual({
      kind: "commit",
      repo: "favcrm/cadence",
      source_sha: "1918854fb264104789b80720369a215ac3f8c580",
    });
    expect(lock.version).toBe("0.5.0");
    for (const [rel, expectedHash] of Object.entries(lock.files)) {
      const actualHash = sha256(readFileSync(resolve(ROOT, "app-kit", rel)));
      expect(actualHash).toBe(expectedHash);
    }
  });

  test("screen-ui.lock.json matches committed .cadence-ui/cadence-screen-ui-1.0.0.tgz", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "screen-ui.lock.json"), "utf8"));
    expect(lock.package).toBe("@cadence/screen-ui@1.0.0");
    expect(lock.source.kind).toBe("commit");
    const archiveBytes = readFileSync(resolve(ROOT, ".cadence-ui", lock.archive.filename));
    expect(archiveBytes.length).toBe(lock.archive.bytes);
    expect(sha256(archiveBytes)).toBe(lock.archive.sha256);
  });

  test("app/app-storage.json pins exact sha256 of 001-initial.json and protects user titles", () => {
    const descriptor = JSON.parse(readFileSync(resolve(ROOT, "app/app-storage.json"), "utf8"));
    expect(descriptor.contract).toBe("app-storage/v1");
    expect(descriptor.app).toBe("meeting-minutes");
    expect(descriptor.record_kind).toBe("meeting");
    expect(descriptor.default_table).toBe("meetings");
    expect(descriptor.record_search_columns).toEqual([
      "title",
      "participants_text",
      "summary",
      "tags",
      "decisions",
      "followups",
      "transcript",
    ]);
    expect(descriptor.migrations).toHaveLength(1);

    const migrationBytes = readFileSync(resolve(ROOT, "app", descriptor.migrations[0].path));
    expect(descriptor.migrations[0].sha256).toBe(`sha256:${sha256(migrationBytes)}`);

    const writeSchema = descriptor.record_write_schema;
    expect(writeSchema.if.properties.before.properties.title_source.const).toBe("user");
    expect(writeSchema.then.properties.after.properties.title_source.const).toBe("user");
  });

  test("app/app.md declares 0.7.0, required contracts, and no forbidden pricing keys", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const raw = readFileSync(resolve(ROOT, "app/app.md"), "utf8");
    const lines = raw.split(/\r?\n/);
    const end = lines.findIndex((line, i) => i > 0 && line === "---");
    const manifest = parseYaml(lines.slice(1, end).join("\n"));

    expect(manifest.app).toBe("meeting-minutes");
    expect(manifest.version).toBe("0.7.0");
    expect(pkg.version).toBe(manifest.version);
    expect(manifest.needs.requires.contracts).toEqual({
      "app-screens": [1],
      "screen-records": [1],
      "screen-startup": [1],
      "app-storage": [1],
    });
    expect(manifest.listing.icon).toBe("assets/meeting-minutes.svg");
    const listingJson = JSON.stringify(manifest.listing).toLowerCase();
    expect(listingJson.includes('"cost"')).toBe(false);
    expect(listingJson.includes('"price"')).toBe(false);
    expect(listingJson.includes('"pricing"')).toBe(false);
  });

  test("app/skills bundles three valid skill packages and app/app-chat.json covers all navigation sections", () => {
    const skillsRoot = resolve(ROOT, "app/skills");
    const skillDirs = readdirSync(skillsRoot).sort();
    expect(skillDirs).toEqual([
      "followup-management",
      "minutes-consolidation",
      "transcript-intake",
    ]);

    for (const tag of skillDirs) {
      const manifest = JSON.parse(
        readFileSync(resolve(skillsRoot, tag, "skill.json"), "utf8"),
      );
      expect(Object.keys(manifest).sort()).toEqual(["files", "name", "schema"]);
      expect(manifest.schema).toBe(1);
      expect(manifest.name).toBe(tag);
      expect(manifest.files).toContain("SKILL.md");

      const entryRaw = readFileSync(resolve(skillsRoot, tag, "SKILL.md"), "utf8");
      const lines = entryRaw.split(/\r?\n/);
      expect(lines[0]).toBe("---");
      const end = lines.findIndex((line, idx) => idx > 0 && line === "---");
      expect(end).toBeGreaterThan(1);
      const frontmatter = parseYaml(lines.slice(1, end).join("\n"));
      expect(frontmatter.name).toBe(tag);
      expect(typeof frontmatter.description).toBe("string");
      expect(frontmatter.description.length).toBeGreaterThan(20);
      expect(frontmatter.description.length).toBeLessThanOrEqual(240);
    }

    const screenDecl = JSON.parse(
      readFileSync(resolve(ROOT, "app/screens/minutes/screens.json"), "utf8"),
    );
    const chatDecl = JSON.parse(
      readFileSync(resolve(ROOT, "app/app-chat.json"), "utf8"),
    );
    const navIds = screenDecl.navigation.sections.map((s) => s.id);
    const chatIds = chatDecl.contexts.map((c) => c.id);
    expect(chatIds).toEqual(navIds);
    for (const ctx of chatDecl.contexts) {
      expect(ctx.prompts.length).toBeLessThanOrEqual(3);
      for (const p of ctx.prompts) {
        expect(p.length).toBeLessThanOrEqual(80);
      }
    }
  });

  test("assert-app-check.py accepts standalone app-storage refusal and rejects compound refusals", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "minutes-appcheck-test-"));
    const storageClause =
      "app requires host contract 'app-storage' major 1 — this host supports none (unknown contract)";
    const runAssert = (doc) => {
      const p = join(tempDir, "report.json");
      writeFileSync(p, JSON.stringify(doc));
      return spawnSync("python3", [".github/scripts/assert-app-check.py", p], {
        cwd: ROOT,
        encoding: "utf8",
      });
    };
    try {
      const okStorageOnly = runAssert({
        ok: false,
        digest: "sha256:" + "0".repeat(64),
        files: [{ path: "app.md" }],
        compatibility: {
          checks: [
            { contract: "app-screens", ok: true },
            { contract: "app-storage", ok: false },
          ],
        },
        refusal: {
          code: "app_check_content",
          message: `app is not installable — ${storageClause}`,
        },
      });
      expect(okStorageOnly.status).toBe(0);

      const compoundRefusal = runAssert({
        ok: false,
        digest: "sha256:" + "0".repeat(64),
        files: [{ path: "app.md" }],
        compatibility: {
          checks: [
            { contract: "app-screens", ok: true },
            { contract: "app-storage", ok: false },
          ],
        },
        refusal: {
          code: "app_check_content",
          message: `app is not installable — skills/bad: undeclared ref; ${storageClause}`,
        },
      });
      expect(compoundRefusal.status).not.toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
