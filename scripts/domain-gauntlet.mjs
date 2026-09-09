import { spawnSync } from "node:child_process";
import process from "node:process";

const containerName = `corgi-domain-gauntlet-${process.pid}`;
const workspace = process.cwd();

function docker(args, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function psql(file) {
  docker([
    "exec", containerName,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres",
    "-f", `/workspace/${file}`,
  ]);
}

try {
  docker([
    "run", "--detach", "--name", containerName,
    "--env", "POSTGRES_PASSWORD=gauntlet-local-only",
    "--volume", `${workspace}:/workspace:ro`,
    "postgres:15-alpine",
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = docker(
      ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "postgres"],
      { allowFailure: true, quiet: true },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Local PostgreSQL did not become ready in time.");

  for (const file of [
    "tests/sql/local-postgres-bootstrap.sql",
    "supabase-schema.sql",
    "supabase-additive-migration.sql",
    "supabase-domain-hardening-migration.sql",
    "tests/sql/domain-gauntlet-fixture.sql",
    "supabase-domain-gauntlet.sql",
  ]) {
    psql(file);
  }

  console.log("Domain gauntlet completed in disposable PostgreSQL; all test data rolled back.");
} finally {
  docker(["rm", "--force", containerName], { allowFailure: true, quiet: true });
}
