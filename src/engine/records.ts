import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedJobRecord } from "./types";
import { redactRecord } from "./validation";

const projectRoot = path.resolve(process.cwd());
const recordsDirectory = path.join(projectRoot, "data", "records");

export async function persistEngineRecord(jobId: string, result: PersistedJobRecord): Promise<void> {
  await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
  const finalPath = path.join(recordsDirectory, `${jobId}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(redactRecord(result), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, finalPath);
}

export async function listEngineRecords(): Promise<PersistedJobRecord[]> {
  try {
    const files = (await readdir(recordsDirectory)).filter((file) => file.endsWith(".json")).sort().reverse();
    return await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(recordsDirectory, file), "utf8")) as PersistedJobRecord));
  } catch {
    return [];
  }
}
