import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface StoredMessage {
  id: number;
  userId: string;
  convId: string;
  role: Role;
  content: string;
  ts: number; // epoch ms
  meta: { queries?: string[]; sources?: { title: string; url: string; date?: string }[] } | null;
}

const DB_PATH = process.env.DB_PATH || "data/memory.db";
if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// One table for the log, one FTS5 index for topic recall. Dates are exact range queries
// on `ts`; FTS handles "what did we say about X" when no date is given.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    conv_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_ts ON messages(user_id, ts);
  CREATE INDEX IF NOT EXISTS idx_conv ON messages(conv_id, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);

type Row = {
  id: number;
  user_id: string;
  conv_id: string;
  role: Role;
  content: string;
  ts: number;
  meta: string | null;
};

const toMsg = (r: Row): StoredMessage => ({
  id: r.id,
  userId: r.user_id,
  convId: r.conv_id,
  role: r.role,
  content: r.content,
  ts: r.ts,
  meta: r.meta ? JSON.parse(r.meta) : null,
});

const insert = db.prepare(
  "INSERT INTO messages (user_id, conv_id, role, content, ts, meta) VALUES (?,?,?,?,?,?)",
);

export function addMessage(m: Omit<StoredMessage, "id" | "meta"> & { meta?: StoredMessage["meta"] }): number {
  const r = insert.run(m.userId, m.convId, m.role, m.content, m.ts, m.meta ? JSON.stringify(m.meta) : null);
  return Number(r.lastInsertRowid);
}

/** Most recent messages of one conversation, oldest first. */
export function conversationWindow(convId: string, limit = 12): StoredMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?")
    .all(convId, limit) as Row[];
  return rows.reverse().map(toMsg);
}

/** Everything the user has said/received in [from, to], any conversation. */
export function messagesInRange(userId: string, from: number, to: number, limit = 60): StoredMessage[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE user_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC, id ASC LIMIT ?")
    .all(userId, from, to, limit) as Row[];
  return rows.map(toMsg);
}

/** Topic recall by keyword (BM25). Terms are OR-ed; caller supplies already-cleaned words. */
export function searchMessages(userId: string, terms: string[], limit = 6): StoredMessage[] {
  const clean = terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter((t) => t.length > 2);
  if (!clean.length) return [];
  const q = clean.map((t) => `"${t}"`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.user_id = ? ORDER BY bm25(messages_fts) LIMIT ?`,
    )
    .all(q, userId, limit) as Row[];
  return rows.map(toMsg);
}

/** The assistant reply that followed a given user message in the same conversation. */
export function replyTo(userMsg: StoredMessage): StoredMessage | null {
  const r = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id ASC LIMIT 1")
    .get(userMsg.convId, userMsg.id) as Row | undefined;
  return r && r.role === "assistant" ? toMsg(r) : null;
}

/** The user message that preceded a given assistant message in the same conversation. */
export function promptOf(asstMsg: StoredMessage): StoredMessage | null {
  const r = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT 1")
    .get(asstMsg.convId, asstMsg.id) as Row | undefined;
  return r && r.role === "user" ? toMsg(r) : null;
}

export function listConversation(convId: string): StoredMessage[] {
  const rows = db.prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY id ASC").all(convId) as Row[];
  return rows.map(toMsg);
}
