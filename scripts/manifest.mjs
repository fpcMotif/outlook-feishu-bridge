import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GLOBAL_HOST = "outlook-feishu-bridge.pages.dev";
// Last-resort literal only. The ECS host's real source of truth is the
// ADDIN_ECS_HOST env var (set in .env.deploy, exported by scripts/deploy.sh and
// scripts/provision-ecs.sh). `--ecs` prefers an explicit arg, then ADDIN_ECS_HOST,
// and falls back to this literal only when neither is provided.
export const DEFAULT_ECS_HOST = "wmdev.zeuja.com";
export const DEFAULT_ECS_BASE = "addin/";

// Resolve the ECS host for the `--ecs` preset: explicit arg > ADDIN_ECS_HOST env
// > literal default. Keeping the env as the source of truth removes the hardcode.
export function resolveEcsHost(explicit, env = process.env) {
  return explicit ?? env.ADDIN_ECS_HOST ?? DEFAULT_ECS_HOST;
}

function usage() {
  return [
    "Usage:",
    "  bun scripts/manifest.mjs --global",
    "  bun scripts/manifest.mjs --ecs [domain]",
    "  bun scripts/manifest.mjs <domain> [base]",
    "",
    "Examples:",
    "  bun scripts/manifest.mjs --global > manifest-sideload.xml",
    "  ADDIN_ECS_HOST=wmdev.zeuja.com bun scripts/manifest.mjs --ecs > manifest-sideload-cn.xml",
    "  bun scripts/manifest.mjs wmdev.zeuja.com addin/ > manifest-sideload-cn.xml",
    "",
    "--ecs takes the host from its arg, else $ADDIN_ECS_HOST, else a literal default.",
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
    return { domain: normalizeDomain(resolveEcsHost(second)), base: normalizeBase(third) };
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

async function main(argv) {
  if (argv[0] === "-h" || argv[0] === "--help") {
    console.log(usage());
    return;
  }

  const target = resolveManifestTarget(argv);
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(scriptDir, "../public/manifest.xml");
  const template = readFileSync(templatePath, "utf8");
  process.stdout.write(renderManifest(template, target));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (!error.message.startsWith("Usage:")) console.error(`\n${usage()}`);
    process.exit(1);
  });
}
