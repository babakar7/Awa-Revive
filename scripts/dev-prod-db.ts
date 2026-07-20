import { execFileSync, spawn } from "node:child_process";
import pg from "pg";

type RailwayVariables = Record<string, unknown>;

function productionDatabaseUrl(): string {
  let output: string;
  try {
    output = execFileSync(
      "railway",
      ["variables", "--service", "Postgres", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new Error(
      "Impossible de lire Railway. Vérifie `railway login` et que ce dossier est lié au projet Revive.",
    );
  }

  let variables: RailwayVariables;
  try {
    variables = JSON.parse(output) as RailwayVariables;
  } catch {
    throw new Error("Railway a renvoyé une réponse illisible.");
  }

  const value = variables.DATABASE_PUBLIC_URL;
  if (typeof value !== "string" || !/^postgres(?:ql)?:\/\//.test(value)) {
    throw new Error("DATABASE_PUBLIC_URL est absente du service Postgres Railway.");
  }
  return value;
}

async function checkConnection(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<{ database: string }>(
      "select current_database() as database",
    );
    console.log(`Connexion réussie à la base de production « ${result.rows[0]?.database ?? "?"} ».`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const databaseUrl = productionDatabaseUrl();

  if (process.argv.includes("--check")) {
    await checkConnection(databaseUrl);
    return;
  }

  const host = new URL(databaseUrl).hostname;
  console.log(`⚠️  Local connecté à PostgreSQL PRODUCTION (${host}).`);
  console.log("Les tâches automatiques sont désactivées, mais les actions dans l’admin modifient les vraies données.");

  const child = spawn(
    "npm",
    ["exec", "--", "tsx", "watch", "src/devProd.ts"],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DEV_AUTO_PORT: "1",
        LOCAL_PROD_DATABASE: "1",
      },
    },
  );

  child.on("error", (error) => {
    console.error("Impossible de démarrer le serveur local :", error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
