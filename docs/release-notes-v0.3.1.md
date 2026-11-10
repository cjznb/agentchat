# v0.3.1 · 补丁版（更新日志与升级说明）

> 完整对比：https://github.com/cjznb/agentchat/compare/v0.3.0...v0.3.1
> **建议所有 0.3.0 用户升级**；升级步骤与 v0.3.0 相同（见 v0.3.0 发布说明的「更新须知（必须做的事）」）。
## [0.3.1] - 2026-11-10

> 补丁版：**建议所有 0.3.0 用户升级**（含 Linux 宿主上的一个真实命名缺陷）。升级步骤与 `v0.3.0`
> 相同，见下方 0.3.0 的「更新须知（必须做的事）」。

### 修复

- **DSH 会话节点名跨平台取 basename（修 ubuntu CI 自该用例落地起全红）**：`adapters/dsh/lib/session-hint.js` 原先用 `node:path` 的 `basename()` 从会话头 `cwd` 取目录名，而 **POSIX 上反斜杠不是分隔符** —— `basename("C:\work\proj-sess-1")` 会**整串返回**，节点名因此变成一整条 Windows 路径（如 `C:\work\proj-sess-1-243b8c`），既不可读也影响展示名唯一性。现改用新增并导出的 `basenameAny()`（同时认 `\` 与 `/`，支持混合分隔符、尾随分隔符与空值回退），`sessionName()` 不再依赖 `node:path`。
- **回归测试跨平台化**：`adapters/dsh/__tests__/naming.test.ts` 新增 Windows 反斜杠 / POSIX / 混合 / 尾随 / 空值 / 端到端节点名用例——此前这类「本机 Windows 绿、Linux CI 红」的失败在本地发现不了，现在能被拦住。
- **CI 恢复绿灯**：GitHub Actions（ubuntu-latest，Node 22 与 24 双腿）由 `failure` → `success`；本次之前的所有运行（含 v0.2.0 发布）均为 failure，根因即上述命名缺陷。

