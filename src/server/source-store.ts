import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EngineRequest } from "../engine/types.js";
import {
  assertRequiredContractsUploaded,
  assertNoDuplicateContractDeclarations,
  findSolidityContractDeclarations,
  sanitizeSolidityRelativePath,
  type SolidityContractDeclaration,
} from "../engine/validation.js";

const projectRoot = path.resolve(process.cwd());
const defaultSourceSetsRoot = path.join(projectRoot, ".runtime", "source-sets");
const sourceIndexRoot = path.join(projectRoot, ".runtime", "source-index");
const activeContractsRoot = path.join(projectRoot, ".runtime", "contracts");

export interface UploadedSource {
  originalname: string;
  buffer: Buffer;
  size: number;
}

interface SourceSetManifest {
  sourceSetId: string;
  files: string[];
  contracts: SolidityContractDeclaration[];
  storageDirectory?: string;
}

function assertSourceSetId(sourceSetId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(sourceSetId)) throw new Error("源码集编号无效");
}

async function resolveStorageRoot(requestedDirectory?: string): Promise<string> {
  const input = requestedDirectory?.trim();
  const selected = input || defaultSourceSetsRoot;
  if (!path.isAbsolute(selected)) throw new Error("源码存储目录必须是当前系统的绝对路径");
  const resolved = path.resolve(selected);
  if (resolved === path.parse(resolved).root) throw new Error("不能把磁盘根目录作为源码存储目录");
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error("源码存储位置不是目录");
  return canonical;
}

async function writeSourceIndex(sourceSetId: string, storageRoot: string): Promise<void> {
  await mkdir(sourceIndexRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceIndexRoot, `${sourceSetId}.json`), JSON.stringify({ storageRoot }, null, 2), { flag: "wx", mode: 0o600 });
}

async function sourceSetDirectory(sourceSetId: string): Promise<string> {
  assertSourceSetId(sourceSetId);
  try {
    const pointer = JSON.parse(await readFile(path.join(sourceIndexRoot, `${sourceSetId}.json`), "utf8")) as { storageRoot?: unknown };
    if (typeof pointer.storageRoot !== "string" || !path.isAbsolute(pointer.storageRoot)) throw new Error("源码存储索引已损坏");
    const root = await realpath(pointer.storageRoot);
    return path.join(root, sourceSetId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(defaultSourceSetsRoot, sourceSetId);
  }
}

export async function createSourceSet(files: UploadedSource[], requestedDirectory?: string): Promise<SourceSetManifest> {
  if (files.length === 0 || files.length > 80) throw new Error("每次需上传 1 到 80 个 Solidity 文件");
  const sourceSetId = randomUUID();
  const storageRoot = await resolveStorageRoot(requestedDirectory);
  const directory = path.join(storageRoot, sourceSetId);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const names = new Set<string>();
  const caseInsensitiveNames = new Set<string>();
  const contracts: SolidityContractDeclaration[] = [];

  try {
    for (const file of files) {
      if (file.size <= 0 || file.size > 2 * 1024 * 1024) throw new Error("单个源码文件不能超过 2 MB");
      const safeName = sanitizeSolidityRelativePath(file.originalname);
      if (names.has(safeName)) throw new Error(`文件名重复：${safeName}`);
      if (caseInsensitiveNames.has(safeName.toLowerCase())) throw new Error(`源码路径大小写冲突：${safeName}`);
      names.add(safeName);
      caseInsensitiveNames.add(safeName.toLowerCase());
      contracts.push(...findSolidityContractDeclarations(file.buffer.toString("utf8"), safeName));
      await mkdir(path.dirname(path.join(directory, safeName)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, safeName), file.buffer, { flag: "wx", mode: 0o600 });
    }
    // Reject ambiguity immediately, even when the duplicate is not one of the Topaz entry contracts.
    assertNoDuplicateContractDeclarations(contracts);
    const manifest = { sourceSetId, files: [...names], contracts };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    await writeSourceIndex(sourceSetId, storageRoot);
    return { ...manifest, storageDirectory: storageRoot };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readVerifiedSourceSet(sourceSetId: string): Promise<SourceSetManifest> {
  const sourceDirectory = await sourceSetDirectory(sourceSetId);
  const info = await stat(sourceDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("源码集不存在，请重新上传源码");
  const stored = JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8")) as Partial<SourceSetManifest>;
  if (stored.sourceSetId !== sourceSetId || !Array.isArray(stored.files) || stored.files.length === 0) throw new Error("源码清单已损坏，请重新上传源码");

  const declarations: SolidityContractDeclaration[] = [];
  const files: string[] = [];
  for (const name of stored.files) {
    if (typeof name !== "string") throw new Error("源码清单已损坏，请重新上传源码");
    const safeName = sanitizeSolidityRelativePath(name);
    files.push(safeName);
    const content = await readFile(path.join(sourceDirectory, safeName), "utf8");
    declarations.push(...findSolidityContractDeclarations(content, safeName));
  }
  const expected = JSON.stringify(stored.contracts ?? []);
  if (expected !== JSON.stringify(declarations)) throw new Error("源码文件与上传清单不一致，请重新上传源码");
  return { sourceSetId, files, contracts: declarations };
}

export async function validateSourceSetForRequest(sourceSetId: string, request: EngineRequest): Promise<SourceSetManifest> {
  const manifest = await readVerifiedSourceSet(sourceSetId);
  assertRequiredContractsUploaded(request, manifest.contracts);
  return manifest;
}

export async function stageSourceSet(sourceSetId: string): Promise<void> {
  const sourceDirectory = await sourceSetDirectory(sourceSetId);
  const manifest = await readVerifiedSourceSet(sourceSetId);

  await rm(activeContractsRoot, { recursive: true, force: true });
  await mkdir(activeContractsRoot, { recursive: true, mode: 0o700 });
  for (const name of manifest.files) {
    const safeName = sanitizeSolidityRelativePath(name);
    await mkdir(path.dirname(path.join(activeContractsRoot, safeName)), { recursive: true, mode: 0o700 });
    await copyFile(path.join(sourceDirectory, safeName), path.join(activeContractsRoot, safeName));
  }
}

export async function readStagedSources(): Promise<Array<{ name: string; content: string }>> {
  const walk = async (directory: string): Promise<Array<{ name: string; content: string }>> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: Array<{ name: string; content: string }> = [];
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) results.push(...await walk(fullPath));
      else if (entry.isFile() && entry.name.endsWith(".sol")) results.push({ name: path.relative(activeContractsRoot, fullPath), content: await readFile(fullPath, "utf8") });
    }
    return results;
  };
  return walk(activeContractsRoot);
}
