import { claimNext, completeGeneration, uncertainGeneration } from "@/lib/jobs";
import { getVoiceProvider } from "@/lib/providers";
import { putAudio } from "@/lib/blob";
import { ownerSubject, validateResourceIdentity } from "@/lib/config";

export async function generateNext(jobId: string, owner: string): Promise<"busy" | "done" | "progress"> {
  "use step";
  if (owner !== ownerSubject()) return "done";
  await validateResourceIdentity();
  const claim = await claimNext(jobId, owner);
  if (typeof claim === "string") return claim;
  try {
    const bytes = await getVoiceProvider(claim.voice.provider).synthesize({
      text: claim.segment.text, providerVoiceId: claim.voice.providerVoiceId,
      speed: claim.job.speed, model: claim.job.model,
    });
    const audio = await putAudio(owner, bytes);
    await completeGeneration(claim, audio);
  } catch {
    await uncertainGeneration(claim);
  }
  return "progress";
}
// Recovery re-enters through the persisted claim, never by retrying Fish blindly.
generateNext.maxRetries = 0;
