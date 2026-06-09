import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GLOBAL_HOST = "outlook-feishu-bridge.pages.dev";
export const DEFAULT_ECS_HOST = "wmdev.zeuja.com";
export const DEFAULT_ECS_BASE = "addin/";
const DEFAULT_MANIFEST_VERSION = "1.0.0.0";
// Office caps each version segment at 5 digits (0-99999). See
// https://learn.microsoft.com/javascript/api/manifest/version.
const MAX_VERSION_PART = 99999;
// Git-tracked source of truth for the auto-bump baseline. The generated
// manifest-sideload*.xml files are gitignored deliverables, so the version
// must NOT be read back from them — a fresh checkout would silently reset to
// 1.0.0.0 and Outlook would refuse the (now-lower) update. ADR-0009.
const VERSION_FILE = "../manifest.version";

function usage() {
  return [
    "Usage:",
    "  bun scripts/manifest.mjs --global [--output <path>]",
    "  bun scripts/manifest.mjs --ecs [domain] [--output <path>]",
    "  bun scripts/manifest.mjs <domain> [base] [--output <path>]",
    "",
    "Options:",
    "  --output, -o  Path to write the generated manifest XML to (UTF-8, no BOM)",
    "",
    "Examples:",
    "  bun scripts/manifest.mjs --global --output manifest-sideload.xml",
    "  bun scripts/manifest.mjs --ecs --output manifest-sideload-cn.xml",
    "  bun scripts/manifest.mjs wmdev.zeuja.com addin/ --output manifest-sideload-cn.xml",
    "",
    "The global preset serves the SPA at root. ECS/custom hosts default to /addin/.",
  ].join("\n");
}

function versionFilePath() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, VERSION_FILE);
}

function readTrackedVersion() {
  const path = versionFilePath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  // Validate on read: the file is hand-editable, so a corrupt value should
  // fail loudly rather than emit an illegal manifest.
  return raw ? normalizeVersion(raw) : null;
}

function writeTrackedVersion(version) {
  writeFileSync(versionFilePath(), `${version}\n`, "utf8");
}

// Increment the 4th segment, carrying into higher segments so no part exceeds
// Office's 5-digit (0-99999) per-segment cap — `1.0.0.99999` -> `1.0.1.0`,
// never the illegal `1.0.0.100000`.
export function bumpVersion(version) {
  const parts = normalizeVersion(version).split(".").map(Number);
  let i = parts.length - 1;
  parts[i] += 1;
  while (parts[i] > MAX_VERSION_PART) {
    parts[i] = 0;
    i -= 1;
    if (i < 0) {
      throw new Error(
        `Manifest version ${version} cannot be bumped without exceeding the ` +
          `5-digit-per-segment limit. Reset it manually in manifest.version.`,
      );
    }
    parts[i] += 1;
  }
  return parts.join(".");
}

function normalizeDomain(value) {
  const raw = (value ?? "").trim();
  if (!raw) throw new Error("Missing manifest domain.");

  const parsed = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Manifest domain must be a host only; pass the path as [base].");
  }
  return parsed.host;
}

export function normalizeBase(value) {
  if (value === undefined) return DEFAULT_ECS_BASE;
  const trimmed = value.trim();
  if (trimmed === "") return "";

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");
  return withoutLeadingSlash.endsWith("/")
    ? withoutLeadingSlash
    : `${withoutLeadingSlash}/`;
}

export function normalizeVersion(value) {
  const raw = (value ?? "").trim();
  if (!raw) return DEFAULT_MANIFEST_VERSION;
  // Four numeric segments, each 1-5 digits (Office caps a segment at 99999).
  // `\d{1,5}` rejects out-of-range parts the old `\d+` happily accepted.
  if (!/^\d{1,5}(\.\d{1,5}){3}$/.test(raw)) {
    throw new Error(
      "Manifest version must be four numeric segments, each 0-99999 " +
        "(for example, 1.0.0.1).",
    );
  }
  return raw;
}

export function resolveManifestTarget(args) {
  const [first, second, third, ...rest] = args;
  if (rest.length > 0) throw new Error("Too many manifest arguments.");

  if (first === "--global") {
    if (second !== undefined) throw new Error("--global does not accept extra arguments.");
    return {
      domain: GLOBAL_HOST,
      base: "",
      version: normalizeVersion(process.env.MANIFEST_VERSION),
    };
  }

  if (first === "--ecs") {
    return {
      domain: normalizeDomain(second ?? DEFAULT_ECS_HOST),
      base: normalizeBase(third),
      version: normalizeVersion(process.env.MANIFEST_VERSION),
    };
  }

  if (!first || first === "-h" || first === "--help") {
    throw new Error(usage());
  }

  return {
    domain: normalizeDomain(first),
    base: normalizeBase(second),
    version: normalizeVersion(process.env.MANIFEST_VERSION),
  };
}

export function renderManifest(template, target) {
  return template
    .replaceAll("__ADDIN_DOMAIN__", target.domain)
    .replaceAll("__ADDIN_BASE__", target.base)
    .replaceAll("__ADDIN_VERSION__", target.version);
}

async function main(argv) {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(usage());
    return;
  }

  let outputPath = null;
  const filteredArgv = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" || argv[i] === "-o") {
      outputPath = argv[i + 1];
      i++;
    } else {
      filteredArgv.push(argv[i]);
    }
  }

  // MANIFEST_VERSION (env) is an explicit pin and always wins, untouched.
  // Otherwise: writing a deliverable (--output) advances the tracked baseline;
  // a stdout preview just reports the current baseline without bumping.
  if (!process.env.MANIFEST_VERSION) {
    const current = readTrackedVersion();
    if (outputPath) {
      const bumped = bumpVersion(current ?? DEFAULT_MANIFEST_VERSION);
      writeTrackedVersion(bumped);
      process.env.MANIFEST_VERSION = bumped;
      console.log(
        `Bumped manifest version ${current ?? "(unset)"} -> ${bumped} ` +
          `(tracked in manifest.version — commit it)`,
      );
    } else if (current) {
      process.env.MANIFEST_VERSION = current;
    }
  }

  const target = resolveManifestTarget(filteredArgv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "../public/manifest.xml");
  const template = readFileSync(templatePath, "utf8");
  const content = renderManifest(template, target);

  if (outputPath) {
    writeFileSync(outputPath, content, "utf8");
    console.log(`Saved manifest to ${outputPath} (UTF-8)`);
  } else {
    process.stdout.write(content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (!error.message.startsWith("Usage:")) console.error(`\n${usage()}`);
    process.exit(1);
  });
}
