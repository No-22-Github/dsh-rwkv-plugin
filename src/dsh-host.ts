// Structural DSH host interfaces shared across `tolerant-edit.ts`,
// `result-budget.ts`, and `line-edit.ts`. Kept free of `@deepseek-ai/*` runtime
// imports so `rwkv-agent-pipeline` plugins can import hooks directly when
// `/opt/dsh-rwkv-plugin/node_modules` is an empty tmpfs inside Docker.

export interface SandboxPolicyLike {
  resolve(request?: { session?: object }): unknown
}

export interface SessionHeaderLike {
  readonly header?: { readonly id?: string }
  requestHeader?(): { config?: { provider?: string } } | undefined
}

export interface AgentLike {
  readonly session?: SessionHeaderLike & object
  readonly options?: { readonly provider?: string }
}

export interface ToolExecLike {
  readonly name: string
  readonly callId?: string
  readonly arguments?: unknown
  readonly parent?: unknown
  readonly agent?: AgentLike
  readonly signal?: AbortSignal
}

export interface WorkingDirectoryServiceLike {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

export function providerOfExec(exec: { readonly agent?: AgentLike }): string | undefined {
  return exec.agent?.session?.requestHeader?.()?.config?.provider ?? exec.agent?.options?.provider
}

export function sessionIdOfExec(exec: { readonly agent?: AgentLike }): string | undefined {
  return exec.agent?.session?.header?.id
}

export async function ensureExecWorkingDir(
  host: { get(name: string): unknown },
  exec: { readonly agent?: unknown; readonly signal?: AbortSignal },
): Promise<string | undefined> {
  const workingDirectory = host.get('workingDirectory') as WorkingDirectoryServiceLike | undefined
  if (exec.agent === undefined || workingDirectory === undefined) return undefined
  return workingDirectory.ensure(exec.agent, exec.signal)
}
