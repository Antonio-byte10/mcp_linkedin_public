import fs from "node:fs";
import path from "node:path";
import { clipFields } from "./untrusted.js";

/**
 * Per-job audit transcript of apply attempts (<data folder>/applications/<job_id>.json). Written as soon as an
 * attempt ends, so a lost tool reply never loses what was answered and why it stopped. The answer log is
 * already masked by the planner (sensitive/personal values are "***"); only the last 20 attempts are kept.
 */
export function writeTranscript(dir: string, jobId: string, r: Record<string, unknown>, now = new Date()): string | null {
  if (!/^\d{1,20}$/.test(jobId)) return null; // job ids are numeric: never a path
  const attempt = clipFields(
    {
      at: now.toISOString(),
      status: r.status,
      reason: r.reason,
      unanswered: r.unanswered,
      errors: r.errors,
      answers: r.answers,
    },
    300,
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.json`);
  let attempts: unknown[] = [];
  try {
    const old = JSON.parse(fs.readFileSync(file, "utf8")) as { attempts?: unknown };
    if (Array.isArray(old.attempts)) attempts = old.attempts;
  } catch {
    // first attempt, or an unreadable file: start over
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ job_id: jobId, attempts: [...attempts, attempt].slice(-20) }, null, 2));
  fs.renameSync(tmp, file);
  return file;
}
