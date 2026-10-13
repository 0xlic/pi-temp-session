# pi-temp-session

为 Pi 创建按本地时间命名的工作目录，并切换到该目录的空白新会话。
适用于 Pi 1.1.0 及以上版本；已在 1.1.0 验证。

## 安装

从 GitHub 全局安装（不加 `--local`）：

```sh
pi install git:github.com/0xlic/pi-temp-session
```

本地开发也可以在本项目目录执行 `pi install .`。

重新启动 Pi；现有 Pi 会话可运行 `/reload` 加载扩展。
只试用一次：

```sh
pi -e /绝对路径/pi-temp-session/index.ts
pi -e /绝对路径/pi-temp-session/index.ts --t
```

## 使用

- `/temp-session`：创建目录并切换到空白会话，原会话历史不复制、不删除。
- `pi --t`：启动后自动创建并切换到临时会话。
- `/temp-session clean`：选择范围并确认，删除临时工作区及其中的会话记录。

无需配置根目录，也没有首次使用向导。工作区固定保存在 Pi agent 目录下的
`temp-sessions`，与默认历史目录 `sessions` 同级：

```text
~/.pi/agent/temp-sessions/YYYY-MM-DD_HH-mm-ss/
```

兼容 Windows，默认位置是：

```text
%USERPROFILE%\.pi\agent\temp-sessions\YYYY-MM-DD_HH-mm-ss\
```

通过 Pi 的 `getAgentDir()` 获取用户目录，使用原生路径拼接，不依赖 Unix 路径。
如果设置了 `PI_CODING_AGENT_DIR`，工作区放在该目录的 `temp-sessions` 下。
时间目录名不含 Windows 禁止的冒号。
旧版的 `temp-session.json` 不再读取或写入，`/temp-session config` 已取消；
旧配置、旧工作区和历史会话不会自动迁移或删除。

日期和时间合并在同一级目录中，历史会话只显示目录名时也能辨认完整时间。
仅新会话使用此格式，已有两级目录和历史会话不会迁移或修改。

原子创建时间目录；同秒已有目录时等待下一秒重新尝试。
同名文件、权限问题等其他错误立即提示。

## 清理

`/temp-session clean` 提供五个范围：最近一天（24小时）、一周（7天）、
一个月（30天）、一年（365天）、所有临时会话。
“最近”指删除该时间段内创建的工作区，不是删除早于该时间段的旧会话；
按目录名中的本地创建时间筛选，不按最后聊天时间。

选择后会显示待删除数量和目录预览，必须再次确认。
删除包含工作区中的**所有文件**以及 `.pi/sessions` 中的会话记录，无法恢复。
取消选择或确认不会删除任何内容。

只清理固定 `temp-sessions` 根目录的直接子目录，并要求目录名是有效的
`YYYY-MM-DD_HH-mm-ss`。无关目录、文件和符号链接不会清理；
当前 Pi 的工作目录或会话记录所在的工作区也会跳过。
无法识别其他 Pi 进程正在使用的工作区，清理前请先关闭相关会话。
旧配置下其他根目录中的工作区不会清理。

## 工作目录和会话

扩展通过公开的 `SessionManager` 创建空白会话，再调用 `switchSession()`。
Pi 会按会话头的工作目录重建工具、系统提示、项目配置及资源加载器；
项目资源仍遵循 Pi 的信任机制。新临时会话的记录保存在工作区内：

```text
~/.pi/agent/temp-sessions/YYYY-MM-DD_HH-mm-ss/.pi/sessions/<会话文件>.jsonl
```

工作区和会话记录可一起管理，删除整个工作区也会删除其中的会话记录。
这相当于为目标工作区指定 `--session-dir <工作区>/.pi/sessions`；
在其中使用 `/new` 创建的会话也沿用此存储目录。
临时会话固定使用此位置，不继承启动 Pi 时指定的其他 `--session-dir`。
已有保存在用户目录中的历史会话不会自动迁移或删除。
这不是只修改 `process.cwd()`，也不会改变启动 Pi 的父 shell 的目录。

为了让 Pi 能打开空白会话，扩展会提前落盘一个仅含会话头的 JSONL 文件；
没有添加伪造的聊天消息。目录和会话不会退出即删除。
自定义存储不一定出现在 Pi 默认的全局历史列表中，可按文件路径恢复：

```sh
pi --session /工作区/.pi/sessions/会话文件.jsonl
```

也可以在工作区内执行 `pi --session-dir .pi/sessions --continue`。

`--t` 当前支持交互终端和 RPC，**不支持 `--print` / JSON 一次性模式**。
这些模式的生命周期不等待延迟的启动命令，无法保证第一条提示在切换后执行，
所以不会冒险在错误目录运行。RPC 客户端应等待“已切换到”通知后发送提示。
`--t` 不能与 `--continue`、`--resume`、`--session`、`--session-id`、
`--fork`、`--no-session` 同时使用；检测到冲突会提示错误并跳过自动创建。
由于 Pi 会捕获扩展错误，此时 Pi 本身可能仍继续运行。

## 测试

```sh
npm test
# 另外运行真实 Pi 的 RPC 测试；使用隔离配置，不访问模型网络
PI_TEMP_INTEGRATION=1 npm test
```

如 `pi` 不在 PATH，可设置 `PI_TEST_CLI=/绝对路径/pi`。
