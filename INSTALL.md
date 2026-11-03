# 安装

插件目前从 DSH 源码运行。下面假设两个仓库放在同一目录下：

```
Projects/
├── deepseek-harness/   # DSH 源码
└── dsh-rwkv-plugin/    # 本插件
```

## 1. 构建 DSH

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
```

```bash
cd deepseek-harness && pnpm install && pnpm run build
```

需要 Node ≥ 24.9。

## 2. 准备插件

```bash
git clone https://github.com/No-22-Github/dsh-rwkv-plugin.git
```

```bash
dsh-rwkv-plugin/scripts/link-dsh.sh
```

`link-dsh.sh` 把插件要用的 DSH 包软链到插件的 `node_modules`，保证和 DSH 用的是同一份代码。DSH 不在同级目录时，用 `DSH_ROOT=<路径>` 指定。

设置页的打包产物 `lib/client.js` 已经提交在仓库里，改了 `src/client/` 才需要重新打包：

```bash
cd dsh-rwkv-plugin && npm run build
```

## 3. 加进 profile

把 [dev.cordis.yml](dev.cordis.yml) 里 `- insert:` 那一段复制到 `~/.dsh/profiles/web/cordis.patch.yml`（文件原本是 `[]` 的话，整个换掉），然后改两处：

- `rwkv-llm` 行的 `name` 改成你本机插件的绝对路径，**必须写成 `file:///` 形式**，例如 `file:///Users/you/Projects/dsh-rwkv-plugin/src/index.ts`。写成普通路径的话，设置页的每次保存都会被拒。
- `models` 改成你自己的端点。之后也可以在设置页里改。

不要用 `--patch dev.cordis.yml` 的方式长期运行：设置页的保存写在 profile patch 里，`--patch` 的优先级更高，会把保存的值盖掉。

## 4. 启动

```bash
cd deepseek-harness && pnpm dsh web
```

- **RWKV 当主 Agent**：模型选「RWKV · …」，Agent 预设选「RWKV」。
- **RWKV 当子 Agent**：保持 DeepSeek 主 Agent，它会多一个 `rwkv_agent` 工具；子 Agent 用的模型在 `tool-rwkv-agent` 行的 `agentOptions.model` 里指定。
- **设置 → RWKV**：增删模型、选用或上传 adapter、调采样和步数。

## 不经过 DSH 的检查

```bash
cd dsh-rwkv-plugin && npm test
```

```bash
cd dsh-rwkv-plugin && node scripts/smoke.ts irwkv http://<host>:<port> <model-id>
```

```bash
cd dsh-rwkv-plugin && node scripts/smoke.ts lightning http://<host>:<port> <model-id> --adapter <adapter-id> --empty-think
```

`smoke.ts` 自己扮演 DSH 的外层循环，用临时目录里的假文件工具跑一道多步任务。管理服务器上的 adapter：

```bash
cd dsh-rwkv-plugin && node scripts/adapter.ts list http://<host>:<port>
```
