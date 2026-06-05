import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GLOBAL_HOST = "outlook-feishu-bridge.pages.dev";
export const DEFAULT_ECS_HOST = "wmdev.zeuja.com";
export const DEFAULT_ECS_BASE = "addin/";

function usage() {
  return [
    "Usage:",
    "  bun scripts/manifest.mjs --global",
    "  bun scripts/manifest.mjs --ecs [domain]",
    "  bun scripts/manifest.mjs <domain> [base]",
    "",
    "Examples:",
    "  bun scripts/manifest.mjs --global > manifest-sideload.xml",
    "  bun scripts/manifest.mjs --ecs > manifest-sideload-cn.xml",
    "  bun scripts/manifest.mjs wmdev.zeuja.com addin/ > manifest-sideload-cn.xml",
    "",
    "The global preset serves the SPA at root. ECS/custom hosts default to /addin/.",
  ].join("\n");
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

export function resolveManifestTarget(args) {
  const [first, second, third, ...rest] = args;
  if (rest.length > 0) throw new Error("Too many manifest arguments.");

  if (first === "--global") {
    if (second !== undefined) throw new Error("--global does not accept extra arguments.");
    return { domain: GLOBAL_HOST, base: "" };
  }

  if (first === "--ecs") {
    return { domain: normalizeDomain(second ?? DEFAULT_ECS_HOST), base: normalizeBase(third) };
  }

  if (!first || first === "-h" || first === "--help") {
    throw new Error(usage());
  }

  return { domain: normalizeDomain(first), base: normalizeBase(second) };
}

export function renderManifest(template, target) {
  return template
    .replaceAll("__ADDIN_DOMAIN__", target.domain)
    .replaceAll("__ADDIN_BASE__", target.base);
}

// Office rejects any re-sideload/update whose <Version> is not STRICTLY greater
// than the installed one ("Please update the version number in the manifest file
// and try again"). So every generated manifest gets an auto-incrementing build
// number, leaving MAJOR.MINOR (the first two octets of the template's <Version>)
// as the human-controlled release line. Build = MAJOR.MINOR.<days>.<minuteOfDay>:
//   octet3 = whole UTC days since 2024-01-01 (grows by 1 each day)
//   octet4 = minute of the UTC day, 0..1439 (grows within a day)
// Each Office octet is a 16-bit int (0..65535); both fields stay well inside that
// (octet3 doesn't overflow until ~year 2203). Versions are compared left-to-right,
// so this is strictly monotonic across deploys, including over midnight.
export const VERSION_EPOCH_DAYS = 19723; // 1970-01-01 -> 2024-01-01, in whole days

export function computeBuildVersion(template, now) {
  const match = template.match(/<Version>\s*(\d+)\.(\d+)/);
  const major = match ? match[1] : "1";
  const minor = match ? match[2] : "0";
  const days = Math.floor(now.getTime() / 86_400_000) - VERSION_EPOCH_DAYS;
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return `${major}.${minor}.${days}.${minuteOfDay}`;
}

export function applyVersion(template, version) {
  // Only the top-level <Version> is a bare number; the VersionOverrides block
  // has no <Version> tag, so a single (non-global) replace is exactly right.
  return template.replace(/<Version>[^<]*<\/Version>/, `<Version>${version}</Version>`);
}

async function main(argv) {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(usage());
    return;
  }

  const target = resolveManifestTarget(argv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "../public/manifest.xml");
  const template = readFileSync(templatePath, "utf8");
  const versioned = applyVersion(template, computeBuildVersion(template, new Date()));
  process.stdout.write(renderManifest(versioned, target));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (!error.message.startsWith("Usage:")) console.error(`\n${usage()}`);
    process.exit(1);
  });
}
