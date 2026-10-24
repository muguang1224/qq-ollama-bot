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
| **听懂语音** | 语音自动转成文字（QQ 自带能力，很快很准） |
| **看到视频** | 抽几帧交给视觉模型，知道大概内容（不是真的理解视频） |
| **YOLO 目标检测** | 独立跑传统目标检测，给出"几个人、什么物体"的客观结果 |
| **情绪系统** | 心情 / 亲密度 / 精力三个值，会真的影响说话语气（心情差就敷衍你） |
| **长期记忆** | 记得你说过什么，重启不失忆 |
| **人设进化** | 每聊几轮，自动提炼对这个人的了解，态度从陌生到熟络 |
| **标点学习** | 统计对方的说话习惯（爱用逗号还是句号），跟着模仿 |
| **表情包自动收集** | 别人发的表情自动存进素材库，按情绪和场合挑选发送 |
| **主动聊天** | 可开启，让它偶尔主动找你说话（带多重防打扰机制） |
| **会话内追问** | 回完一句后有时再补一句，不是一问一答就结束 |
| **自动加好友** | 可开启，按关键词或白名单自动通过好友申请 |

### 它到底能"看懂"多少

说清楚边界，免得期待过高：

| 类型 | 能力 | 速度 |
| --- | --- | --- |
| 文字 | 完整理解 | 快 |
| 图片 | 描述画面 + 情绪（中文） | ~1-5 秒 |
| **语音** | **转成完整文字** —— 等于听懂了 | ~1 秒 |
| 视频 | 抽 3 帧看画面，**不知道过程、听不到声音** | 慢（后台跑） |

**语音是真的"听懂"，视频只是"瞥一眼"。**

### 两个视觉模型怎么配合

项目同时跑**两套**视觉，结果独立保存、互相补充：

| | 多模态大模型 | YOLO |
| --- | --- | --- |
| 模型 | `qwen2.5vl:3b` | `yolo11n` / `-pose` / `-cls` |
| 体积 | 3.2 GB | **32 MB** |
| 给出 | 「金发女孩，表情愤怒」 | 「检测到 人，1 个人形」 |
| 强项 | 语义、情绪 | 客观计数、真实照片 |
| 卡通图 | ✅ 能认 | ❌ **认成"时钟"** |

**YOLO 对卡通/表情包基本无效** —— COCO 数据集全是真实照片。
所以它只作为**参考信息**，不主导判断（选图时会用相对可靠的"人形数量"做轻微加权）。

> 想省资源可以直接关：`"yolo": { "enabled": false }`

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

### 媒体理解开关

```jsonc
"vision": {
  "enabled": true,
  "model": "qwen2.5vl:3b"     // 看图用的视觉模型
},
"video": {
  "enabled": true,            // 关掉就设 false（它比较慢）
  "frames": 3,                // 抽几帧
  "width": 256,               // 抽帧宽度，别超 384（会内存不足）
  "maxMB": 80                 // 超过这么大的视频不处理
},
"audio": {
  "enabled": true             // 语音转文字
},
"followUp": {
  "enabled": true,            // 会话内追问
  "chance": 0.3               // 补话概率（受情绪加成）
}
```

**视频比较重**（下载 + 抽帧 + 逐帧识别），觉得慢或不需要就直接
`"video": { "enabled": false }`。

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
    ├── stickers.mjs          ← 表情包收集 / 视觉识别 / GIF 解码 / 图片缩放
    ├── video.mjs             ← 视频抽帧 + 语音消息判断
    ├── yolo.mjs              ← YOLO 调用（Node ↔ Python）
    ├── proactive.mjs         ← 主动聊天 + 会话内追问
    ├── autofriend.mjs        ← 自动加好友
    ├── 检查环境.mjs
    ├── 检查NapCat.mjs
    ├── 人设卡.mjs
    ├── 换模型.mjs
    └── 试试.mjs

yolo-models/
    ├── yolo.py               ← YOLO 推理脚本
    └── *.onnx                ← 模型（安装时下载，不进仓库）
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

### 图片必须先缩小（最重要的性能优化）

实测（Ollama 0.24 + `qwen2.5vl:3b`）：

| 送进去的图 | 耗时 |
| --- | --- |
| 原图 148 KB | **46 ~ 200 秒**，有时直接失败 |
| 缩到 512px | 20.6 秒 |
| 缩到 384px | 10.6 秒 |
| **缩到 256px** | **4.4 秒** ← 默认值 |
| 缩到 128px | 1.9 秒 |
| 缩到 64px | 1.5 秒 |

**同一张图，缩到 256px 后从 46 秒降到 4.4 秒** —— 识别结果几乎一样。

所以代码里在送模型前会自动缩放（`vision.maxPx`，默认 256）。
GIF 用内置解码器，JPEG 用 ffmpeg，PNG 用内置的纯 JS 缩放。

**如果你觉得识别不准，可以调大 `vision.maxPx`，但要接受成倍的耗时增长。**

### YOLO 的坑

用的是官方预导出的 ONNX（`ultralytics/assets` release），
通过 GitHub API 的 `Accept: application/octet-stream` 拿签名直链下载 ——
`github.com` 直连在部分网络下不通，这样能绕过去。

推理用 **onnxruntime CPU**（`CUDAExecutionProvider` 在多数 Windows 安装里不可用），
所以一张图约 0.1-0.5 秒，比大模型快得多。

另外 **cv2 读 GIF 不可靠** —— 实测会把动漫表情读坏、推理结果全错。
代码里统一用 **Pillow 读图**（转 RGB、透明区贴白底），再交给 cv2 缩放。

### 关于 GIF

`qwen2.5vl` 不支持 GIF 格式，会报 `image: unknown format`。
本项目内置了**纯 JS 的 GIF 解码器**，自动转首帧为 PNG 再送进模型（500×500 约 17 毫秒），
**不依赖 ffmpeg**。

### 为什么图片扩展名要用"魔数"判断

实测发现：**QQ 发来的动画表情，`file` 字段写的是 `.jpg`，实际内容是 GIF**。

如果信文件名，就会：
1. 存成 `.jpg`
2. 识别时不做 GIF 转换
3. 视觉模型报 `image: unknown format`

所以代码里一律用文件头魔数判断真实格式，不信扩展名。

### 视频处理为什么放后台

视频要「下载 → 抽帧 → 逐帧识别」，几十秒起步。

一开始写成串行 `await`，结果**视频一卡，回复被拖死甚至完全不回**。
现在：

- **图片、语音**：同步等（都快，1 秒内），这样回复时就能用上内容
- **视频**：丢到后台跑，**先回复**；理解结果写进上下文，下一轮就能用

### 语音转文字的关键参数

```
fetch_ptt_text(message_id, raw_message)  → 可能超时
fetch_ptt_text(message_id, file)         → 稳定成功
```

另外**语音刚收到时腾讯侧可能还没处理完**，所以代码里有 3 次重试。

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

**Q：发了视频/语音，它不回复**

V1 版本有过这个问题，V2 已修。如果你还遇到，检查两点：

1. **有没有别的程序在抢 OneBot 连接？**
   ```bash
   netstat -ano | findstr ":3001"
   ```
   如果 `ESTABLISHED` 有**多个不同的 PID**，说明有别的进程（比如调试脚本）
   在抢消息。NapCat 的消息可能被它截走。

2. **桥接日志里有没有收到消息？**
   日志里没有 `收到 [私聊] xxx` 说明消息根本没到桥接，是连接问题。

**Q：它看视频很慢**

正常。视频要下载（可能几十 MB）+ 抽帧 + 逐帧识别，几十秒起步。
**它不阻塞回复**（后台跑），所以你不会等。不想用可以：
```jsonc
"video": { "enabled": false }
```

**Q：抽帧报内存不足**

抽帧宽度太大了。默认 256px 是实测出来的安全值，
512px 时会报 `model requires more system memory (9.3 GiB)`。别调太高。

**Q：看图很慢（几十秒）**

多半是图没缩小。检查 `config.json` 的 `vision.maxPx` 是不是 256。
实测原图直接送要 46-200 秒，缩到 256px 只要 4.4 秒。

**Q：YOLO 把动漫角色认成"时钟"**

正常，这是已知局限。YOLO 的训练数据（COCO）全是真实照片，
没有卡通素材，所以对表情包基本无效。

它对**真实照片**是准的（人像 0.76 置信度），所以代码里只当参考。
不想要就直接 `"yolo": { "enabled": false }`。

**Q：YOLO 提示找不到 yolo.py 或模型**

两件事都检查：
1. `yolo-models/` 目录下有没有 `yolo.py` 和三个 `.onnx`
2. Python 有没有装依赖：`pip install onnxruntime opencv-python-headless numpy`

模型没下载成功的话重跑 `node 安装.mjs`，或者手动去
[ultralytics/assets](https://github.com/ultralytics/assets/releases/tag/v8.3.0)
下 `yolo11n.onnx`、`yolo11n-pose.onnx`、`yolo11n-cls.onnx` 放进 `yolo-models/`。

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