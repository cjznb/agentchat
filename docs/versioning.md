# 版本与更新检查（U1）

> 目标：让用户/运维**看得见**「Hub 与适配器分别是什么版本、有没有新版」，并在需要时**显式**触发一次检查。
> 铁律：**只检查、不升级**——本功能不执行 `git`/`npm`、不写文件、不返回可执行升级动作。

## 1. 版本从哪来

| 对象 | 来源 | 读不到时 |
| --- | --- | --- |
| Hub | 仓库根 `package.json` 的 `version`（进程启动时读一次） | `"unknown"`（不崩） |
| 适配器·内置版 | `adapters/<vendor>/package.json` 的 `version` | `null` |
| 适配器·运行版 | 适配器在 `register` 上报的 `adapter_version` → Hub **进程内注册表**（不建表、不迁移） | `null`（老适配器不带该字段也不报错） |
| commit | env `AGENTCHAT_COMMIT`（CI/打包注入） | 字段缺省 |

- 「落后（outdated）」= 运行版与内置版**都能解析**且 semver 不相等（主/次/补丁或预发布不同）→ `true`；任一侧缺失 → `null`（不知道就不谎报）。
- 检查响应里的 `adaptersOutdated` 是**另一口径**（实测收敛，避免「已是最新」时误报）：
  1. 运行版**落后于本机内置版** → 列入（运行中的适配器旧了，重装/重启即可，与 Hub 版本无关）；
  2. 内置版**落后于最新 tag** 且 **Hub 本身也落后** → 列入（升级 Hub 时一并更新适配器）；
  3. Hub 已是最新（`latest ≤ current`）时，**不**因「适配器版本号与 Hub 不同号」列入——本仓适配器版本独立演进（内置 `0.1.0` / Hub `0.2.0`），否则每次检查都会误报。

## 2. 发版约定（tag）

- tag 形如 `vMAJOR.MINOR.PATCH`（`v0.2.0`）；预发布用 `v0.3.0-rc.1`，semver 语义为 **预发布 < 同号正式版**。
- 仓库当前**不使用 GitHub Release**：检查默认读 `…/tags`；若把数据源配成 `/releases`，Hub 在 404 或空列表时**自动回落**同仓库 `/tags`。
- 适配器版本独立演进（`adapters/<vendor>/package.json`），不强制与 Hub 同号。

## 3. `GET /api/version`（只读、无鉴权）

与 `/api/health` 同级：**不需要** Bearer token。示例：

```json
{
  "ok": true,
  "hub": {
    "name": "agentchat",
    "version": "0.2.0",
    "commit": "abc1234",
    "compareUrl": "https://github.com/cjznb/agentchat"
  },
  "adapters": [
    { "vendor": "dsh", "version": "0.1.0", "bundledVersion": "0.1.0", "outdated": false, "reportedAt": 1762750000000 },
    { "vendor": "opencode", "version": null, "bundledVersion": "0.1.0", "outdated": null, "reportedAt": null }
  ],
  "checkedAt": null
}
```

- `checkedAt`：最近一次**成功**更新检查的时间；从未检查过 → `null`。
- 厂商集合 = 配置厂商（`config.adapters`）∪ 注册表里已上报的厂商（排序去重）。

## 4. `POST /api/version/check`（显式触发）

**没有后台轮询**：只在用户点「检查更新」或 CLI `--check-update` 时出网一次；结果内存缓存 **10 分钟**（同数据源）。

成功：

```json
{
  "ok": true,
  "current": "0.2.0",
  "latest": "0.3.0",
  "updateAvailable": true,
  "adaptersOutdated": ["dsh"],
  "tagsChecked": 3,
  "source": "https://api.github.com/repos/cjznb/agentchat/tags",
  "checkedAt": 1762750000000,
  "cached": false,
  "compareUrl": "https://github.com/cjznb/agentchat/compare/v0.2.0...v0.3.0"
}
```

失败一律 **HTTP 200 + `{ok:false,error,detail?,current,source,checkedAt}`**（客户端按 body 判定，**绝不 500**）：

| `error` | 触发 | 含义 |
| --- | --- | --- |
| `invalid_url` | 数据源不是 `https`（含写错的 URL） | 直接拒绝，**不出网** |
| `network` | DNS/连接/其它 fetch 异常 | 网络不可用 |
| `timeout` | 超过 5s（`AbortSignal.timeout`） | 远端太慢 |
| `too_large` | 响应体超过 512KB | 防御异常/巨大响应 |
| `http_error` | 非 2xx（`releases` 回落失败后） | 远端返回错误码 |
| `no_tags` | 列表为空或没有可解析的 semver tag | 仓库还没有 tag / 解析不到 |

### 数据源优先级

1. 显式注入（测试用）；
2. env `AGENTCHAT_UPDATE_URL`；
3. `<home>/config.json`：

```json
{ "updateCheck": { "url": "https://api.github.com/repos/<owner>/<repo>/tags" } }
```

4. 缺省 `https://api.github.com/repos/cjznb/agentchat/tags`。

fork / 私有镜像 / 企业代理都通过 1–3 换源；Hub **只读** `config.json`，绝不创建或改写它。

### 安全与隐私

- 数据源**必须 https**；5s 超时；响应体分段读取并封顶（512KB），不会把整个响应吃进内存。
- 只在**显式触发**时出网；不发送任何本机/会话数据（仅 GET tags 列表，带固定 `user-agent`）。
- `cached: true` 表示这次没有出网（命中 10 分钟缓存）。
- 不执行任何 `git`/`npm` 命令、不落盘、不返回升级动作——升级永远是**手动**的。

## 5. CLI

```bash
node bin/agentchat.mjs --check-update
# 或安装后
agentchat --check-update
```

- 需要**运行中的 Hub**：CLI 只是调用它的 `/api/version/check`（避免第二份 semver/tag 解析）。
  基址解析：`AGENTCHAT_URL` > `--port` / `AGENTCHAT_PORT` > `<home>/config.json` 的 `port` > `4646`。
- **退出码**：`0` 已最新、`1` 有更新、`2` 检查失败（Hub 不可达、非 2xx）。
- 输出示例（有更新）：

```
AgentChat 更新检查
  当前版本   0.2.0
  最新版本   0.3.0
  更新可用   是
  检查来源   https://api.github.com/repos/cjznb/agentchat/tags（共 3 个 tag）
  比较链接   https://github.com/cjznb/agentchat/compare/v0.2.0...v0.3.0
  适配器     dsh
手动升级（本命令不会自动执行）：
  git pull --ff-only
  npm install
  npm run build
  重启 Hub：agentchat
```

- 失败示例（Hub 未运行）：stderr 打印「无法连接 Hub（http://127.0.0.1:4646）」+ 启动指引，退出码 `2`。

## 6. 设置页接线（`agentchat-ui`，task-15）

卡片只需两个请求 + 一个按钮：

1. 进入设置页 → `GET /api/version` 渲染「Hub 版本 / 各适配器版本（内置 vs 运行）+ 是否落后」；
2. 用户点「检查更新」→ `POST /api/version/check`：
   - `ok:true` → 显示 `current`、`latest`、`updateAvailable`、`adaptersOutdated`，链接用 `compareUrl`；
   - `ok:false` → 按 `error` 给文案（`no_tags`=「仓库还没有发布 tag」，`network`/`timeout`=「网络不可用，可稍后重试」，`invalid_url`=「更新源配置不是 https」）；
3. **不要**在 UI 里提供「一键升级」按钮：本功能没有升级动作。

## 7. 局限与未做

- 适配器**运行版本上报**落在 `register` 的 `adapter_version`（additive）：Hub 侧注册表已就绪
  （`recordAdapterVersion`），接线由 task-14/P7 落地；在此之前 `version` 恒为 `null`、`outdated` 恒为 `null`。
- 不做后台轮询、不做「有新版本」角标推送；检查只在你点/敲命令时发生。
- 不自动升级、不下载、不校验签名；升级步骤以文本提示给出，由人执行。
- tag 列表只取 GitHub 风格的 `tag_name`/`name` 字段；不递归读取仓库内容，因此**无法**知道「某个 tag 里适配器是什么版本」，`adaptersOutdated` 用「本地内置/运行版 < 最新 tag」做代理判断。
