import { getAddress } from "ethers";
import { networkSchema, type EngineRequest, type NetworkInput } from "./types";

const RESERVED_FILENAMES = new Set([".", "..", "node_modules", "artifacts", "cache"]);

export interface SolidityContractDeclaration {
  name: string;
  file: string;
}

function sourceWithoutCommentsOrStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (value) => " ".repeat(value.length))
    .replace(/\/\/[^\r\n]*/g, (value) => " ".repeat(value.length))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => " ".repeat(value.length));
}

/** Finds deployable Solidity contract declarations, excluding interfaces and libraries. */
export function findSolidityContractDeclarations(source: string, file: string): SolidityContractDeclaration[] {
  const declarations: SolidityContractDeclaration[] = [];
  const code = sourceWithoutCommentsOrStrings(source);
  for (const match of code.matchAll(/\bcontract\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    declarations.push({ name: match[1], file });
  }
  return declarations;
}

export function requiredUploadedContracts(request: EngineRequest): string[] {
  if (request.action === "deploy-suite") return ["TopazPayment", "TopazLifecycle", "TopazContacts"];
  return [...new Set(request.payload.items.map((item) => item.contractName))];
}

export function assertNoDuplicateContractDeclarations(declarations: readonly SolidityContractDeclaration[]): void {
  const byName = new Map<string, SolidityContractDeclaration[]>();
  for (const declaration of declarations) {
    const matches = byName.get(declaration.name) ?? [];
    matches.push(declaration);
    byName.set(declaration.name, matches);
  }
  const duplicates = [...byName.entries()].filter(([, matches]) => matches.length > 1);
  if (duplicates.length > 0) {
    const details = duplicates.map(([name, matches]) => `${name}（${matches.map((item) => item.file).join("、")}）`).join("；");
    throw new Error(`本次上传源码存在重复合约声明：${details}。请只保留每个合约的一份源码`);
  }
}

export function assertRequiredContractsUploaded(request: EngineRequest, declarations: readonly SolidityContractDeclaration[]): void {
  assertNoDuplicateContractDeclarations(declarations);
  const names = new Set(declarations.map((item) => item.name));
  const missing = requiredUploadedContracts(request).filter((name) => !names.has(name));
  if (missing.length > 0) {
    const actionLabel = request.action === "deploy-suite" ? "部署整套" : "升级";
    throw new Error(`${actionLabel}前必须在本次上传源码中包含合约声明：${missing.join("、")}。请同时上传目标合约及其全部本地依赖`);
  }
}

export function validateAddress(value: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error("无效的以太坊地址");
  }
}

export function validateNetworkConfig(input: unknown): NetworkInput {
  const parsed = networkSchema.parse(input);
  return { ...parsed, admin: validateAddress(parsed.admin) };
}

export function sanitizeSolidityRelativePath(input: string): string {
  if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new Error("源码路径必须是相对路径");
  }
  const normalized = input.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !normalized.endsWith(".sol") ||
    parts.length === 0 ||
    parts.some((part) => !part || RESERVED_FILENAMES.has(part) || part.startsWith(".") || !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error("只允许安全的 .sol 相对路径");
  }
  return parts.join("/");
}

export function buildDeployPlan() {
  return [
    { order: 1, id: "payment", label: "部署 TopazPayment 实现与代理", dependsOn: [] as string[] },
    { order: 2, id: "lifecycle", label: "部署 TopazLifecycle 实现与代理", dependsOn: ["payment"] },
    { order: 3, id: "contacts", label: "部署 TopazContacts 实现与代理", dependsOn: [] as string[] },
    { order: 4, id: "grant-role", label: "授予 Lifecycle 调用 Payment 的角色", dependsOn: ["payment", "lifecycle"] },
    { order: 5, id: "verify", label: "复核代理实现地址并保存记录", dependsOn: ["payment", "lifecycle", "contacts", "grant-role"] },
  ] as const;
}

export async function runSequentialFailFast<T, R>(items: readonly T[], operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 1) {
    results.push(await operation(items[index], index));
  }
  return results;
}

export function redactRecord<T>(value: T): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).filter(([key]) => !/private.?key|mnemonic|secret/i.test(key)).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return visit(value) as T;
}

export function assertConstructorOnlyDisablesInitializers(source: string, contractName: string): void {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const contractIndex = withoutComments.search(new RegExp(`\\bcontract\\s+${contractName}\\b`));
  if (contractIndex < 0) throw new Error(`源码中未找到 ${contractName}`);
  const contractSource = withoutComments.slice(contractIndex);
  const constructor = contractSource.match(/constructor\s*\([^)]*\)\s*\{([^}]*)\}/s);
  if (!constructor || !/^\s*_disableInitializers\s*\(\s*\)\s*;\s*$/.test(constructor[1])) {
    throw new Error(`${contractName} 构造函数必须且只能调用 _disableInitializers()`);
  }
}
