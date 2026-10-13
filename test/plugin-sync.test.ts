import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairingToken, sameToken } from "../src/pairing";
import { compareVersions, syncPlugin } from "../src/setup";

function fakePlugin(dir: string, marker: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["manifest.json", "code.js", "ui.html"]) writeFileSync(join(dir, f), `${f} ${marker}`);
  return dir;
}

describe("compareVersions", () => {
  test("orders semantic versions numerically", () => {
    expect(compareVersions("1.12.0", "1.5.0")).toBeGreaterThan(0);
    expect(compareVersions("1.5.0", "1.12.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.13", "1.13.0")).toBe(0);
  });
});

describe("syncPlugin", () => {
  test("installs, skips when current, updates, and never downgrades", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-sync-"));
    const target = join(root, "installed");
    const v1 = fakePlugin(join(root, "v1"), "v1");
    const v2 = fakePlugin(join(root, "v2"), "v2");

    expect(syncPlugin(v1, target, "1.5.0")).toBe("installed");
    expect(readFileSync(join(target, "code.js"), "utf8")).toBe("code.js v1");
    expect(syncPlugin(v1, target, "1.5.0")).toBe("current");

    expect(syncPlugin(v2, target, "1.13.0")).toBe("updated");
    expect(readFileSync(join(target, "ui.html"), "utf8")).toBe("ui.html v2");
    expect(JSON.parse(readFileSync(join(target, "version.json"), "utf8")).version).toBe("1.13.0");

    // An older server (another AI client) must not replace a newer plugin.
    expect(syncPlugin(v1, target, "1.5.0")).toBe("newer");
    expect(readFileSync(join(target, "code.js"), "utf8")).toBe("code.js v2");
  });

  test("updates a copy installed before version.json existed", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-sync-"));
    const target = fakePlugin(join(root, "installed"), "old");
    expect(syncPlugin(fakePlugin(join(root, "new"), "new"), target, "1.13.0")).toBe("updated");
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toBe("manifest.json new");
  });

  test("writes the pairing token into ui.html and refreshes a copy with another token or changed files", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-sync-"));
    const target = join(root, "installed");
    const src = fakePlugin(join(root, "src"), "v1");
    writeFileSync(join(src, "ui.html"), 'const PAIRING_TOKEN = "__FIGMA_BRIDGE_PAIRING__";');

    expect(syncPlugin(src, target, "1.5.0", "a".repeat(48))).toBe("installed");
    expect(readFileSync(join(target, "ui.html"), "utf8")).toBe(`const PAIRING_TOKEN = "${"a".repeat(48)}";`);
    expect(readFileSync(join(src, "ui.html"), "utf8")).toContain("__FIGMA_BRIDGE_PAIRING__");
    expect(syncPlugin(src, target, "1.5.0", "a".repeat(48))).toBe("current");

    expect(syncPlugin(src, target, "1.5.0", "b".repeat(48))).toBe("updated");
    expect(readFileSync(join(target, "ui.html"), "utf8")).toContain("b".repeat(48));

    // Same version, rebuilt plugin (a clone during development).
    writeFileSync(join(src, "code.js"), "code.js rebuilt");
    expect(syncPlugin(src, target, "1.5.0", "b".repeat(48))).toBe("updated");
    expect(readFileSync(join(target, "code.js"), "utf8")).toBe("code.js rebuilt");
  });

  test("pairingToken is created once and shared", () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-token-"));
    const t = pairingToken(dir);
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(pairingToken(dir)).toBe(t);
    writeFileSync(join(dir, "pairing-token"), "garbage");
    expect(pairingToken(dir)).toMatch(/^[0-9a-f]{48}$/);
    expect(sameToken(t, t)).toBe(true);
    expect(sameToken(t.slice(1), t)).toBe(false);
    expect(sameToken(undefined, t)).toBe(false);
  });

  test("does nothing when the package has no built plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "fb-sync-"));
    expect(syncPlugin(join(root, "missing"), join(root, "installed"), "1.13.0")).toBe("skipped");
  });
});
