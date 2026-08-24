import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "必须是 20 字节以太坊地址").refine((value) => !/^0x0{40}$/i.test(value), "地址不能为零地址");
const rpcUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "RPC 仅支持 http/https" });
  }
  if (url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "RPC URL 不允许内嵌账号或密码" });
  }
});

export const networkSchema = z.object({
  rpcUrl,
  chainId: z.number().int().positive().safe(),
  admin: address,
});

export const deploySuiteSchema = z.object({
  network: networkSchema,
  sourceSetId: z.string().uuid(),
  dryRun: z.boolean().default(false),
});

export const upgradeItemSchema = z.object({
  contractName: z.enum(["TopazPayment", "TopazLifecycle", "TopazContacts"]),
  proxyAddress: address,
});

export const upgradeBatchSchema = z.object({
  network: networkSchema,
  sourceSetId: z.string().uuid(),
  items: z.array(upgradeItemSchema).min(1).max(12),
  dryRun: z.boolean().default(false),
});

export const importBaselineSchema = z.object({
  network: networkSchema,
  sourceSetId: z.string().uuid(),
  contractName: z.enum(["TopazPayment", "TopazLifecycle", "TopazContacts"]),
  proxyAddress: address,
  dryRun: z.boolean().default(false),
});

export type NetworkInput = z.infer<typeof networkSchema>;
export type DeploySuiteInput = z.infer<typeof deploySuiteSchema>;
export type UpgradeBatchInput = z.infer<typeof upgradeBatchSchema>;
export type ImportBaselineInput = z.infer<typeof importBaselineSchema>;
export type EngineRequest =
  | { action: "deploy-suite"; payload: DeploySuiteInput }
  | { action: "upgrade-batch"; payload: UpgradeBatchInput }
  | { action: "import-baseline"; payload: ImportBaselineInput };

export interface TransactionRecord {
  label: string;
  hash: string;
  blockNumber: number;
  status: "confirmed";
}

export interface ContractDeploymentRecord {
  contractName: string;
  proxyAddress: string;
  implementationAddress: string;
  proxyTransactionHash?: string;
  implementationTransactionHash?: string;
}

export interface EngineResult {
  action: EngineRequest["action"];
  status: "succeeded";
  chainId: number;
  admin: string;
  startedAt: string;
  completedAt: string;
  dryRun?: boolean;
  checks?: string[];
  deployments?: ContractDeploymentRecord[];
  upgrades?: Array<{
    contractName: string;
    proxyAddress: string;
    previousImplementation: string;
    implementationAddress: string;
    transactionHash: string;
    blockNumber: number;
  }>;
  importedBaseline?: {
    contractName: string;
    proxyAddress: string;
    implementationAddress: string;
    bytecodeVerified: true;
  };
  transactions: TransactionRecord[];
}

export type UpgradeRecord = NonNullable<EngineResult["upgrades"]>[number];

export interface JobJournal {
  action: EngineRequest["action"];
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  chainId?: number;
  admin?: string;
  dryRun?: boolean;
  transactions: TransactionRecord[];
  deployments: ContractDeploymentRecord[];
  upgrades: UpgradeRecord[];
  knownContracts: Array<{
    contractName: string;
    proxyAddress: string;
    implementationAddress: string;
    relation: "current" | "new";
  }>;
  importedBaseline?: EngineResult["importedBaseline"];
  error?: { message: string };
  stage: string;
  progress: number;
  nodes: JobNode[];
  logs: JobLog[];
}

export interface JobNode {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
  message?: string;
}

export interface JobLog {
  at: string;
  level: "info" | "success" | "error";
  message: string;
}

export type PersistedJobRecord = EngineResult | JobJournal;

export type PublicJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface PublicJob {
  id: string;
  action: EngineRequest["action"];
  status: PublicJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: EngineResult;
  error?: { message: string; code?: string };
  stage: string;
  progress: number;
  nodes: JobNode[];
  logs: JobLog[];
}
