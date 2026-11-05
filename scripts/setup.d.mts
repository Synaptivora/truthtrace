/** scripts/setup.mjs 的类型声明：让 Next 的 route.ts 能以静态 import 方式复用它。 */

export interface SetupChecks {
  runtime: boolean;
  dws: {
    installed: boolean;
    version: string;
    authenticated: boolean;
    token_valid: boolean;
    expires_at: string;
    user: string;
    ok: boolean;
  };
  python: { version: string; ok: boolean; missing: string[] };
  wam: { found: boolean; path: string; patched: boolean; localZips: string[] };
  keyCache: { path: string; exists: boolean; accounts: number };
  envLocal: { exists: boolean; ingestion: string; wamSrc: string };
}

export interface SetupManual {
  id: "login-dingtalk" | "capture-wechat-key";
  label: string;
  why: string;
}

export interface SetupDetect {
  platform: string;
  node: string;
  checks: SetupChecks;
  ready: boolean;
  manual: SetupManual[];
}

export interface SetupStep {
  id: string;
  label: string;
  status: "pending" | "running" | "ok" | "skipped" | "warn" | "failed";
  detail: string;
  index?: number;
  log?: string;
}

export interface SetupReport {
  status: "ok" | "failed";
  steps: SetupStep[];
  lines: string[];
  before: SetupDetect;
  after: SetupDetect;
}

export interface ActionResult {
  ok: boolean;
  output: string;
  note: string;
}

export function detect(): Promise<SetupDetect>;
export function toolEnvironment(extra?: Record<string,string>): NodeJS.ProcessEnv;
export function readEnvLocal(): Record<string, string>;
export function writeEnvLocal(
  updates: Record<string, string>,
): { path: string; added: string[]; existed: boolean };
export function runSetup(onStep?: (step: SetupStep) => void): Promise<SetupReport>;
export function actionDingtalkLogin(onLine?: (line: string) => void): Promise<ActionResult>;
export function actionCaptureWechatKey(onLine?: (line: string) => void): Promise<ActionResult>;
