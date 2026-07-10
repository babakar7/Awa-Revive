import pg from "pg";
import { config } from "../config.js";
import { SCHEMA_SQL } from "./schema.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
