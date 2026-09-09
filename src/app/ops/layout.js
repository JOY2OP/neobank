import AppShell from "@/components/app-shell";
import { requireOps } from "@/lib/session";

export default async function OpsLayout({ children }) {
  const user = await requireOps();
  return <AppShell user={user}>{children}</AppShell>;
}
