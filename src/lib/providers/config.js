import "server-only";

const ALLOWED_MODES = new Set(["sandbox", "simulated"]);

export function providerMode(name) {
  const value = process.env[`${name.toUpperCase()}_MODE`] || "sandbox";
  if (!ALLOWED_MODES.has(value)) {
    throw new Error(`${name.toUpperCase()}_MODE must be sandbox or simulated.`);
  }
  return value;
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required while this provider is in sandbox mode.`);
  return value;
}

export function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
