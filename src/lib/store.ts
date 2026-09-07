import { AppError } from "./errors";
import { ownerSubject } from "./config";
import { database, ownerLock, type Database } from "./db";
import type { ReaderDocument, Segment, StoreData, Voice } from "./types";

export async function listVoices(owner = ownerSubject(), db = database()): Promise<Voice[]> {
  const { rows } = await db.query<{ data: Voice }>("SELECT data FROM voices WHERE owner=$1", [owner]);
  return rows.map((r) => r.data).sort((a, b) =>
    Number(b.id === process.env.DEFAULT_VOICE_ID) - Number(a.id === process.env.DEFAULT_VOICE_ID) ||
    Number(b.name === "Dingkang 的声音") - Number(a.name === "Dingkang 的声音") ||
    Number(a.source === "default") - Number(b.source === "default") || b.createdAt.localeCompare(a.createdAt));
}
export async function findVoice(id: string, owner = ownerSubject(), db = database()): Promise<Voice> {
  const { rows } = await db.query<{ data: Voice }>("SELECT data FROM voices WHERE owner=$1 AND id=$2", [owner, id]);
  if (!rows[0]) throw new AppError("找不到这个声音", 404, "VOICE_NOT_FOUND");
  return rows[0].data;
}
export async function addVoice(voice: Voice, owner = ownerSubject(), db = database()) {
  await db.query("INSERT INTO voices(owner,id,data) VALUES ($1,$2,$3)", [owner, voice.id, voice]);
  return voice;
}
export async function findDocument(id: string, owner = ownerSubject(), db = database()): Promise<ReaderDocument> {
  const [{ rows }, segments] = await Promise.all([
    db.query<{ data: Omit<ReaderDocument, "segments"> }>("SELECT data FROM documents WHERE owner=$1 AND id=$2", [owner, id]),
    db.query<{ data: Segment }>("SELECT data FROM segments WHERE owner=$1 AND document_id=$2 ORDER BY position", [owner, id]),
  ]);
  if (!rows[0]) throw new AppError("找不到这篇文章", 404, "DOCUMENT_NOT_FOUND");
  return { ...rows[0].data, segments: segments.rows.map((s) => s.data) };
}
export async function findSegment(id: string, owner = ownerSubject(), db = database()) {
  const { rows } = await db.query<{ data: Segment }>("SELECT data FROM segments WHERE owner=$1 AND id=$2", [owner, id]);
  if (!rows[0]) throw new AppError("找不到这个朗读段落", 404, "SEGMENT_NOT_FOUND");
  return { segment: rows[0].data };
}
export async function listDocuments(owner = ownerSubject()): Promise<ReaderDocument[]> {
  const db = database();
  const [{ rows }, segments] = await Promise.all([
    db.query<{ data: Omit<ReaderDocument, "segments"> }>("SELECT data FROM documents WHERE owner=$1 ORDER BY created_at DESC", [owner]),
    db.query<{ data: Segment }>("SELECT data FROM segments WHERE owner=$1 ORDER BY position", [owner]),
  ]);
  const byDoc = new Map<string, Segment[]>();
  for (const { data } of segments.rows) {
    const items = byDoc.get(data.documentId) || [];
    items.push(data);
    byDoc.set(data.documentId, items);
  }
  return rows.map(({ data }) => ({ ...data, segments: byDoc.get(data.id) || [] }));
}
export async function insertDocument(document: ReaderDocument, owner: string, db: Database) {
  const { segments, ...data } = document;
  await db.query("INSERT INTO documents(owner,id,data,created_at) VALUES($1,$2,$3,$4)", [owner, data.id, data, data.createdAt]);
  for (const segment of segments) {
    await db.query("INSERT INTO segments(owner,id,document_id,position,data) VALUES($1,$2,$3,$4,$5)", [owner, segment.id, data.id, segment.index, segment]);
  }
  return document;
}
export async function addDocument(document: ReaderDocument, owner = ownerSubject()) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    return insertDocument(document, owner, db);
  });
}
// Read-only compatibility for export/migration diagnostics, not a mutation API.
export async function readStore(owner = ownerSubject()): Promise<StoreData> {
  const [voices, documents, cache] = await Promise.all([
    listVoices(owner), listDocuments(owner),
    database().query<{ key: string }>("SELECT key FROM audio_cache WHERE owner=$1", [owner]),
  ]);
  return { voices, documents, audioCache: Object.fromEntries(cache.rows.map(({ key }) => [key, key])) };
}
