export type SynthesisInput = {
  text: string;
  providerVoiceId: string | null;
  speed: number;
  model: string;
};

export type CloneVoiceInput = {
  name: string;
  audio: File[];
  transcript?: string;
};

export interface VoiceProviderAdapter {
  synthesize(input: SynthesisInput): Promise<ArrayBuffer>;
  cloneVoice(input: CloneVoiceInput): Promise<{ providerVoiceId: string }>;
}
