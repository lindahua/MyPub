import { spawn } from "node:child_process";
import { MyPubError } from "../core/errors.js";

export interface ProcessResult { stdout: string; stderr: string; code: number; }
export function run(executable: string, args: string[], cwd: string, allowFailure = false): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => reject(new MyPubError(`Cannot run ${executable}: ${error.message}`, "PROCESS_FAILED")));
    child.on("close", (code) => { const result = { stdout, stderr, code: code ?? 1 }; if (result.code !== 0 && !allowFailure) reject(new MyPubError(`${executable} ${args[0] ?? ""} failed: ${stderr.trim() || stdout.trim()}`, "PROCESS_FAILED", result)); else resolve(result); });
  });
}
