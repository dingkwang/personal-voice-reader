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

export type SegmentStatus = "idle" | "ready" | "error";

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
