import { describe, expect, it } from "vitest";
import {
  GLOBAL_HOST,
  normalizeBase,
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
