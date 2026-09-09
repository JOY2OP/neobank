import "./globals.css";

export const metadata = {
  title: "Corgi Business Banking",
  description: "A sandbox neobank demonstrating ledgers, holds, approvals, and reconciliation.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
