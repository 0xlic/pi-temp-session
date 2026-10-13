import { basename, join } from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type InputEvent } from "@earendil-works/pi-coding-agent";
import { cleanupRanges, createDirectory, executeCleanup, materializeSession, planCleanup, startupConflict, validateRoot } from "./lib.mjs";

export default function tempSession(pi: ExtensionAPI) {
  const root = join(getAgentDir(), "temp-sessions");
  let busy = false;
  let startupPending = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingInputs: InputEvent[] = [];

  pi.registerFlag("t", {
    description: "Create a timestamped directory and start a new temporary session",
    type: "boolean",
    default: false,
  });

  async function clean(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) throw new Error("清理需要交互界面，请运行 /temp-session clean。");
    const selected = await ctx.ui.select("清理哪些临时会话？（按工作区创建时间）", cleanupRanges.map((range) => range.label));
    if (selected === undefined) return;
    const range = cleanupRanges.find((range) => range.label === selected);
    if (!range) return;
    const plan = await planCleanup(root, {
      days: range.days,
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
    const skipped = plan.skippedActive ? `当前会话所在的 ${plan.skippedActive} 个工作区已跳过。` : "";
    if (!plan.directories.length) {
      ctx.ui.notify(`没有可清理的临时会话。${skipped}`, "info");
      return;
    }
    const preview = plan.directories.slice(0, 10).map((directory) => basename(directory.path)).join("\n");
    const more = plan.directories.length > 10 ? `\n……另有 ${plan.directories.length - 10} 个` : "";
    const confirmed = await ctx.ui.confirm("确认删除临时会话？", [
      `范围：${range.label}；共 ${plan.directories.length} 个工作区。`,
      `根目录：${root}`, preview + more, skipped,
      "工作区所有文件及其中的会话记录将永久删除，不可恢复。",
      "无法检测其他 Pi 进程是否正在使用这些工作区，请先关闭相关会话。",
    ].filter(Boolean).join("\n"));
    if (!confirmed) {
      ctx.ui.notify("已取消清理。", "info");
      return;
    }
    const result = await executeCleanup(plan);
    ctx.ui.notify(`已清理 ${result.deleted} 个临时工作区。${skipped}`, "info");
    if (result.failures.length) {
      ctx.ui.notify(`有 ${result.failures.length} 个目录未能清理：\n${result.failures.map((failure) => `${failure.path}: ${failure.error}`).join("\n")}`, "warning");
    }
  }

  async function run(args: string, ctx: ExtensionCommandContext) {
    if (busy) {
      ctx.ui.notify("Temp Session 操作正在进行。", "warning");
      return;
    }
    const command = args.trim();
    if (command && command !== "clean") {
      ctx.ui.notify(`无需配置根目录，固定使用 ${root}。用法：/temp-session 或 /temp-session clean`, "error");
      return;
    }
    busy = true;
    let directory: string | undefined;
    let sessionFile: string | undefined;
    let sessionDir: string | undefined;
    let switched = false;
    let replacementStarted = false;
    // Keep the notifier only for pre-replacement errors. Once switched, use the
    // fresh context in withSession; the original ctx and pi become invalid.
    try {
      await ctx.waitForIdle();
      if (command === "clean") {
        await clean(ctx);
        return;
      }
      await validateRoot(root);
      directory = await createDirectory(root);
      sessionDir = join(directory, ".pi", "sessions");
      sessionFile = await materializeSession(SessionManager.create(directory, sessionDir));
      const target = directory;
      replacementStarted = true;
      const result = await ctx.switchSession(sessionFile, {
        withSession: async (fresh) => {
          switched = true;
          startupPending = false;
          fresh.ui.notify(`已切换到：${target}`, "info");
          for (const input of pendingInputs.splice(0)) {
            const content = [{ type: "text" as const, text: input.text }, ...(input.images ?? [])];
            await fresh.sendUserMessage(content, { expandPromptTemplates: true });
          }
        },
      });
      if (result.cancelled) {
        replacementStarted = false;
        ctx.ui.notify("已取消切换，保留原会话。", "info");
      }
    } catch (error) {
      // Runtime construction can fail after invalidating the old session. Do
      // not touch its ctx or remove the target file in that case.
      if (replacementStarted) throw error;
      ctx.ui.notify(`Temp Session 失败：${String(error)}`, "error");
    } finally {
      if (!switched && !replacementStarted) {
        if (sessionFile) await rm(sessionFile, { force: true });
        // Never recursively delete a working directory, even on failure.
        if (sessionDir) await rmdir(sessionDir).catch(() => {});
        if (directory) {
          await rmdir(join(directory, ".pi")).catch(() => {});
          await rmdir(directory).catch(() => {});
        }
      }
      if (startupPending && !switched) {
        startupPending = false;
        pendingInputs.length = 0;
      }
      busy = false;
    }
  }

  pi.registerCommand("temp-session", {
    description: "Create a temporary session; clean: delete temporary workspaces and history",
    getArgumentCompletions: (prefix) => "clean".startsWith(prefix) ? [{ value: "clean", label: "clean — 清理临时会话" }] : null,
    handler: run,
  });

  pi.on("input", (event, ctx) => {
    if (!startupPending) return;
    pendingInputs.push(event);
    ctx.ui.notify("正在创建临时会话，输入将在切换后执行。", "info");
    return { action: "handled" };
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || !pi.getFlag("t")) return;
    const conflict = startupConflict(process.argv.slice(2));
    if (conflict) throw new Error(`--t 不能与 ${conflict} 同时使用。`);
    // Session replacement is command-only. Dispatch after session_start returns,
    // not while Pi is awaiting lifecycle handlers during runtime initialization.
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
      throw new Error("--t 当前支持交互模式和 RPC 模式，不支持 --print / JSON 模式。");
    }
    startupPending = true;
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      pi.sendUserMessage("/temp-session", { expandPromptTemplates: true });
    }, 0);
  });

  pi.on("session_shutdown", () => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
  });
}
