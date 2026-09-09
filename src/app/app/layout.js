import AppShell from "@/components/app-shell";
import { requireCustomer } from "@/lib/session";

export default async function CustomerLayout({ children }) {
  const user = await requireCustomer();
  return <AppShell user={user}>{children}</AppShell>;
}
