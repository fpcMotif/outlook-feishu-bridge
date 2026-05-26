// Ambient `process.env` declaration for the frontend typecheck only.
//
// Convex backend modules (convex/feishu/*) read process.env at runtime, where the
// Convex runtime provides it. They get pulled into the *app* typecheck via the
// generated convex/_generated/api types. tsconfig.app intentionally omits node
// types — adding them retypes setTimeout to NodeJS.Timeout and breaks SPA code
// (e.g. src/office/useOffice.ts). This narrow shim satisfies that view without
// the cascade. The browser SPA itself uses import.meta.env, never process.env.
declare const process: { env: Record<string, string | undefined> };
