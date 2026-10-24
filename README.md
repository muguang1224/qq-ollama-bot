# QQ 本地模型机器人

用**本地大模型**驱动的 QQ 聊天机器人。不需要云端 API、不需要 API Key、不花一分钱。

```
QQ 客户端  ←→  NapCat (OneBot v11)  ←→  本项目  ←→  Ollama (本地模型)
```

基于 [Ollama](https://ollama.com/) 跑推理，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 收发 QQ 消息。

---

## 特性

| 功能 | 说明 |
| --- | --- |
| **完全本地** | 模型跑在你自己电脑上，聊天内容不出本机 |
| **看到图片** | 收到图片/表情包会用视觉模型"看"内容，理解对方发了什么 |
| **情绪系统** | 心情 / 亲密度 / 精力三个值，会真的影响说话语气（心情差就敷衍你） |
| **长期记忆** | 记得你说过什么，重启不失忆 |
| **人设进化** | 每聊几轮，自动提炼对这个人的了解，态度从陌生到熟络 |
| **标点学习** | 统计对方的说话习惯（爱用逗号还是句号），跟着模仿 |
| **表情包自动收集** | 别人发的表情自动存进素材库，按情绪和场合挑选发送 |
| **主动聊天** | 可开启，让它偶尔主动找你说话（带多重防打扰机制） |
| **自动加好友** | 可开启，按关键词或白名单自动通过好友申请 |

---

## 快速开始

### 前置要求

- **Node.js** v20 或更新 —— <https://nodejs.org/>
- **Ollama** —— <https://ollama.com/download>
- **NapCat** —— <https://github.com/NapNeko/NapCatQQ/releases>
- 一个**不常用的小号 QQ**（建议，避免和你的主号混在一起）

### 第一步：安装

```bash
git clone https://github.com/muguang1224/qq-ollama-bot.git
cd qq-ollama-bot
node 安装.mjs
```

或者在 Windows 上直接**双击 `安装.bat`**。

安装脚本会自动：
1. 检查 Node 和 Ollama
2. 拉取所需模型（聊天 2.7 GB + 视觉 3.2 GB）
3. 生成 `config.json`
4. 建好数据目录

### 第二步：装 NapCat 并登录

1. 从 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.Windows.OneKey.zip`
2. 解压，运行 `NapCatInstaller.exe`
3. 启动 NapCat，用小号扫码登录

> **提示**：NapCat 一键安装器会下载一个 36 MB 的包。如果你在国内网络下失败，
> 见下方「常见问题」。

### 第三步：配置 OneBot 连接

NapCat 启动后，浏览器打开 `http://127.0.0.1:6099`（token 看启动日志）：

1. 进「网络配置」
2. 新建 **WebSocket 客户端**（正向 WS）
3. 地址填 `ws://127.0.0.1:3001`
4. 保存并启用

### 第四步：启动

双击 **`启动.bat`**，或者：

```bash
node src/bridge.mjs
```

看到 `已连接。等待 NapCat 推送消息…` 就说明成功了。

**现在用你的主号给小号发条消息试试。**

---

## 配置说明

所有配置在 `config.json`。改完**重启桥接**生效。

### 最常改的几项

```jsonc
{
  "bot": {
    "name": "小助手",
    "adminQQ": 0          // ← 改成你的 QQ 号
  },
  "reply": {
    "privateReply": true, // 私聊是否回复
    "groupReply": false,  // 群聊总开关（默认关，避免刷屏）
    "replyOnAt": true,    // 群里被 @ 时回复
    "groupPrefixes": ["小助手"]  // 群里以这些词开头才回
  }
}
```

### 想让它在群里也回话

```jsonc
"reply": {
  "groupReply": true      // 打开后群里所有消息都回（小心刷屏）
}
```

或者保持 `false`，只让它被 @ 或说「小助手」开头时回。

### 想让它主动找你

```jsonc
"proactive": {
  "enabled": true,
  "allFriends": false,          // 建议先只对自己
  "targets": ["你的QQ号"],
  "minGapMin": 40,              // 最小间隔（分钟）
  "maxGapMin": 80,
  "quietStart": 1,              // 凌晨 1 点到 8 点不打扰
  "quietEnd": 8
}
```

> ⚠️ **注意**：小号短时间频繁主动发消息可能触发腾讯风控。
> 建议间隔 40 分钟以上，并且**只对自己或熟悉的人开启**。

### 想自动通过好友申请

```jsonc
"autoAccept": {
  "enabled": true,
  "friend": true,
  "requireKeyword": "小助手",    // 验证消息必须含这个词
  "maxPerHour": 5
}
```

---

## 改人设

人设决定它的性格和说话方式。有两种改法：

### 方式一：用预设

```bash
node src/人设卡.mjs
```

提供几套现成风格可选。

### 方式二：直接改

编辑 `persona.mjs`，重点是这两段：

- **【绝对禁止】** —— 挡 AI 味（客服腔、Markdown、免责声明）
- **【例子】** —— **这段最有效**。写 4 组「对方说 X → 你回 Y」，模型会严格模仿

### 改完先看效果，不用去 QQ 试

```bash
node src/试试.mjs                    # 测几句默认问题
node src/试试.mjs "你吃饭了吗"        # 测指定一句
node src/试试.mjs -i                 # 交互模式，连续对话
```

---

## 常用命令

```bash
node 安装.mjs             # 一键安装
node src/检查环境.mjs      # 检查环境是否就绪
node src/检查NapCat.mjs    # 检查 NapCat 是否完整
node src/bridge.mjs       # 启动桥接
node src/试试.mjs         # 测试人设效果
node src/人设卡.mjs        # 切换人设
node src/换模型.mjs        # 查看/切换模型
```

---

## 目录结构

```
qq-ollama-bot/
├── 安装.mjs / 安装.bat        ← 一键安装
├── 启动.bat                   ← 一键启动
├── config.json               ← 配置（安装后生成）
├── persona.mjs               ← 人设（从 example 生成）
├── persona.example.mjs       ← 示例人设
└── src/
    ├── bridge.mjs            ← 主程序
    ├── memory.mjs            ← 长期记忆 + 人设进化
    ├── emotion.mjs           ← 情绪系统
    ├── stickers.mjs          ← 表情包收集与视觉识别
    ├── proactive.mjs         ← 主动聊天
    ├── autofriend.mjs        ← 自动加好友
    ├── 检查环境.mjs
    ├── 检查NapCat.mjs
    ├── 人设卡.mjs
    ├── 换模型.mjs
    └── 试试.mjs
```

运行时会产生这些数据目录（已在 `.gitignore` 里，不会被提交）：

```
memories/     每个人的对话档案
emotions/     心情、亲密度
stickers/     表情包素材库 + 索引
proactive/    主动聊天状态
logs/         运行日志
```

---

## 技术细节

### 为什么用两个模型

- **聊天**：`qwen3.5-4b`（2.7 GB）—— 4B 参数在 8 GB 显存上能秒回
- **视觉**：`qwen2.5vl:3b`（3.2 GB）—— 用于看图、给表情库打标签

两个模型按需加载，比用一个 8B 模型同时干两件事更省显存。

### 关于「AI 味」

实测发现裸模型的输出在 QQ 群里会非常出戏：

> 电脑卡确实很让人头疼！不过**内存不够只是原因之一**……
> ### 1. 先确认是不是"真"的内存不足

所以 `persona.mjs` 的【绝对禁止】段和 `bridge.mjs` 的 `sanitize()` 做了两层防护。

### 关于 GIF

`qwen2.5vl` 不支持 GIF 格式，会报 `image: unknown format`。
本项目内置了**纯 JS 的 GIF 解码器**，自动转首帧为 PNG 再送进模型（500×500 约 17 毫秒），
**不依赖 ffmpeg**。

### 显存建议

| 显存 | 体验 |
| --- | --- |
| 8 GB | 流畅，推荐 |
| 6 GB | 可用，同时加载两个模型时可能切换略慢 |
| 4 GB 以下 | 建议只用一个小模型，或把 `vision.enabled` 关掉 |

---

## 常见问题

**Q：NapCat 安装报错 `Unexpected end of archive`**

一键安装器会从 GitHub 下载 36 MB 的包。国内网络下可能被截断。
解决办法：手动下载完整的 `NapCat.Shell.zip`（约 36 MB），解压后替换。

**Q：启动后 QQ 里没反应**

按顺序检查：
1. NapCat 里登录了吗？（`node src/检查NapCat.mjs` 看端口）
2. OneBot 的 WebSocket 客户端开了吗？（应监听 3001）
3. 桥接日志里有没有 `已连接`？

**Q：回复很慢**

首次要加载模型进显存（几秒）。之后常驻，通常 0.5 秒内回复。

**Q：它总是说自己是 AI**

改 `persona.mjs` 的【身份】段，并在【例子】里加一组示范。

**Q：怎么让它忘记某人的对话**

```bash
rm memories/p-<他的QQ号>.json
rm emotions/p-<他的QQ号>.json
```

**Q：想换更大的模型**

```bash
ollama pull qwen2.5:7b
node src/换模型.mjs --chat qwen2.5:7b
```

但注意 7B 模型在 8 GB 显存上会溢出到内存，速度会明显变慢。

---

## ⚠️ 安全提醒

1. **不要提交 `config.json`** —— 里面有 OneBot 访问令牌（`.gitignore` 已处理）
2. **给 OneBot 设个 accessToken** —— 否则本机任何程序都能调用它的接口
3. **小号风险** —— 自动化操作 QQ 可能触发风控，请自行评估
4. **主动聊天慎用** —— 对不熟的人主动发消息可能被举报

---

## License

MIT

---

## 致谢

- [Ollama](https://ollama.com/) —— 本地模型推理
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— QQ OneBot 实现
- [Qwen](https://github.com/QwenLM) —— 模型