# 安装

## 桌面版（推荐）

需要 DeepSeek Harness 桌面版 0.2.1 或更新版本。

1. 打开侧栏的**插件**，点**添加插件**，填入：

   ```
   github:No-22-Github/dsh-rwkv-plugin
   ```

   也可以填完整地址 `https://github.com/No-22-Github/dsh-rwkv-plugin.git`。点**安装**，装完后选**立即启用**。

2. 打开**设置 → RWKV Agent**，点**添加模型**，填入：
   - **后端**：`rwkv_lightning CUDA` 或 `iRWKV（vLLM）`
   - **服务地址**：推理服务的地址，填到端口即可，例如 `http://host:8000`
   - **上游模型 ID**：服务端 `/v1/models` 里的 id
   - **Adapter**（仅 lightning，可选）：从列表里选服务器上已有的，或点**上传**传一个本地 `.pth`；不挂就用合并权重

   保存后立即生效。

3. 开始使用：
   - **RWKV 当主 Agent**：新会话里模型选刚加的 RWKV 模型，Agent 预设选「RWKV Agent」。
   - **RWKV 当子 Agent**：保持 DeepSeek 主 Agent，它会多一个 `rwkv_agent` 工具，默认用你加的第一个模型。

   编辑默认走行号版 `edit_lines`（按 read 显示的行号改，不抄原文），原生 `edit` 在这两个入口里自动隐藏；要做 A/B、退回原生编辑时用 headless / 管线采集的 `--native-edit`。

更新插件：在**添加插件**里重新填一次同样的地址并安装。

## 从 DSH 源码运行

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
```

```bash
cd deepseek-harness && pnpm install && pnpm run build
```

```bash
cd deepseek-harness && pnpm dsh plugin --profile web add github:No-22-Github/dsh-rwkv-plugin
```

```bash
cd deepseek-harness && pnpm dsh web
```

之后的配置和桌面版一样，在**设置 → RWKV Agent** 里完成。

## 开发插件

开发时也用插件包的方式加载，和桌面版走同一条路：预设、`rwkv_agent` 工具都来自仓库里的 [cordis.patch.yml](cordis.patch.yml)，不用再往配置里手抄。

1. 克隆本仓库，放在 DSH 源码的同级目录，运行 `scripts/link-dsh.sh`（把 DSH 的包软链进来；DSH 不在同级目录时用 `DSH_ROOT=<路径>` 指定）。
2. 在 DSH 源码目录里，把本地仓库链接到要用的配置（这里是 web）：

   ```bash
   pnpm dsh plugin --profile web add link:/绝对路径/dsh-rwkv-plugin
   ```

   这一步会把插件加进该配置的 `package.json`（依赖和 bundles）。之后在**设置 → RWKV Agent** 里添加模型，保存会写进 `~/.dsh/profiles/web/cordis.patch.yml` 里 `name: dsh-rwkv-plugin` 的那一行。
3. 改了 `src/` 后运行 `npm run build`，重新生成 `lib/index.js`（宿主侧）和 `lib/client.js`（设置页和 RWKV 标签页），再重启 DSH。DSH 加载的是 `lib/`，不是 `src/`。

不经过 DSH 的检查：

```bash
npm test
```

```bash
node scripts/smoke.ts irwkv http://<host>:<port> <model-id>
```

```bash
node scripts/smoke.ts lightning http://<host>:<port> <model-id> --adapter <adapter-id>
```

`smoke.ts` 自己扮演 DSH 的外层循环，用临时目录里的假文件工具跑一道多步任务。
