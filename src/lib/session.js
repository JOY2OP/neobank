import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDemoUser } from "./demo-users";
import { createSignedSessionValue, readSignedSessionSlug } from "./session-signature";

const COOKIE_NAME = "corgi_demo_session";

function sessionSecret() {
  const configuredSecret = process.env.DEMO_SESSION_SECRET;
  if (configuredSecret) return configuredSecret;
  if (process.env.NODE_ENV !== "production") return "local-demo-only-change-me";
  throw new Error("DEMO_SESSION_SECRET is required in production.");
}

export async function setDemoSession(slug) {
  if (!getDemoUser(slug)) throw new Error("Unknown demo user.");
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, createSignedSessionValue(slug, sessionSecret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearDemoSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getSessionUser() {
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(COOKIE_NAME)?.value;
  if (!rawCookie) return null;

  const slug = readSignedSessionSlug(rawCookie, sessionSecret());
  if (!slug) return null;
  return getDemoUser(slug);
}

export async function requireCustomer() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.portal !== "customer") redirect("/ops");
  return user;
}

export async function requireOwner() {
  const user = await requireCustomer();
  if (user.role !== "OWNER") redirect("/app");
  return user;
}

export async function requireOps() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.portal !== "ops") redirect("/app");
  return user;
}
