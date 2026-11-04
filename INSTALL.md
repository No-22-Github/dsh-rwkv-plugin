# 安装

## 桌面版（推荐）

需要 DeepSeek Harness 桌面版 0.2.1 或更新版本。

1. 打开侧栏的**插件**，点**添加插件**，填入：

   ```
   github:No-22-Github/dsh-rwkv-plugin
   ```

   也可以填完整地址 `https://github.com/No-22-Github/dsh-rwkv-plugin.git`。点**安装**，装完后选**立即启用**。

2. 打开**设置 → RWKV**，点**添加模型**，填入：
   - **后端**：`rwkv_lightning CUDA` 或 `iRWKV（vLLM）`
   - **服务地址**：推理服务的地址，填到端口即可，例如 `http://host:8000`
   - **上游模型 ID**：服务端 `/v1/models` 里的 id
   - **Adapter**（仅 lightning）：从列表里选服务器上已有的，或点**上传**传一个本地 `.pth`

   保存后立即生效。

3. 开始使用：
   - **RWKV 当主 Agent**：新会话里模型选刚加的 RWKV 模型，Agent 预设选「RWKV Agent」。
   - **RWKV 当子 Agent**：保持 DeepSeek 主 Agent，它会多一个 `rwkv_agent` 工具，默认用你加的第一个模型。

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

之后的配置和桌面版一样，在**设置 → RWKV** 里完成。

## 开发插件

改插件代码时，可以不安装、直接引用本地目录，改完重启 DSH 即生效：

1. 克隆本仓库，放在 DSH 源码的同级目录，运行 `scripts/link-dsh.sh`（把 DSH 的包软链进来；DSH 不在同级目录时用 `DSH_ROOT=<路径>` 指定）。
2. 把 [dev.cordis.yml](dev.cordis.yml) 里 `- insert:` 那一段复制到 `~/.dsh/profiles/web/cordis.patch.yml`。`rwkv-llm` 行的 `name` 改成本机插件的绝对路径，**必须写成 `file:///…/src/index.ts`**，否则设置页的保存会被拒。
3. 改了 `src/` 后运行 `npm run build`，重新生成 `lib/index.js`（宿主侧）和 `lib/client.js`（设置页）。

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
