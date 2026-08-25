import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import hre from "hardhat";
import { Contract, Wallet, ZeroAddress, ZeroHash, getAddress, keccak256, toUtf8Bytes, type Signer, type TransactionReceipt, type TransactionResponse } from "ethers";
import type { ContractDeploymentRecord, EngineRequest, EngineResult, JobJournal, TransactionRecord, UpgradeRecord } from "./types";
import { assertConstructorOnlyDisablesInitializers, runSequentialFailFast } from "./validation";
import { buildJobNodes, updateProgress } from "./progress";

const requestPath = process.env.CONTRACT_CONSOLE_JOB_REQUEST;
const resultPath = process.env.CONTRACT_CONSOLE_JOB_RESULT;
const journalPath = process.env.CONTRACT_CONSOLE_JOB_JOURNAL;
const expectedAdmin = process.env.CONTRACT_CONSOLE_ADMIN;
const projectRoot = path.resolve(process.cwd());
const contractsRoot = path.join(projectRoot, ".runtime", "contracts");
const expectedUupsSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const accessControlAbi = ["function hasRole(bytes32 role,address account) view returns (bool)"];
const uupsAbi = ["function proxiableUUID() view returns (bytes32)"];

if (!requestPath || !resultPath || !journalPath || !expectedAdmin) throw new Error("任务环境缺少必要参数");

let journal: JobJournal | undefined;

async function flushJournal(): Promise<void> {
  if (!journal) return;
  const temporaryPath = `${journalPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(journal, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, journalPath!);
}

async function mark(nodeId: string, status: "running" | "succeeded" | "failed", message: string): Promise<void> {
  if (!journal) return;
  updateProgress(journal, nodeId, status, message);
  await flushJournal();
}

function confirmedTransaction(label: string, receipt: TransactionReceipt): TransactionRecord {
  if (receipt.status !== 1) throw new Error(`${label} 交易执行失败`);
  return { label, hash: receipt.hash, blockNumber: receipt.blockNumber, status: "confirmed" };
}

async function recordConfirmedTransaction(label: string, receipt: TransactionReceipt, transactions: TransactionRecord[]): Promise<void> {
  const record = confirmedTransaction(label, receipt);
  transactions.push(record);
  journal?.transactions.push(record);
  await flushJournal();
}

async function recordDeployment(deployment: ContractDeploymentRecord): Promise<void> {
  journal?.deployments.push(deployment);
  journal?.knownContracts.push({
    contractName: deployment.contractName,
    proxyAddress: deployment.proxyAddress,
    implementationAddress: deployment.implementationAddress,
    relation: "new",
  });
  await flushJournal();
}

async function recordKnownContract(contractName: string, proxyAddress: string, implementationAddress: string, relation: "current" | "new"): Promise<void> {
  if (journal && !journal.knownContracts.some((entry) =>
    entry.contractName === contractName &&
    entry.proxyAddress.toLowerCase() === proxyAddress.toLowerCase() &&
    entry.implementationAddress.toLowerCase() === implementationAddress.toLowerCase() &&
    entry.relation === relation
  )) {
    journal.knownContracts.push({ contractName, proxyAddress, implementationAddress, relation });
    await flushJournal();
  }
}

async function recordUpgrade(upgrade: UpgradeRecord): Promise<void> {
  journal?.upgrades.push(upgrade);
  await flushJournal();
}

async function signerForAdmin(admin: string): Promise<Signer> {
  const configuredPrivateKey = process.env.CONTRACT_CONSOLE_PRIVATE_KEY;
  if (configuredPrivateKey) {
    const signer = new Wallet(configuredPrivateKey, hre.ethers.provider);
    if (getAddress(await signer.getAddress()) !== getAddress(admin)) {
      throw new Error("CONTRACT_CONSOLE_PRIVATE_KEY 对应地址与 Admin 不一致");
    }
    return signer;
  }
  const unlocked = (await hre.ethers.provider.send("eth_accounts", []) as string[]).map((value) => value.toLowerCase());
  if (!unlocked.includes(admin.toLowerCase())) {
    throw new Error("RPC 未解锁 Admin 地址；请在本机环境变量 CONTRACT_CONSOLE_PRIVATE_KEY 配置签名私钥，或在 Besu 解锁该账户");
  }
  return hre.ethers.getSigner(admin);
}

async function preflight(request: EngineRequest): Promise<{ signer: Signer; chainId: number; admin: string }> {
  const network = await hre.ethers.provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (actualChainId !== request.payload.network.chainId) {
    throw new Error(`Chain ID 不一致：页面为 ${request.payload.network.chainId}，RPC 返回 ${actualChainId}`);
  }
  const admin = getAddress(request.payload.network.admin);
  if (admin !== getAddress(expectedAdmin!)) throw new Error("任务中的 Admin 与运行环境不一致");
  const signer = await signerForAdmin(admin);
  await hre.ethers.provider.getBlockNumber();
  await hre.ethers.provider.getFeeData();
  return { signer, chainId: actualChainId, admin };
}

async function findContractSource(contractName: string): Promise<string> {
  const entries = await readdir(contractsRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sol")) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const content = await readFile(absolute, "utf8");
    if (new RegExp(`\\bcontract\\s+${contractName}\\b`).test(content)) return content;
  }
  throw new Error(`源码中未找到 ${contractName}`);
}

async function checkedFactory(contractName: string, signer: Signer) {
  const source = await findContractSource(contractName);
  assertConstructorOnlyDisablesInitializers(source, contractName);
  const factory = await hre.ethers.getContractFactory(contractName, signer);
  const artifact = await hre.artifacts.readArtifact(contractName);
  const deployedSize = Math.max(0, (artifact.deployedBytecode.length - 2) / 2);
  if (deployedSize > 24_576 && process.env.CONTRACT_CONSOLE_ALLOW_OVERSIZED_CONTRACTS !== "true") {
    throw new Error(`${contractName} 运行时代码为 ${deployedSize} 字节，超过 EIP-170 上限 24576；只有确认目标 Besu 允许超大合约后，才能设置 CONTRACT_CONSOLE_ALLOW_OVERSIZED_CONTRACTS=true`);
  }
  await hre.upgrades.validateImplementation(factory, { kind: "uups", unsafeAllow: ["constructor"] });
  return factory;
}

async function requireAccess(contractAddress: string, contractName: string, admin: string): Promise<void> {
  const access = new Contract(contractAddress, accessControlAbi, hre.ethers.provider);
  if (contractName === "TopazPayment") {
    if (!await access.hasRole(ZeroHash, admin)) throw new Error(`${admin} 不是 TopazPayment 的 DEFAULT_ADMIN_ROLE`);
    return;
  }
  const adminRole = keccak256(toUtf8Bytes("ADMIN_ROLE"));
  const superAdminRole = keccak256(toUtf8Bytes("SUPER_ADMIN_ROLE"));
  if (!await access.hasRole(adminRole, admin) && !await access.hasRole(superAdminRole, admin)) {
    throw new Error(`${admin} 没有 ${contractName} 的升级权限`);
  }
}

async function requireUupsProxy(proxyAddress: string): Promise<string> {
  const proxyCode = await hre.ethers.provider.getCode(proxyAddress);
  if (proxyCode === "0x") throw new Error(`代理地址没有合约代码：${proxyAddress}`);
  const implementation = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
  if (implementation === ZeroAddress || await hre.ethers.provider.getCode(implementation) === "0x") {
    throw new Error(`ERC1967 实现地址无效：${proxyAddress}`);
  }
  const uuid = await new Contract(implementation, uupsAbi, hre.ethers.provider).proxiableUUID();
  if (String(uuid).toLowerCase() !== expectedUupsSlot) throw new Error(`${proxyAddress} 的实现不是兼容的 UUPS 实现`);
  return getAddress(implementation);
}

async function manifestImplementationTxHash(implementationAddress: string): Promise<string | undefined> {
  for (const directory of [path.join(projectRoot, ".openzeppelin"), path.join(tmpdir(), "openzeppelin-upgrades")]) {
    try {
      const files = await readdir(directory);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const manifest = JSON.parse(await readFile(path.join(directory, file), "utf8")) as { impls?: Record<string, { address?: string; txHash?: string }> };
        for (const deployment of Object.values(manifest.impls ?? {})) {
          if (deployment.address?.toLowerCase() === implementationAddress.toLowerCase()) return deployment.txHash;
        }
      }
    } catch {
      // Try the next manifest location. Hardhat development networks use a temporary manifest.
    }
  }
  return undefined;
}

async function requireProxyInManifest(proxyAddress: string): Promise<void> {
  for (const directory of [path.join(projectRoot, ".openzeppelin"), path.join(tmpdir(), "openzeppelin-upgrades")]) {
    try {
      const files = await readdir(directory);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const manifest = JSON.parse(await readFile(path.join(directory, file), "utf8")) as { proxies?: Array<{ address?: string }> };
        if ((manifest.proxies ?? []).some((proxy) => proxy.address?.toLowerCase() === proxyAddress.toLowerCase())) return;
      }
    } catch {
      // Try the next manifest location.
    }
  }
  throw new Error(`代理 ${proxyAddress} 不在本工具的部署记录中，无法安全校验存储布局`);
}

async function deployOne(
  contractName: string,
  initializerArgs: unknown[],
  signer: Signer,
  transactions: TransactionRecord[],
  nodePrefix: "payment" | "lifecycle" | "contacts",
): Promise<{ contract: Contract; record: ContractDeploymentRecord }> {
  await mark(`${nodePrefix}_impl`, "running", `开始部署 ${contractName} 实现与代理`);
  const factory = await checkedFactory(contractName, signer);
  const contract = await hre.upgrades.deployProxy(factory, initializerArgs, {
    kind: "uups",
    initializer: "initialize",
    unsafeAllow: ["constructor"],
  }) as unknown as Contract;
  await contract.waitForDeployment();
  const proxyAddress = getAddress(await contract.getAddress());
  const deploymentTransaction = contract.deploymentTransaction();
  if (!deploymentTransaction) throw new Error(`${contractName} 未返回代理部署交易`);
  const receipt = await deploymentTransaction.wait();
  if (!receipt) throw new Error(`${contractName} 代理部署回执为空`);
  const implementationAddress = await requireUupsProxy(proxyAddress);
  const implementationTransactionHash = await manifestImplementationTxHash(implementationAddress);
  if (!implementationTransactionHash) throw new Error(`${contractName} 实现部署交易未写入 OpenZeppelin manifest`);
  const implementationReceipt = await hre.ethers.provider.getTransactionReceipt(implementationTransactionHash);
  if (!implementationReceipt) throw new Error(`${contractName} 实现部署回执不存在`);
  await recordConfirmedTransaction(`${contractName} 实现部署`, implementationReceipt, transactions);
  await mark(`${nodePrefix}_impl`, "succeeded", `${contractName} 实现部署已确认：${implementationAddress}`);
  await mark(`${nodePrefix}_proxy`, "running", `等待 ${contractName} 代理部署与初始化回执`);
  await recordConfirmedTransaction(`${contractName} 代理部署并初始化`, receipt, transactions);
  const record = {
    contractName,
    proxyAddress,
    implementationAddress,
    proxyTransactionHash: receipt.hash,
    implementationTransactionHash,
  };
  await recordDeployment(record);
  await mark(`${nodePrefix}_proxy`, "succeeded", `${contractName} 代理部署并初始化已确认：${proxyAddress}`);
  return {
    contract,
    record,
  };
}

async function deploySuite(request: Extract<EngineRequest, { action: "deploy-suite" }>, signer: Signer, admin: string) {
  const transactions: TransactionRecord[] = [];
  const payment = await deployOne("TopazPayment", [admin], signer, transactions, "payment");
  await requireAccess(payment.record.proxyAddress, "TopazPayment", admin);
  const lifecycle = await deployOne("TopazLifecycle", [admin, payment.record.proxyAddress], signer, transactions, "lifecycle");
  await requireAccess(lifecycle.record.proxyAddress, "TopazLifecycle", admin);
  const contacts = await deployOne("TopazContacts", [admin], signer, transactions, "contacts");
  await requireAccess(contacts.record.proxyAddress, "TopazContacts", admin);

  const lifecycleRole = keccak256(toUtf8Bytes("LIFECYCLE_ROLE"));
  await mark("grant_role", "running", "提交 Payment 向 Lifecycle 授权交易");
  const paymentAccess = payment.contract.connect(signer) as Contract;
  const grantTransaction = await paymentAccess.grantRole(lifecycleRole, lifecycle.record.proxyAddress);
  const grantReceipt = await grantTransaction.wait();
  if (!grantReceipt) throw new Error("LIFECYCLE_ROLE 授权交易回执为空");
  await recordConfirmedTransaction("Payment 授予 Lifecycle LIFECYCLE_ROLE", grantReceipt, transactions);
  await mark("grant_role", "succeeded", `角色授权交易已确认：${grantReceipt.hash}`);
  await mark("verify", "running", "复核三个代理实现地址与 Lifecycle 角色");
  const roleGranted = await new Contract(payment.record.proxyAddress, accessControlAbi, hre.ethers.provider).hasRole(lifecycleRole, lifecycle.record.proxyAddress);
  if (!roleGranted) throw new Error("链上复核失败：Lifecycle 未获得 Payment 的 LIFECYCLE_ROLE");
  await mark("verify", "succeeded", "三个代理实现地址及 Lifecycle 角色复核通过");

  return { deployments: [payment.record, lifecycle.record, contacts.record], transactions };
}

async function upgradeBatch(request: Extract<EngineRequest, { action: "upgrade-batch" }>, signer: Signer, admin: string) {
  const transactions: TransactionRecord[] = [];
  const seen = new Set<string>();
  const upgrades = await runSequentialFailFast(request.payload.items, async (item, index) => {
    const proxyAddress = getAddress(item.proxyAddress);
    await mark(`upgrade_${index}_validate`, "running", `校验 ${item.contractName} 代理、权限和存储布局`);
    if (seen.has(proxyAddress)) throw new Error(`代理地址重复：${proxyAddress}`);
    seen.add(proxyAddress);
    await requireProxyInManifest(proxyAddress);
    const previousImplementation = await requireUupsProxy(proxyAddress);
    await recordKnownContract(item.contractName, proxyAddress, previousImplementation, "current");
    await requireAccess(proxyAddress, item.contractName, admin);
    const factory = await checkedFactory(item.contractName, signer);
    await hre.upgrades.validateUpgrade(proxyAddress, factory, { kind: "uups", unsafeAllow: ["constructor"] });
    await mark(`upgrade_${index}_validate`, "succeeded", `${item.contractName} UUPS、权限与存储布局校验通过`);
    await mark(`upgrade_${index}_upgrade`, "running", `提交 ${item.contractName} 升级交易`);
    const upgraded = await hre.upgrades.upgradeProxy(proxyAddress, factory, { kind: "uups", unsafeAllow: ["constructor"] }) as unknown as Contract;
    await upgraded.waitForDeployment();
    // OpenZeppelin attaches the upgrade transaction as a compatibility property
    // because this contract instance points at an existing proxy, not a new deployment.
    const transaction = (upgraded as Contract & { deployTransaction?: TransactionResponse }).deployTransaction
      ?? upgraded.deploymentTransaction();
    if (!transaction) throw new Error(`${item.contractName} 未返回升级交易`);
    const receipt = await transaction.wait();
    if (!receipt) throw new Error(`${item.contractName} 升级回执为空`);
    await recordConfirmedTransaction(`${item.contractName} 升级`, receipt, transactions);
    await mark(`upgrade_${index}_upgrade`, "succeeded", `${item.contractName} 升级交易已确认：${receipt.hash}`);
    await mark(`upgrade_${index}_verify`, "running", `复核 ${item.contractName} 新实现地址与权限`);
    const implementationAddress = await requireUupsProxy(proxyAddress);
    await recordKnownContract(item.contractName, proxyAddress, implementationAddress, "new");
    if (getAddress(previousImplementation) === getAddress(implementationAddress)) throw new Error(`${item.contractName} 升级后实现地址没有变化`);
    await requireAccess(proxyAddress, item.contractName, admin);
    const upgrade = {
      contractName: item.contractName,
      proxyAddress,
      previousImplementation,
      implementationAddress,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    };
    await recordUpgrade(upgrade);
    await mark(`upgrade_${index}_verify`, "succeeded", `${item.contractName} 新实现已复核：${implementationAddress}`);
    return upgrade;
  });
  return { upgrades, transactions };
}

async function checkOnly(request: EngineRequest, signer: Signer, admin: string): Promise<string[]> {
  const checks = ["RPC、Chain ID 与签名账户检查通过"];
  if (request.action === "deploy-suite") {
    for (const contractName of ["TopazPayment", "TopazLifecycle", "TopazContacts"]) {
      await checkedFactory(contractName, signer);
      checks.push(`${contractName} 编译与 UUPS 实现校验通过`);
    }
    checks.push("部署依赖顺序为 Payment → Lifecycle → Contacts → LIFECYCLE_ROLE");
    return checks;
  }
  await runSequentialFailFast(request.payload.items, async (item) => {
    await requireProxyInManifest(item.proxyAddress);
    await requireUupsProxy(item.proxyAddress);
    await requireAccess(item.proxyAddress, item.contractName, admin);
    const factory = await checkedFactory(item.contractName, signer);
    await hre.upgrades.validateUpgrade(item.proxyAddress, factory, { kind: "uups", unsafeAllow: ["constructor"] });
    checks.push(`${item.contractName} 的 UUPS、权限和存储布局兼容性检查通过`);
  });
  return checks;
}

async function main(): Promise<void> {
  const request = JSON.parse(await readFile(requestPath!, "utf8")) as EngineRequest;
  const startedAt = new Date().toISOString();
  try {
    journal = JSON.parse(await readFile(journalPath!, "utf8")) as JobJournal;
    journal.startedAt = startedAt;
  } catch {
    journal = {
      action: request.action, status: "running", startedAt, dryRun: request.payload.dryRun,
      transactions: [], deployments: [], upgrades: [], knownContracts: [],
      stage: "编译本次上传源码", progress: 0, nodes: buildJobNodes(request), logs: [],
    };
  }
  await mark("compile", "succeeded", "本次上传源码编译完成");
  await mark("preflight", "running", "核对 RPC、Chain ID 与 Admin 签名权限");
  await flushJournal();
  const { signer, chainId, admin } = await preflight(request);
  journal.chainId = chainId;
  journal.admin = admin;
  await mark("preflight", "succeeded", `网络与签名权限检查通过，Chain ID ${chainId}`);
  await flushJournal();
  if (request.payload.dryRun) {
    const checks = await checkOnly(request, signer, admin);
    const result: EngineResult = { action: request.action, status: "succeeded", chainId, admin, startedAt, completedAt: new Date().toISOString(), dryRun: true, checks, transactions: [] };
    await writeFile(resultPath!, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    journal.status = "succeeded";
    journal.completedAt = result.completedAt;
    for (const node of journal.nodes.filter((item) => item.status === "pending")) {
      updateProgress(journal, node.id, "succeeded", `${node.label}检查通过`);
    }
    await flushJournal();
    return;
  }
  let operation: Pick<EngineResult, "deployments" | "upgrades" | "transactions">;
  if (request.action === "deploy-suite") operation = await deploySuite(request, signer, admin);
  else operation = await upgradeBatch(request, signer, admin);
  const result: EngineResult = {
    action: request.action,
    status: "succeeded",
    chainId,
    admin,
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun: false,
    ...operation,
  };
  await writeFile(resultPath!, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await mark("record", "succeeded", "执行结果已写入本地记录");
  journal.status = "succeeded";
  journal.completedAt = result.completedAt;
  await flushJournal();
}

main().catch(async (error) => {
  if (journal) {
    journal.status = "failed";
    journal.completedAt = new Date().toISOString();
    journal.error = { message: error instanceof Error ? error.message : "部署引擎发生未知错误" };
    const running = journal.nodes.find((node) => node.status === "running") ?? journal.nodes.find((node) => node.status === "pending");
    if (running) updateProgress(journal, running.id, "failed", journal.error.message);
    try { await flushJournal(); } catch { /* Queue preserves the last successfully written journal. */ }
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
