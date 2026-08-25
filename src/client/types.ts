export type Mode = "upgrade" | "deploy";

export type SourceFile = {
  id: string;
  name: string;
  path: string;
  content: string;
  size: number;
};

export type UpgradeItem = SourceFile & {
  contractName: string;
  proxyAddress: string;
};

export type NetworkForm = {
  rpcUrl: string;
  chainId: string;
  adminAddress: string;
  storageDirectory: string;
};

export type NetworkCheck = {
  ok: boolean;
  expectedChainId?: number;
  actualChainId?: number;
  latestBlock?: number;
  signer?: { mode: "environment" | "rpc-unlocked"; address: string; matchesAdmin: boolean };
  message?: string;
};

export type JobStatus = "queued" | "checking" | "running" | "succeeded" | "failed";

export type JobNodeStatus = "pending" | "running" | "succeeded" | "failed";

export type JobNode = {
  id: string;
  label: string;
  status: JobNodeStatus;
  message?: string;
};

export type JobLog = {
  at: string;
  level: "info" | "success" | "error";
  message: string;
};

export type Job = {
  id: string;
  action: string;
  status: JobStatus;
  stage?: string;
  message?: string;
  progress?: number;
  nodes?: JobNode[];
  logs?: JobLog[];
  result?: Record<string, unknown>;
  error?: string | { message: string; code?: string };
};

export type TransactionRecord = {
  label: string;
  hash: string;
  blockNumber: number;
  status: "confirmed";
};

export type ContractRecord = {
  contractName: string;
  proxyAddress: string;
  implementationAddress: string;
  proxyTransactionHash?: string;
  implementationTransactionHash?: string;
};

export type UpgradeRecord = {
  contractName: string;
  proxyAddress: string;
  previousImplementation: string;
  implementationAddress: string;
  transactionHash: string;
  blockNumber: number;
};

export type EngineRecord = {
  action: "deploy-suite" | "upgrade-batch";
  status?: "running" | "succeeded" | "failed";
  chainId?: number;
  admin?: string;
  startedAt: string;
  completedAt?: string;
  dryRun?: boolean;
  checks?: string[];
  deployments?: ContractRecord[];
  upgrades?: UpgradeRecord[];
  transactions: TransactionRecord[];
  error?: { message: string };
};
