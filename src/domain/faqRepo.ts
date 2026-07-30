import { pool } from "../db/index.js";

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  status: "draft" | "published";
  enabled: boolean;
  source_handoff: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Published + enabled entries, capped, for prompt injection as factual data. */
export async function publishedFaqEntries(limit = 40): Promise<FaqEntry[]> {
  const res = await pool.query(
    `select * from faq_entries where status = 'published' and enabled
      order by updated_at desc limit $1`,
    [limit],
  );
  return res.rows;
}

export async function listFaqEntries(): Promise<FaqEntry[]> {
  const res = await pool.query(`select * from faq_entries order by updated_at desc`);
  return res.rows;
}

export async function createFaqEntry(args: {
  question: string;
  answer: string;
  status?: "draft" | "published";
  sourceHandoff?: string | null;
  createdBy?: string | null;
}): Promise<FaqEntry> {
  const res = await pool.query(
    `insert into faq_entries (question, answer, status, source_handoff, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5) returning *`,
    [
      args.question,
      args.answer,
      args.status ?? "draft",
      args.sourceHandoff ?? null,
      args.createdBy ?? null,
    ],
  );
  return res.rows[0];
}

export async function updateFaqEntry(
  id: string,
  args: {
    question?: string;
    answer?: string;
    status?: "draft" | "published";
    enabled?: boolean;
    updatedBy?: string | null;
  },
): Promise<void> {
  await pool.query(
    `update faq_entries set
       question = coalesce($2, question),
       answer = coalesce($3, answer),
       status = coalesce($4, status),
       enabled = coalesce($5, enabled),
       updated_by = $6,
       updated_at = now()
     where id = $1`,
    [id, args.question ?? null, args.answer ?? null, args.status ?? null, args.enabled ?? null, args.updatedBy ?? null],
  );
}
