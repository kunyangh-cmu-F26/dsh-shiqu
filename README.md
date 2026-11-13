# DSH 拾趣

拾趣根据记忆宫殿和指定聊天里的兴趣，后台找资料，把有来源、可复用的知识存回记忆宫殿。适合把正在学的技能和正在维护的项目慢慢积成一份可搜索的知识库。

## 安装

拾趣 **0.1.2** 已在 DSH **0.2.1-rc.3** 和 **0.2.2-rc.1** 的 Desktop profile 中使用 Desktop 转发代码验证保存设置、手动研究和写入 [记忆宫殿 dsh-engram **0.13.10**](https://github.com/kenz1117/dsh-engram)。运行环境要求 Node.js 24.9 或以上。面板可从本机 Desktop 或 Web 打开。

把拾趣和 Engram 安装到同一个 profile。Desktop 用户用应用菜单里的「管理 dsh 命令」注册 Desktop 内置命令，完全退出 Desktop 后，在安装包所在的目录执行：

```sh
dsh plugin --profile desktop add ./dsh-shiqu-0.1.2.tgz
```

没有记忆宫殿时，在同一 profile 安装 `@kenz1117/dsh-engram@0.13.10`。单独启动 DSH Web 的用户用以下命令：

```sh
dsh plugin --profile web add @kenz1117/dsh-engram@0.13.10
dsh plugin --profile web add ./dsh-shiqu-0.1.2.tgz
```

重启 DSH，进入 **设置 → 拾趣**。如果 Engram 初装报 `ERR_PNPM_IGNORED_BUILDS`，请按 [Engram 的安装说明](https://github.com/kenz1117/dsh-engram#readme) 处理该依赖的安装授权，再重试。若命令安装过文件但因故未激活插件，请在 DSH 插件管理中检查并启用已安装项。拾趣自己的 npm 包没有安装脚本。

1. 勾选允许读取的聊天会话。建议先在一个目标会话完成一轮真人对话。
2. 确认 DSH 已配置可用模型。拾趣默认使用所选会话最近一次模型路由。也可以在面板填入提供商和模型 ID，使用专门的后台模型。
3. 设置每日兜底时间和时区。默认是本机时区的 17:00。比如湾区可填 `America/Los_Angeles`。
4. 保留网页搜索，或添加 GitHub Releases（`owner/repo`）和 RSS/Atom（完整公开网址）。网页搜索沿用 DSH 已配置的搜索提供商及其凭据。
5. 保存后点「立即研究一轮」。确认收录记录符合预期，再开启自动研究。手动运行也使用当天额度。

卸载时使用安装时的 profile，比如 Desktop 用 `dsh plugin --profile desktop remove dsh-shiqu`。本地收录历史和 Engram 已入库条目可分别保留和管理。

## 研究与收录

- **兴趣来源**是 Engram 手工画像、用户库里的活跃偏好，以及指定会话近 14 天里尚未处理的真人文本。插件按约 3 分钟的周期检查选中会话。提取兴趣时，限长并做常见凭据脱敏的片段会交给所配置的模型。网页搜索只会收到生成后的主题查询。
- **研究时机**优先响应新兴趣线索。当天没有触发时，兜底时间到了再从长期兴趣里选主题。每个本地日最多一轮，每轮可网页搜索并读取订阅。运行中的日额度与会话进度会落盘。
- **探索方向**在已知兴趣内轮换，默认每五天有一次探索相邻主题的机会，能在设置里关掉。反馈按钮作用于后续选题，「有用」提高方向优先级，「少找这类」降低优先级。
- **收录内容**以长期有用的文档、教程、实测和案例为主，也收录对当前主题有明确影响的近 30 天更新。每轮最多新增 3 条，保留来源、收录日期和能识别的发布日期。看到「入库冲突」时，可以用记录里的来源在 Engram 中核对。
- **内容审查**记录触发的阶段。资料来源被拦截时，该来源结束处理。选题或筛选模型被拦截时，该轮结束，相同资料组合会在接下来 90 天跳过模型请求。
- **连接故障**会记录失败阶段。临时入库失败的条目会保留为待写入，后续符合运行条件时用同一个 ID 再确认。已入库内容按来源 URL 去掉常见追踪参数后去重。

### 与记忆宫殿联动

拾趣从 Engram 的本机面板接口读取用户画像和活跃偏好，通过 Engram 的导入接口把有来源的摘要写入 **共享宫殿**，类型为方法或事实。条目带有 `[拾趣｜外部知识]` 标记和稳定 ID。共享宫殿可供本机已配置 Engram 的 agent 读取，适合存公开资料。个人画像和聊天只用于选题。拾趣本身把配置、运行状态、会话游标和收录反馈存放在 `$DSH_HOME/shiqu/knowledge.sqlite`（通常是 `~/.dsh/shiqu/`）。

出现 `ENGRAM_HTTP_404` 或 `ENGRAM_BAD_RESPONSE` 时，可以检查 Engram 是否装在同一个 profile、记忆宫殿面板是否能打开，以及版本是否在验证组合内。出于本机部署边界，拾趣要求 DSH Web 绑定回环地址，例如 `127.0.0.1`。

### 与主动搭话联动

使用 [dsh-speak-up](https://github.com/Yuuyuko-uu/dsh-speak-up#readme) 时，确保目标会话能调用 `engram_search` 和 `engram_assess`。可以先在该会话让 agent 搜索一条你刚收录过的主题，确认它能从 `scope: "shared"` 搜到对应条目。

在 **设置 → 主动搭话 → 触发文案** 中，按你的伴侣口吻加上这一段：

> 感觉可以聊两句。要是最近有聊到具体兴趣，可以用 engram_search 从共享宫殿找一条相关的外部知识，用 engram_assess 核对检索结果。真的有意思、也没聊过的话，就分享一个要点和来源。平时可以沿着聊过的话题自然接一句。

Speak Up 的骰子、安静时段和冷却仍按它自己的设置运行。是否检索、使用哪条资料由这轮会话决定。拾趣在后台整理资料，不触发搭话。日常聊天同样可以按需查共享宫殿。

## 开发与发布

```sh
npm ci
npm test
npm pack
```

`package.json` 和 `cordis.patch.yml` 分别定义 npm 包与 DSH 插件。手工安装文件是 `dsh-shiqu-0.1.2.tgz`。如果发布时使用自己的 npm scope，需同时更新 `package.json` 的包名、`cordis.patch.yml` 中插件行的 `name`，以及 `src/client.js` 注册的浏览器模块 ID。独立的设置页和数据目录仍使用 `dsh-shiqu` / `shiqu`。

可将源代码放进新 GitHub 仓库，添加 `dsh-plugin` 和 `deepseek-harness` topics，再发带 tarball 的 GitHub Release。拥有发布命名空间后，也可运行 `npm publish --access public`。发布前确认仓库里只有源码、文档和测试。

拾趣是独立实现。最初的需求来自使用 [dsh-heartbeat](https://github.com/Kanadego/dsh-heartbeat) 时对个性化资料发现的需求。拾趣通过 DSH 提供的模型、网页和会话服务工作，通过 Engram 对外接口保存和召回资料。
