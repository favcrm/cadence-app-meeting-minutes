import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(import.meta.dirname, "../..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("Toolchain locks, app-storage/v1 migration integrity, and manifest honesty", () => {
  test("app-kit.lock.json matches vendored @cadence/app-kit@0.2.0 files byte-for-byte", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "app-kit.lock.json"), "utf8"));
    expect(lock.schema).toBe("cadence-app-kit-lock/1");
    expect(lock.tag).toBe("v0.3.22");
    expect(lock.version).toBe("0.2.0");
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

  test("app/app.md declares 0.3.2, required contracts, and no forbidden pricing keys", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const raw = readFileSync(resolve(ROOT, "app/app.md"), "utf8");
    const lines = raw.split(/\r?\n/);
    const end = lines.findIndex((line, i) => i > 0 && line === "---");
    const manifest = parseYaml(lines.slice(1, end).join("\n"));

    expect(manifest.app).toBe("meeting-minutes");
    expect(manifest.version).toBe("0.3.2");
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
});
