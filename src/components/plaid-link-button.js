"use client";

import { useState } from "react";

function loadPlaidScript() {
  return new Promise((resolve, reject) => {
    if (window.Plaid) return resolve();
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load Plaid Link."));
    document.head.appendChild(script);
  });
}

async function exchange(publicToken) {
  const response = await fetch("/api/plaid/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicToken }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

export default function PlaidLinkButton() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function openLink() {
    setBusy(true);
    setMessage("");
    try {
      const tokenResponse = await fetch("/api/plaid/link-token", { method: "POST" });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(token.error);
      if (token.source === "SIMULATED") {
        await exchange(token.linkToken);
        setMessage("Simulated bank linked.");
        return;
      }
      await loadPlaidScript();
      const handler = window.Plaid.create({
        token: token.linkToken,
        onSuccess: async (publicToken) => {
          await exchange(publicToken);
          setMessage("Sandbox bank linked. Refresh to see it.");
        },
        onExit: (error) => error && setMessage(error.display_message || "Plaid Link was closed."),
      });
      handler.open();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="button button-primary" onClick={openLink} disabled={busy}>
        {busy ? "Connecting…" : "Link with Plaid"}
      </button>
      {message ? <p className="form-message">{message}</p> : null}
    </div>
  );
}
