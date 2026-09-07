import { sleep } from "workflow";
import { generateNext } from "./steps";

// Only opaque IDs enter Workflow logs. Text, credentials and audio stay in steps.
export async function generateReading(jobId: string, owner: string) {
  "use workflow";
  async function lane() {
    for (let count = 0; count < 900; count++) {
      const result = await generateNext(jobId, owner);
      if (result === "done") return;
      if (result === "busy") await sleep("2s");
    }
  }
  await Promise.all([lane(), lane()]);
}
