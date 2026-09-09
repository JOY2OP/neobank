import "server-only";

function configuration() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.");
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function request(path, options = {}) {
  const { url, key } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function selectRows(table, query = "") {
  return request(`${table}?${query}`);
}

export function insertRows(table, rows, { ignoreDuplicates = false } = {}) {
  const prefer = ignoreDuplicates
    ? "resolution=ignore-duplicates,return=representation"
    : "return=representation";
  return request(table, {
    method: "POST",
    headers: { Prefer: prefer },
    body: JSON.stringify(rows),
  });
}

export function updateRows(table, query, values) {
  return request(`${table}?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values),
  });
}

export function callRpc(name, parameters = {}) {
  return request(`rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(parameters),
  });
}

export function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
