import { claimNext, completeGeneration, uncertainGeneration, pendingGeneration, failedGeneration } from "@/lib/jobs";
import { AppError } from "@/lib/errors";
import { IndexTtsProvider } from "@/lib/providers/indextts";
import { getVoiceProvider } from "@/lib/providers";
import { putAudio } from "@/lib/blob";
import { ownerSubject, validateResourceIdentity } from "@/lib/config";

export async function generateNext(jobId: string, owner: string): Promise<"busy" | "done" | "progress"> {
  "use step";
  if (owner !== ownerSubject()) return "done";
  await validateResourceIdentity();
  const claim = await claimNext(jobId, owner);
  if (typeof claim === "string") return claim;
  if (claim.job.synthesis?.provider === "indextts") {
    try {
      const result = await new IndexTtsProvider().poll(claim);
      if (result.status === "ready") {
        await completeGeneration(claim, await putAudio(owner, result.audio));
      } else if (result.status === "error") await failedGeneration(claim);
      else if (result.status === "uncertain") await uncertainGeneration(claim);
      else await pendingGeneration(claim);
    } catch (error) {
      if (error instanceof AppError && [403, 422].includes(error.status)) {
        await failedGeneration(claim);
        return "progress";
      }
      // Lost replies are retried with the same durable request ID, until the claim expires.
      await pendingGeneration(claim);
    }
    return "progress";
  }
  try {
    const bytes = await getVoiceProvider(claim.job.synthesis?.provider || claim.voice.provider).synthesize({
      text: claim.segment.text, providerVoiceId: claim.job.synthesis ? claim.job.synthesis.providerVoiceId : claim.voice.providerVoiceId,
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
