import { describe, expect, it } from "vitest";
import {
  applyVersion,
  computeBuildVersion,
  GLOBAL_HOST,
  normalizeBase,
  renderManifest,
  resolveManifestTarget,
  VERSION_EPOCH_DAYS,
} from "./manifest.mjs";

const template = [
  '<IconUrl DefaultValue="https://__ADDIN_DOMAIN__/__ADDIN_BASE__assets/icon-64.png"/>',
  '<HighResolutionIconUrl DefaultValue="https://__ADDIN_DOMAIN__/__ADDIN_BASE__assets/icon-128.png"/>',
  '<SourceLocation DefaultValue="https://__ADDIN_DOMAIN__/__ADDIN_BASE__"/>',
  '<bt:Url id="Taskpane.Url" DefaultValue="https://__ADDIN_DOMAIN__/__ADDIN_BASE__"/>',
].join("\n");

describe("manifest generator", () => {
  it("renders the global host at the root path", () => {
    const target = resolveManifestTarget(["--global"]);

    expect(target).toEqual({ domain: GLOBAL_HOST, base: "" });
    expect(renderManifest(template, target)).toContain(
      `https://${GLOBAL_HOST}/assets/icon-64.png`,
    );
    expect(renderManifest(template, target)).toContain(
      `https://${GLOBAL_HOST}/assets/icon-128.png`,
    );
    expect(renderManifest(template, target)).toContain(
      `https://${GLOBAL_HOST}/`,
    );
  });

  it("defaults custom hosts to the ECS /addin/ base", () => {
    const target = resolveManifestTarget(["wmdev.zeuja.com"]);

    expect(target).toEqual({ domain: "wmdev.zeuja.com", base: "addin/" });
    expect(renderManifest(template, target)).toContain(
      "https://wmdev.zeuja.com/addin/",
    );
  });

  it("normalizes a custom base without corrupting root manifests", () => {
    expect(normalizeBase(undefined)).toBe("addin/");
    expect(normalizeBase("")).toBe("");
    expect(normalizeBase("addin")).toBe("addin/");
    expect(normalizeBase("/addin/")).toBe("addin/");
  });
});

describe("manifest version auto-bump", () => {
  // 2026-06-05T12:30:00Z -> 886 days since 2024-01-01, minute 750 of the day.
  const at = (iso) => new Date(iso);

  it("keeps MAJOR.MINOR from the template and appends a day.minute build", () => {
    const template = "<Version>1.1.0.0</Version>";
    expect(computeBuildVersion(template, at("2026-06-05T12:30:00Z"))).toBe(
      "1.1.886.750",
    );
  });

  it("falls back to 1.0 when the template has no parseable version", () => {
    expect(computeBuildVersion("<OfficeApp/>", at("2024-01-01T00:00:00Z"))).toBe(
      "1.0.0.0",
    );
  });

  it("is strictly monotonic minute-to-minute and across midnight", () => {
    const t = "<Version>2.3.0.0</Version>";
    const v = (iso) => computeBuildVersion(t, at(iso));
    const cmp = (a, b) =>
      a.split(".").map(Number) < b.split(".").map(Number) ? -1 : 1;
    // The octet floors map back to a known epoch.
    expect(v("2024-01-01T00:00:00Z")).toBe("2.3.0.0");
    expect(v("2024-01-01T00:01:00Z")).toBe("2.3.0.1");
    // Next day resets the minute octet but bumps the day octet -> still greater.
    expect(cmp(v("2024-01-01T23:59:00Z"), v("2024-01-02T00:00:00Z"))).toBe(-1);
    expect(v("2024-01-02T00:00:00Z")).toBe("2.3.1.0");
  });

  it("replaces only the top-level <Version>, not the overrides block", () => {
    const template = [
      "<Version>1.0.0.0</Version>",
      '<Description resid="TaskpaneButton.SupertipText"/>',
    ].join("\n");
    const out = applyVersion(template, "1.1.886.750");
    expect(out).toContain("<Version>1.1.886.750</Version>");
    expect(out).not.toContain("<Version>1.0.0.0</Version>");
    expect(out).toContain('<Description resid="TaskpaneButton.SupertipText"/>');
  });

  it("pins the epoch constant so the build math can't silently drift", () => {
    expect(VERSION_EPOCH_DAYS).toBe(
      Math.floor(Date.UTC(2024, 0, 1) / 86_400_000),
    );
  });
});
