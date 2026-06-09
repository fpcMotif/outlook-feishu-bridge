import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  GLOBAL_HOST,
  normalizeBase,
  normalizeVersion,
  renderManifest,
  resolveManifestTarget,
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

    expect(target).toEqual({ domain: GLOBAL_HOST, base: "", version: "1.0.0.0" });
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

    expect(target).toEqual({ domain: "wmdev.zeuja.com", base: "addin/", version: "1.0.0.0" });
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

describe("manifest version", () => {
  it("accepts a legal four-segment version", () => {
    expect(normalizeVersion("1.0.1.1")).toBe("1.0.1.1");
  });

  it("defaults an empty value to 1.0.0.0", () => {
    expect(normalizeVersion("")).toBe("1.0.0.0");
    expect(normalizeVersion(undefined)).toBe("1.0.0.0");
  });

  it("rejects a segment over five digits (illegal in Office)", () => {
    expect(() => normalizeVersion("1.0.0.100000")).toThrow();
    expect(() => normalizeVersion("1.0.0.65536000")).toThrow();
  });

  it("rejects a three-segment version (the repo pins four)", () => {
    expect(() => normalizeVersion("1.0.0")).toThrow();
  });

  it("bumps the last segment", () => {
    expect(bumpVersion("1.0.1.1")).toBe("1.0.1.2");
  });

  it("rolls over instead of exceeding the 5-digit cap", () => {
    expect(bumpVersion("1.0.0.99999")).toBe("1.0.1.0");
    expect(bumpVersion("1.0.99999.99999")).toBe("1.1.0.0");
  });
});
