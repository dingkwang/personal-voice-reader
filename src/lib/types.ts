export type VoiceProvider = "fish" | "elevenlabs" | "minimax" | "local";

export type Voice = {
  id: string;
  name: string;
  provider: VoiceProvider;
  providerVoiceId: string | null;
  language: string;
  createdAt: string;
  source: "default" | "cloned" | "linked";
};

export type SegmentStatus = "idle" | "queued" | "working" | "ready" | "error" | "uncertain";

export type Segment = {
  id: string;
  documentId: string;
  index: number;
  text: string;
  status: SegmentStatus;
  audioHash: string | null;
  audioUrl: string | null;
  voiceId: string | null;
  speed: number | null;
};

export type ReaderDocument = {
  id: string;
  title: string;
  originalText: string;
  createdAt: string;
  segments: Segment[];
};

export type ReadingJob = {
  id: string;
  document_id: string;
  voice_id: string;
  speed: number;
  model: string;
  status: "queued" | "running" | "completed" | "attention";
  run_id: string | null;
};
export type JobStatus = ReadingJob & {
  items: { segment_id: string; status: SegmentStatus; error: string | null; audioUrl: string | null }[];
  url: string;
};

export type StoreData = {
  voices: Voice[];
  documents: ReaderDocument[];
  audioCache: Record<string, string>;
};

export type PublicDocument = Omit<ReaderDocument, "originalText"> & {
  characterCount: number;
};

export function toPublicDocument(document: ReaderDocument): PublicDocument {
  const { originalText, ...rest } = document;
  return { ...rest, characterCount: originalText.length };
}

export type DocumentSummary = {
  id: string;
  title: string;
  createdAt: string;
  characterCount: number;
  segmentCount: number;
  preview: string;
};

export function toDocumentSummary(document: ReaderDocument): DocumentSummary {
  return {
    id: document.id,
    title: document.title,
    createdAt: document.createdAt,
    characterCount: document.originalText.length,
    segmentCount: document.segments.length,
    preview: document.originalText.slice(0, 100),
  };
}
