export const DEMO_IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  account: "10000000-0000-4000-8000-000000000002",
  sarah: "10000000-0000-4000-8000-000000000010",
  john: "10000000-0000-4000-8000-000000000011",
  ops: "10000000-0000-4000-8000-000000000012",
  system: "10000000-0000-4000-8000-000000000013",
  agent: "10000000-0000-4000-8000-000000000014",
  beneficiary: "10000000-0000-4000-8000-000000000040",
};

export const DEMO_USERS = {
  sarah: {
    slug: "sarah",
    actorId: DEMO_IDS.sarah,
    name: "Sarah Chen",
    email: "sarah@acme.com",
    phoneNumber: "+18008675309",
    role: "OWNER",
    portal: "customer",
  },
  john: {
    slug: "john",
    actorId: DEMO_IDS.john,
    name: "John Miller",
    email: "john@acme.com",
    phoneNumber: "+18008675309",
    role: "MAKER",
    portal: "customer",
  },
  ops: {
    slug: "ops",
    actorId: DEMO_IDS.ops,
    name: "Maya Patel",
    email: "admin@corgi.com",
    role: "OPS",
    portal: "ops",
  },
};

export function getDemoUser(slug) {
  return DEMO_USERS[slug] || null;
}
