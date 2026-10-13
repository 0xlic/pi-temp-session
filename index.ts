import { join } from "node:path";
import { rm, rmdir } from "node:fs/promises";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type InputEvent } from "@earendil-works/pi-coding-agent";
import { createDirectory, loadConfig, materializeSession, normalizeRoot, saveConfig, startupConflict, validateRoot } from "./lib.mjs";

export default function tempSession(pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), "temp-session.json");
  let busy = false;
  let startupPending = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingInputs: InputEvent[] = [];

  pi.registerFlag("t", {
    description: "Create a timestamped directory and start a new temporary session",
    type: "boolean",
    default: false,
  });

  async function configure(ctx: ExtensionContext): Promise<string | undefined> {
    if (!ctx.hasUI) throw new Error("请先在交互模式运行 /temp-session config 配置根目录。");
    while (true) {
      const input = await ctx.ui.input("Temp Session：输入根目录（必填；Esc 取消）");
      if (input === undefined) {
        ctx.ui.notify("已取消配置，保留原会话。", "info");
        return undefined;
      }
      try {
        const root = normalizeRoot(input, ctx.cwd);
        await validateRoot(root);
        await saveConfig(configPath, root);
        ctx.ui.notify(`根目录已保存：${root}`, "info");
        return root;
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    }
  }

  async function run(args: string, ctx: ExtensionCommandContext) {
    if (busy) {
      ctx.ui.notify("Temp Session 操作正在进行。", "warning");
      return;
    }
    const command = args.trim();
    if (command && command !== "config") {
      ctx.ui.notify("用法：/temp-session 或 /temp-session config", "error");
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
      if (command === "config") {
        await configure(ctx);
        return;
      }
      await ctx.waitForIdle();
      let root: string | undefined;
      try { root = (await loadConfig(configPath))?.root; }
      catch (error) {
        ctx.ui.notify(`无法读取配置：${String(error)}`, "error");
        return;
      }
      root ??= await configure(ctx);
      if (!root) return;
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
    description: "Create and switch to a temporary session; config: change root directory",
    getArgumentCompletions: (prefix) => "config".startsWith(prefix) ? [{ value: "config", label: "config — 配置根目录" }] : null,
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
