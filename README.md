# 合约部署控制台

独立运行的 UUPS 部署与升级工具，只连接页面填写的现有 EVM RPC。项目不启动、不附带本地区块链，也不预置 RPC、Chain ID 或 Admin。

## 启动控制台

要求 Node.js 20.11 或更高版本。首次构建：

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

完整目录已包含依赖和构建结果。Windows 安装 Node.js 20 或 22 x64 后，直接双击 `启动控制台.cmd`，无需联网安装任何包。页面地址为 `http://127.0.0.1:4174`；该端口只承载操作页面和 API，不是区块链节点。

项目固定使用随包提供的 Solidity 0.8.24 编译器，不依赖目标机器的 Hardhat 缓存，也不会下载编译器。

如果 Besu 已解锁 Admin 账户，不需要私钥；否则只在本机 `.env` 中设置 `CONTRACT_CONSOLE_PRIVATE_KEY`。私钥不会进入页面、请求、部署记录或日志。

## 工作流

- **升级合约（默认）**：上传新源码，逐个检查 UUPS 代理、角色权限和存储布局，再串行升级；任一项失败立即停止。
- **部署整套合约**：先在页面一次上传三个主合约及它们引用的全部本地 Solidity 依赖；文件清单和主合约识别结果会在发送任务前完整展示。随后固定执行 Payment 实现与代理、Lifecycle 实现与代理、Contacts 实现与代理、Payment 授权 Lifecycle，共 7 笔交易。每一步等待成功回执并复核链上状态。

工具不附带任何业务合约源码。部署和升级时都必须上传目标合约及其全部本地 Solidity 依赖，并保留原有相对目录结构；源码不完整会在编译、检查阶段直接停止。

页面中的“上传源码存储目录”可指定源码集落盘位置。留空时使用工具目录内的 `.runtime/source-sets/`；Windows 可填写如 `D:\ContractSources` 的绝对路径。编译暂存仍由工具自动管理，切换电脑后重新上传源码即可。

## 强制安全关卡

- RPC 返回的 Chain ID 必须与页面一致；Admin 必须能由环境私钥签名或已在 Besu 解锁。
- 只接受 ERC1967/UUPS 代理，拒绝实现地址、空地址和没有代码的地址。
- Payment 要求 `DEFAULT_ADMIN_ROLE`；Lifecycle、Contacts 要求 `ADMIN_ROLE` 或 `SUPER_ADMIN_ROLE`。
- OpenZeppelin 校验升级安全和存储布局，项目没有跳过存储检查的选项。
- 交易必须取得 `status=1` 回执；升级后代理地址不变，且实现槽必须更新为新实现。
- 任务严格串行，记录保存在 `data/records/`，OpenZeppelin 网络清单保存在 `.openzeppelin/`。两者应随项目目录一起备份。

如果待部署合约的运行时代码超过 EIP-170 的 24,576 字节上限，工具默认阻止执行。只有确认目标 Besu 已放宽合约大小限制后，才可在 `.env` 设置：

```bash
CONTRACT_CONSOLE_ALLOW_OVERSIZED_CONTRACTS=true
```

本工具会最大限度阻止已知错误，但区块链交易无法承诺绝对零风险。正式操作前应备份 `data/` 与 `.openzeppelin/`，先使用页面网络检查，并确认目标代理、角色和 Besu 配置。

已知边界：OpenZeppelin 在创建代理前会先部署实现合约。如果实现部署已经成功、但代理初始化随即失败，链上可能留下一个未被代理引用的实现合约并消耗 gas；它不会改变任何现有代理或业务数据。
