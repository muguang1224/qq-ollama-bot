# QQ 本地模型机器人

用**本地大模型**驱动的 QQ 聊天机器人。不需要云端 API、不需要 API Key、不花一分钱。

```
QQ  ←→  NapCat (OneBot v11)  ←→  本项目  ←→  Ollama (本地模型)
```

基于 [Ollama](https://ollama.com/) 跑推理，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 收发 QQ 消息。

**Windows / Linux / macOS 都能跑**（三个平台的启动脚本都带了，见下方「快速开始」）。

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
| **发语音** | 能把回复用语音再说一遍；支持**声音克隆**（用你指定的音色） |
| **QQ 空间说说** | 可开启，按心情自动发说说（低频、限时段、可配图） |
| **群聊对话状态** | 群里被 @ 一次后，接下来几分钟不用重复 @ 也能接着聊 |
| **主人设定** | 指定一个 QQ 号为主人，用固定称呼，且不受人设进化覆盖 |
| **不说没做过的事** | 硬性约束：它不会编造"刚刷到视频""今天天气"这类假经历 |

### 它不会假装自己有生活

这一条单独说，因为它容易做错。

本地模型很爱编造"真实生活"来显得像人 ——「刚刷到个视频」「今天天气不错」
「我在做饭」。但它**没有身体、不能上网、不能出门**，说这些就是撒谎。

项目在**两层**挡这件事：

| 层 | 做法 |
| --- | --- |
| **Prompt 层** | 明确区分「内部状态」和「外部经历」：心情/想法可以说，"我做了什么"不许说 |
| **代码层** | 正则硬拦截，命中就不发送（不依赖模型自觉） |

```
可以说：有点无聊 / 犯困 / 在想个事 / 想找人聊
不能说：刚刷到个视频 / 今天天气不错 / 刚吃完饭 / 我在打游戏
```

**心态是真实的，经历是编的 —— 只保留前者。**

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
- **NapCat** —— 见下面各平台说明
- 一个**不常用的小号 QQ**（建议，避免和你的主号混在一起）

先克隆下来：

```bash
git clone https://github.com/muguang1224/qq-ollama-bot.git
cd qq-ollama-bot
```

然后按你的系统选一套：

---

### Linux（推荐用 Docker 跑 NapCat）

Linux 上 NapCat 的装法和 Windows 完全不同 —— **官方推荐用 Docker**，
镜像里自带 QQ，不用折腾 xvfb、系统依赖和 QQ 授权。

**1. 安装项目**

```bash
./安装.sh
```

它会检查 Node / Ollama / Docker，拉模型，生成配置。也可以 `./安装.sh --no-yolo` 跳过 YOLO。

**2. 起 NapCat**

先改 `docker-compose.yml` 里的 `WEBUI_TOKEN`（设个自己的随机串），然后：

```bash
docker compose up -d
docker compose logs -f napcat     # 看日志：扫码 或 用 token 登 WebUI
```

> 首次需要扫码登录小号。二维码会打在日志里，也可以进
> `http://127.0.0.1:6099` 用 `WEBUI_TOKEN` 登录。

**3. 确认连接**

在 NapCat WebUI 里进「网络配置」，确认有一个 **WebSocket 客户端**指向
`ws://127.0.0.1:3001`。`docker-compose.yml` 用的 `MODE: ws` 已经配好了，
端口也映射出来了，通常不用改。

**4. 启动**

```bash
./启动.sh
```

看到 `已连接。等待 NapCat 推送消息…` 就成功了。

> **不想用 Docker？** 官方也有一键脚本：
> ```bash
> curl -fL -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh
> bash napcat.sh --docker n --cli y --github-proxy 0
> ```
> 装到 `~/Napcat`，运行 `napcat` 管理服务。

---

### Windows

**1. 安装项目**

双击 **`安装.bat`**，或者：

```bash
node 安装.mjs
```

**2. 装 NapCat**

1. 从 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.Windows.OneKey.zip`
2. 解压，运行 `NapCatInstaller.exe`
3. 启动 NapCat，用小号扫码登录

> **提示**：一键安装器会下载一个 36 MB 的包。国内网络下可能被截断，
> 见下方「常见问题」。

**3. 配置 OneBot 连接**

浏览器打开 `http://127.0.0.1:6099`（token 看启动日志）：

1. 进「网络配置」
2. 新建 **WebSocket 客户端**（正向 WS）
3. 地址填 `ws://127.0.0.1:3001`
4. 保存并启用

**4. 启动**

双击 **`启动.bat`**，或者：

```bash
node src/bridge.mjs
```

---

### macOS

流程和 Linux 一样，NapCat 用官方 [NapCat-Mac-Installer](https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest)。
安装和启动都用 `.sh` 脚本。

---

**三个平台跑起来之后，用你的主号给小号发条消息试试。**

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

**推荐做法：对话状态**（默认配置就是这样）

```jsonc
"reply": {
  "groupReply": false,        // 不用全开
  "replyOnAt": true,          // 被 @ 就回
  "groupPrefixes": ["小助手"], // 或者以这个词开头
  "groupSessionMs": 300000,   // ⭐ 被 @ 后 5 分钟内，普通消息也回
  "cooldownMs": 4000          // 同一群 4 秒内只回一次，防刷屏
}
```

**为什么需要 `groupSessionMs`：**

群里 @ 它一次，它回了一句；你接着说「你在干嘛」—— 如果只认 @，
它就不理你了，体验很割裂。开启后：

```
@小助手 在吗        → 回，并开启 5 分钟对话状态
你在干嘛            → 回（状态内，不用重复 @）
吃饭了吗            → 回（状态内，有互动就续期）
…… 5 分钟无互动 …
嘿                  → 不回（状态已过期）
```

**想彻底全开**（不推荐，容易刷屏被踢）：

```jsonc
"reply": {
  "groupReply": true,      // 群里所有消息都回
  "cooldownMs": 4000       // 强烈建议保留冷却
}
```

> 💡 `cooldownMs` 只影响「回不回」，**消息仍会进上下文**，所以记忆不会断。

### 想设置一个"主人"

指定一个 QQ 号作为主人，它会用固定称呼，并且**这个身份不受人设进化覆盖**：

```jsonc
"bot": {
  "owner": 123456789,       // 主人的 QQ 号，0 = 不启用
  "ownerName": "老板"        // 怎么称呼主人
}
```

效果：

- 对这个人是**固定称呼**（其它人还是它自己学来的叫法）
- 人设进化每几轮会重写记忆，但**主人的称呼和态度由代码兜住**，不会被改掉
- 态度上会更亲近一些，但**不卑微** —— 可以贫嘴、可以拒绝、可以说"这个我不干"

> 隐私提示：QQ 号写在 `config.json`（已被 `.gitignore` 排除），
> **不在源码里硬编码**，所以仓库里不会有你的个人信息。

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

### 想让它自动发 QQ 空间

**默认关闭。开启前请先读下面的风险提示。**

```jsonc
"qzone": {
  "enabled": true,
  "maxPerDay": 1,        // 每天最多几条
  "minGapHours": 20,     // 两条之间至少间隔几小时
  "activeStart": 9,      // 最早几点发
  "activeEnd": 23,       // 最晚几点发
  "chance": 0.35,        // 每次检查时的发布概率（避免太规律）
  "imageChance": 0.4,    // 配图概率
  "ugcRight": 1,         // 可见范围：1所有人 4好友 64仅自己
  "maxChars": 40,        // 内容最大字数
  "checkEveryMin": 60    // 多久检查一次
}
```

**它发什么：** 内容由**情绪系统驱动** —— 心情好就轻快，低落就话少。

```
心情 80 → 今天突然好想吃火锅 但太热了算了
心情 60 → 好无聊 想喝东西 但又懒得走
心情 40 → 刚吃完碗 又撑了 不想动
```

**同时受"不许编造"约束**：说说里也不会出现"刚刷到视频"这种假经历。

> ⚠️ **风险提示（务必读）**
>
> 这是通过 NapCat 拿到的 cookie 调用腾讯 `taotao.qzone.qq.com` 接口，
> **属于非官方途径**。腾讯对空间接口的风控比聊天更严。
>
> - 轻则说说发不出去、要验证码
> - 重则空间功能被限制、账号被封
>
> 项目已做**最大限度的保守设置**（一天≤1条、限时段、低概率、短内容），
> 但**风险由你承担**。建议：
> - 只在**小号**上开
> - 先设 `"ugcRight": 64`（仅自己可见）跑几天，确认稳定再改公开
> - 一旦发现异常，立刻把 `enabled` 改回 `false`

**发布失败怎么看：** 日志里会打印

```
📱 空间发布失败：code=-3 参数错误
```

常见原因：cookie 过期（重启 NapCat 后会自动刷新）、权限不足、内容被拦。

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

### 想让它发语音

它能把回复**用语音再发一遍**（文字照常发，语音是额外补的一条）。

```jsonc
"tts": {
  "enabled": true,
  "engine": "edge",                // edge（微软在线）| sovits（克隆音色）
  "chance": 0.15,                  // 随机发语音的概率
  "cooldownMin": 30,               // 同一个人多久内不发第二条
  "maxChars": 60                   // 太长的合成慢，不发
}
```

**两个引擎的区别：**

| 引擎 | 音色 | 需要什么 | 速度 |
| --- | --- | --- | --- |
| `edge` | 固定的微软音色 | 联网 + `pip install edge-tts` | 2~4 秒 |
| `sovits` | **你指定的音色**（声音克隆） | 本地跑 GPT-SoVITS + 显卡 | 1~3 秒 |

**`edge` 可选的中文女声**（改 `voice`）：

```
zh-CN-XiaoxiaoNeural     温暖
zh-CN-XiaoyiNeural       活泼（默认）
zh-CN-liaoning-XiaobeiNeural   东北话
zh-CN-shaanxi-XiaoniNeural     陕西话
```

> 语音比文字更容易触发风控，所以默认概率只有 15%、同人冷却 30 分钟。
> 想更频繁就把 `chance` 调高，但别调太狠。

### 想让它用指定的音色说话（声音克隆）

这就是 `engine: "sovits"`。用的是 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)：
给一段参考音频，它就能用那个音色说话，**零样本、不用训练**。

**步骤：**

**1. 装 GPT-SoVITS**

下载官方 Windows 整合包（自带 Python 和依赖，不用自己配环境）：

```
https://github.com/RVC-Boss/GPT-SoVITS/releases
```

有 **50 系 N 卡特供版**（40 系/30 系用普通版）。解压后大概 15GB。

**2. 准备参考音频**

- **5~10 秒**清晰人声，**越干净越好**（有伴奏会明显影响效果）
- 人声和伴奏混在一起的话，先用 [Demucs](https://github.com/facebookresearch/demucs) 分离：
  ```bash
  pip install demucs
  python -m demucs --two-stems=vocals -n htdemucs_ft -o out 你的音频.mp3
  # 结果在 out/htdemucs_ft/<文件名>/vocals.wav
  ```
- 放到项目的 `voice-ref/ref_b.wav`

**3. 配置**

```jsonc
"tts": {
  "enabled": true,
  "engine": "sovits",
  "sovitsUrl": "http://127.0.0.1:9880/tts",
  "sovitsRef": "",                                  // 留空用 voice-ref/ref_b.wav
  "sovitsPrompt": "参考音频里说的那句话",              // ⚠️ 必须准确
  "sovitsSpeed": 1.0,
  "sovitsTemperature": 0.8,
  "sovitsTopK": 6,
  "sovitsTopP": 0.85
}
```

**4. 启动语音服务**

双击 `start-sovits.bat`（`一键启动.bat` 里也会自动带上这一步）。
加载模型约 60 秒，之后每句话只要 1~3 秒。

**调音色的小抄：**

| 想要的效果 | 怎么调 |
| --- | --- |
| 更稳、更像参考音 | `sovitsTemperature` 调低（0.5~0.8） |
| 更活、更开朗 | `sovitsTemperature` 调高（1.0~1.2）、`sovitsTopK` 调大 |
| 语速快/慢 | `sovitsSpeed`（1.0 是原速） |
| **总觉得"闷"** | 先换参考音频段落 —— 参数能调的有限 |

**⚠️ 关于参考音频的版权：**

**用别人的声音（尤其配音演员、虚拟角色的）公开发布语音，可能侵权。**
`voice-ref/` 已在 `.gitignore` 里，不会上传。建议只在熟人小范围用。

### 想自动发 QQ 空间

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
├── 安装.bat / 安装.sh         ← 一键安装（Windows / Linux·macOS）
├── 启动.bat / 启动.sh         ← 一键启动
├── docker-compose.yml         ← Linux 上跑 NapCat 用
├── config.json               ← 配置（安装后生成）
└── src/
    ├── bridge.mjs            ← 主程序
    ├── paths.mjs             ← 项目根定位（所有模块统一用它）
    ├── platform.mjs          ← 跨平台小工具（路径/命令/可执行文件查找）
    ├── memory.mjs            ← 长期记忆 + 人设进化
    ├── emotion.mjs           ← 情绪系统
    ├── stickers.mjs          ← 表情包收集 / 视觉识别 / GIF 解码 / 图片缩放
    ├── video.mjs             ← 视频抽帧 + 语音消息判断
    ├── tts.mjs               ← 发语音（edge-tts / GPT-SoVITS 双引擎）
    ├── qzone.mjs             ← QQ 空间发说说（情绪驱动内容 + 低频限制）
    ├── qzone-api.mjs         ← 空间接口封装（凭证 / bkn / 发布）
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

### 项目根目录怎么定位（paths.mjs）

代码可能在两个位置：本地开发时在项目根，发布版在 `src/` 下。
一开始每个模块各写一套定位（`dirname(__dirname)` / `dirname(dirname(...))` / 硬编码），
结果接连出问题：

- 配置文件被生成到 `src/config.json` 而不是项目根
- `video.mjs` 多取一级，指到了桌面上
- `检查NapCat.mjs` 硬编码了开发机的路径，换台机器就废

现在统一用 `src/paths.mjs`：**从本文件往上找 `package.json`**，
找不到就找带 `src/` 或 `yolo-models/` 的目录，再不行退一级。

```js
import { ROOT } from './paths.mjs';
const MEM_DIR = join(ROOT, 'memories');
```

这样代码放哪都不会错，也不写死任何路径。有对应的单测覆盖了 5 种目录布局。

### 跨平台是怎么做的（platform.mjs）

项目最早只在 Windows 上跑，代码里散落着一些平台假设，迁到 Linux 时会踩坑。
统一收进 `src/platform.mjs`：

| 差异点 | Windows | Linux / macOS |
| --- | --- | --- |
| 找可执行文件 | `python`，要带 `.exe` | **`python3`**，无后缀 |
| 查端口 | `netstat -ano` | **`ss -lntp`**（macOS 用 `lsof`） |
| 子进程选项 | `windowsHide: true` | 无此选项 |
| ffprobe | `ffprobe.exe` | `ffprobe` |

其中**一个必出错的 bug**：拼表情包路径时原来的写法是

```js
const abs = (STICKER_DIR + '\\' + file).replace(/\\/g, '/');
```

Linux 上 `STICKER_DIR` 是 `/home/x/stickers`，加反斜杠会拼成
`/home/x/stickers\a.gif` —— 路径直接废掉。现在改用 `join()` + `fileUrl()`。

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

### QQ 空间接口是怎么调通的

记一下这段，因为官方没文档，全靠对着 NapCat 内部实现抄。

**踩的第一个坑：域名**

网上流传的地址是 `taotao.qq.com`，**这个域名已经废弃**（DNS 都解析不到）。
正确地址在 NapCat 源码里：

```
https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6
```

**踩的第二个坑：参数**

少一个 `hostuin` 或 `qzreferrer` 就返回 `code: -3 参数错误`，
而且**不告诉你缺哪个**。完整参数集（照搬 NapCat 的 `fG()` 函数）：

```
syn_tweet_verson=1  paramstr=1  con=<正文>  feedversion=1  ver=1
ugc_right=1         to_sign=0   hostuin=<QQ号>
code_version=1      format=json qzreferrer=https://user.qzone.qq.com/<QQ号>/main
```

**踩的第三个坑：凭证**

`get_cookies` **必须带 `domain` 参数**，不带会报
`Schema compilation error: Expected required property`：

```js
bot.call('get_cookies', { domain: 'user.qzone.qq.com' })
```

拿到 cookie 后用 `p_skey` 算 `g_tk`（bkn 算法），作为 URL 的 `?g_tk=` 参数。

**还有一个坑：`bot.call()` 的返回值**

不同实现里 `call()` 可能把 `ev.data` 解包后再返回，也可能是完整响应对象。
本项目统一解包（返回 `data`），所以拿 cookie 直接 `r.cookies` 就行。
代码里两种格式都兼容了，换实现时不会又踩一次。

### 启动脚本为什么要用 CRLF

`一键启动.bat` / `启动.bat` 这些文件**必须是 CRLF 换行**（`\r\n`）。

用 LF（`\n`）时 cmd 会把行**从中间劈开**解析，报出莫名其妙的错：

```
'ma_ok' is not recognized          ← 其实是 ollama_ok 被劈了
'_EXE' is not recognized           ← 其实是 OLLAMA_EXE 被劈了
'Order:' is not recognized
```

**症状很迷惑，但原因就这么简单。** 另外脚本内部**尽量用纯 ASCII**，
中文 + `chcp 65001` 组合也踩过坑。

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

### Linux 相关

**Q：`./启动.sh` 提示 Permission denied**

```bash
chmod +x 启动.sh 安装.sh
```

**Q：docker compose up 之后连不上 3001**

按顺序查：

```bash
docker compose ps                      # 容器在跑吗
docker compose logs -f napcat          # 登录了吗（要扫码）
node src/检查NapCat.mjs                 # 端口在听吗
```

镜像里的 `MODE: ws` 已经开好正向 WebSocket 了，端口也映射到本机 ——
一般只需要**扫码登录**这一步没做。

**Q：端口绑的是 127.0.0.1，我要从另一台机器连**

改 `docker-compose.yml` 的 ports，把 `127.0.0.1:` 去掉即可 ——
但**这样会把 OneBot 暴露到局域网，务必同时给 OneBot 设 accessToken**。
更安全的做法是用 SSH 端口转发：

```bash
ssh -L 3001:127.0.0.1:3001 user@server
```

**Q：Ollama 装完没跑起来**

```bash
sudo systemctl status ollama
sudo systemctl start ollama
# 或者前台跑一下看报错
ollama serve
```

**Q：arm64（树莓派 / 甲骨文 ARM 机器）能跑吗**

代码可以。但 `qwen3.5-4b` 在 ARM 上会很慢，建议换更小的模型：

```bash
ollama pull qwen2.5:1.5b
node src/换模型.mjs --chat qwen2.5:1.5b
```

`qwen2.5vl:3b` 也要相应换成更小的视觉模型，或者直接
`"vision": { "enabled": false }` 关掉看图。

---

## ⚠️ 安全提醒

1. **不要提交 `config.json`** —— 里面有 OneBot 访问令牌（`.gitignore` 已处理）
2. **给 OneBot 设个 accessToken** —— 否则本机任何程序都能调用它的接口
3. **小号风险** —— 自动化操作 QQ 可能触发风控，请自行评估
4. **主动聊天慎用** —— 对不熟的人主动发消息可能被举报
5. **QQ 空间风险更高** —— 非官方调用腾讯接口，风控比聊天严，默认关闭。要开请先读[那一节](#想让它自动发-qq-空间)
6. **主人 QQ 号不要写进代码** —— 用 `config.json` 的 `bot.owner`（本项目源码里不硬编码任何 QQ 号）

---

## License

MIT

---

## 致谢

- [Ollama](https://ollama.com/) —— 本地模型推理
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— QQ OneBot 实现
- [Qwen](https://github.com/QwenLM) —— 模型