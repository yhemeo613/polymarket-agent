# polymarket-agent

**全自主 AI 预测市场交易 Agent** · NestJS + TypeScript · 无 UI（仅 ops API）

> 一个为回答一个可证伪问题而生的系统：*LLM Agent 的概率预测，能否显著优于预测市场的群体定价？*
>
> 核心铁律：**LLM 研究、代码管钱 · paper-first · 一切可审计 · 统计纪律内置**

---

## ⚠️ 免责声明（先读这个）

- 本项目是**研究实验品**，不是赚钱工具。公开可审计的全部证据（见[背景](#背景与动机)）显示当前 LLM Agent **尚未稳定跑赢预测市场价格**。你大概率会得到一个负结果——而**负结果同样是研究成果**。
- 预测市场交易存在资金损失风险。本系统默认 **paper 模式**（模拟撮合），实盘功能受构造级物理隔离守卫，需显式关闭保护并配置私钥才会启用。
- Polymarket 按 IP 地域限制访问（含美国），使用者须自行确认所在司法辖区的合规性。本项目不提供任何规避手段。
- 本项目不构成投资建议。

---

## 背景与动机

在设计本系统前，我们对「AI Agent + 预测市场」赛道做了一轮深度逆向研究（Polymarket 官方 agents 框架、CloddsBot、oracle3、phil、autopredict 等开源项目，以及 Polymarket 全套 API），得到四条颠覆直觉的事实：

| # | 事实 | 证据来源 |
|---|---|---|
| 1 | **前沿 LLM 真金实盘 57 天全部亏损**（-16% ~ -30.8%） | Prediction Arena 论文（arXiv 2604.07355，6 个模型 × $10k） |
| 2 | **最强的自改进开源 Agent 自曝无 edge**：paper ROI -16%，2387 条预测的 brier_delta ≈ 0（等于市场价） | [phil](https://github.com/bennyjo/phil) |
| 3 | **市场价本身就是极强基线**：72.1M 笔成交实证，taker 平均 -1.12%、maker +1.12%——做市商赚的是结构钱，不是预测钱 | [prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis) |
| 4 | 成功因素层级：预测准确率 > 加仓时机 > 仓位控制 > 退出选择 > 研究质量；**研究数量与成绩无关** | Prediction Arena 归因分析 |

因此本项目的定位不是「自动赚钱机器」，而是：**一个无人干预运行、测量口径严谨的黑盒实验系统**。它的产出是一份可统计检验的回答，无论方向是正是负。

---

## 核心设计思想

### 铁律一：钱永远不让 LLM 算

LLM 与资金之间隔着一整层确定性代码。分工边界被写进架构：

| LLM 负责 ✓ | LLM 绝不负责 ✗ |
|---|---|
| 市场语义筛选（这个市场到底在问什么） | 计算价格 / edge / 仓位（任何数字 → Decimal 确定性代码） |
| 证据检索与综合（开卷研究） | 直接下单决策（只输出 JSON 意图，由风控裁决） |
| 概率估计 p̂ + 置信度 + 证据引用 | 解析自己的输出（function calling + zod schema） |
| 复盘反思与策略文件编辑（受限目录） | 修改风控参数 / 触碰私钥 / 越过 paper 闸门 |

edge 计算、费率、Kelly 仓位、下单、止盈止损、风控——全部是可单测的纯函数。

### 铁律二：paper-first，实盘物理隔离

- 默认 `PAPER_ONLY=true`：PaperBroker 用**真实订单簿深度走单**模拟成交（FAK 语义、逐档吃深度、无随机数、计 taker 费）。
- LiveBroker 位于独立类，其**构造函数即守卫**（`PAPER_ONLY=true` 时该类从不被实例化——实盘代码路径对运行时完全不可达）。
- 孪生单机制（Twin Orders）：进入实盘阶段后，每笔 paper 信号同步下 $1 真实单，持续度量「纸面模拟 vs 真实成交」的偏差，防止纸面成绩自欺。

### 铁律三：一切可审计

- **SHA-256 hash 链账本**：每条决策裁决（风控过/拒、成交、平仓、playbook 编辑、周期扫描）追加进链，`entry.hash = sha256(prev_hash + payload)`，篡改任一历史记录 `verify()` 立即失败并定位。
- **Forecast Journal**：**所有**预测（含未下注的候选）无条件落库，附点时快照（p̂、市场 mid、best ask、证据引用）。这既是免费的校准数据流，也是黑盒实验的核心测量仪器。
- **request_id 幂等**：订单以 UUID 主键落库，重复执行返回既有结果。

### 铁律四：统计纪律（防自欺的硬规则）

这套规则吸收了 phil 与 autopredict 两个项目的血泪教训，全部内置：

1. **核心指标是 brier_delta**（agent Brier − 市场价 Brier，配对比较），而非绝对准确率——<0 才意味着跑赢市场。
2. **占位书剔除**：空盘口 / 价差 ≥ 0.9 的市场单独标记剔除（phil 发现此类污染曾贡献 -10.87 Brier 和，足以翻转结论符号）。
3. **影子规则晋升制**：任何修改概率的策略规则先以 SHADOW 状态运行（只记录不生效），配对 t 检验 **n ≥ 20 且 t < −2.807（99.5%）才晋升 ACTIVE**；反向显著则强制退役；在册规则 ≤ 6 条。
4. **诚实校准层**：`p_final = σ(a·logit(p_raw) + b)`，参数从自身历史拟合、向恒等映射 L2 正则——市场定价已充分校准时，该层自动退化为无 edge，**不伪造 alpha**。
5. **幸运 z 分数**监控：区分「估计错了」与「方差正常击中」，z 很负时禁止加仓。
6. **复盘纪律**：单一类别 n < 15 禁止下结论；每条 playbook 编辑必须引用已结算市场证据；每轮 ≤ 2 条；playbook 只许追加（append-only）且有 500KB 硬上限。

---

## 架构

```
┌──────────── L5 进化层 evolution（无人值守的"研究生"）────────────────────────┐
│ Settle→Score(brier_delta/luck-z/校准表)→Retro(LLM三问复盘)→playbook 受限编辑   │
│ →影子规则晋升(Welford 配对 t 检验) · 策略=strategy/ 目录文件                   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    ↓
┌──────────── L1 研究层 research（LLM 领地，开卷预测）─────────────────────────┐
│ Gamma 扫描→硬过滤→LLM 语义筛选→Tavily 证据检索→superforecaster 五步法         │
│ →{p̂, 置信度, 证据引用}→Forecast Journal（含未下注候选）                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    ↓ 结构化 JSON（zod 校验）
┌──────────── L2 决策层 decision（确定性代码，钱的领地）───────────────────────┐
│ 校准 σ(a·logit p̂+b) → 在册规则修正 → edge = p̂ − ask − fee(p) − slippage      │
│ → edge ≥ min_edge ? → quarter-Kelly 仓位（单笔帽截断）                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    ↓ TradeIntent
┌──────────── L4 风控层 risk（单一入口，paper/live 共用同一闸门）──────────────┐
│ kill switch 哨兵文件（进程外可置位，双检查防竞态）→ 回撤熔断 20% → 日亏熔断 5% │
│ → regime 4 档（extreme 停机）→ 单笔/单市场/事件/总敞口/持仓数帽 → 裁决入账本   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    ↓
┌──────────── L3 执行层 execution（确定性代码）───────────────────────────────┐
│ PaperBroker：真实盘口深度走单（FAK，无随机数）+ taker 费 + 幂等               │
│ LiveBroker：构造级物理隔离守卫 → clob-client GTC 挂单 → 回报轮询             │
│ TwinOrderService：孪生单钩子（paper↔实盘偏差测量）                           │
└────────────────────────────────────────────────────────────────────────────┘
横向支撑：L0 行情（Gamma API + CLOB 订单簿/WS 增量）· L6 审计（hash 链账本 + pino 日志）
调度：动态 cron（主循环小时级 / 轻触发 15 分钟持仓监控·止盈止损）· ops API（无 UI）
告警：Telegram Bot（周期摘要 / 平仓 / 熔断 / kill switch）
交互：Telegram 交互菜单（点按钮或发命令查询状态/评分/持仓/最近预测、手动触发、紧急停止）
     —— 仅响应 TELEGRAM_CHAT_ID 配置的会话，防止他人控制
```

### 关键机制对照表

| 机制 | 设计出处 |
|---|---|
| 决策核心纯函数化（费用/edge/Kelly 不经 LLM） | oracle3 / CloddsBot 交叉验证 |
| 费率保守兜底（未知品类按最高 documented 费率计） | oracle3 `fees.py` |
| 占位书剔除 | phil（实证教训） |
| 影子规则晋升 + 复盘三问 + playbook 受限编辑 | phil `score.py` |
| 校准层向恒等正则（不伪造 alpha） | autopredict |
| Forecast journal 含未下注候选 | phil forecast/bet 通道分离 |
| kill switch 哨兵文件 + 风控 await 后二次复查 | oracle3 三重保险 |
| paper/live 共用同一风控闸门入口 | 两仓库共识 |
| maker 优先的费率认知（taker 费按品类 4~7% 计入 edge） | Polymarket 官方费率 + 7210 万笔成交实证 |

---

## 黑盒实验协议

### 可证伪假设

> **H0**：agent 的概率估计不优于同期市场中间价（brier_delta ≥ 0）。
> **H1**：agent 显著优于市场价（brier_delta < 0，事件聚类配对 99.5% CI 上界 < 0）。
> **H2**：H1 成立时，执行层（限价 + min_edge 过滤）能将其转化为正的实现 PnL。

### 阶段设计

| 阶段 | 形式 | 样本要求 | Go/No-Go |
|---|---|---|---|
| **P0 离线回测** | 历史数据集 | ≥2000 市场 | 校准管线方向性正确 |
| **P1 影子纸面**（当前默认） | 真实盘口模拟撮合 | ≥6 周 · ≥300 预测 · ≥30 独立结算事件 | brier_delta 配对 CI 上界 < 0 |
| **P2 小额实盘** | ≤$500 隔离预算 + 孪生单 | ≥60 天 | 实现 PnL 与 brier_delta 同号；paper↔实盘偏差 < 30bps |
| **P3 裁决** | 扩量 / **封存归档并发表负结果** | — | — |

### 评估指标体系（`GET /ops/score` 一键输出）

| 指标 | 定义 | 及格线 |
|---|---|---|
| **brier_delta**（核心） | agent Brier − 市场入场价 Brier（配对） | < 0 |
| 校准曲线 | 10 桶 p̂ vs 实现频率（reliability 数据） | 各桶偏差 < 0.05 |
| 幸运 z | (实际胜场 − Σp)/√(Σp(1−p)) | \|z\| < 2 |
| 下注 ROI | 已实现损益 / 已平仓成本 | 与 brier_delta 同号才可信 |
| 阈值扫描 | min_edge ∈ {1%..8%} 反事实平注 ROI | 校准 min_edge 依据 |

---

## 快速开始

### 环境要求

- Node.js ≥ 22（使用内置 `node:sqlite`，**零原生编译依赖**）
- npm（或 pnpm/yarn）

### 安装与启动

```bash
git clone https://github.com/<you>/polymarket-agent.git
cd polymarket-agent
npm install
cp .env.example .env    # 按需修改（见下节）
npm run build
npm start               # 默认 baseline/paper 模式
```

启动即进入无人值守运行：

- 主循环（默认每小时第 7 分钟）：结算 → 复盘 → 扫描 → 筛选 → 预测 → 决策 → 风控 → paper 撮合 → 摘要
- 轻触发（默认每 15 分钟）：持仓监控、止盈（mid ≥ 0.95）、止损（mid ≤ 0.05）
- 控制台实时输出详细 CLI 过程（分阶段进度、逐市场研究流水、彩色状态、周期摘要面板）

### 运行模式

| 模式 | 触发条件 | 行为 |
|---|---|---|
| **baseline** | 不配置 LLM key | p̂ = 市场中间价（**H0 零假设基线**），全链路照常运行——验证管线、采集校准数据 |
| **research** | `LLM_PROVIDER=anthropic` + key | superforecaster 开卷预测（Tavily 证据注入 + playbook 注入）+ LLM 复盘编辑 |
| **paper**（默认） | `PAPER_ONLY=true` | 真实盘口深度走单模拟成交 |
| **live** | `PAPER_ONLY=false` + `WALLET_PRIVATE_KEY` | 真实下单（仍受全量风控闸门；缺私钥启动即失败） |
| **孪生单** | `TWIN_ORDERS=true` + live 配置 | 每笔 paper 信号同步 $1 真实单，度量纸面↔实盘偏差（P2 阶段） |

LLM 兼容任何 Anthropic 协议端点（官方 / 兼容网关），通过 `LLM_BASE_URL` + `LLM_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 配置，模型名 `LLM_MODEL` 任意可换。

### Telegram 交互菜单（推荐）

配置 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` 后，在 Telegram 里点常驻键盘按钮（或发命令）即可查询与控制：

| 按钮 | 命令 | 内容 |
|---|---|---|
| 📊 状态 | `/status` | 模式/资金/回撤/预测统计/brier_delta/账本完整性/持仓 |
| 📈 评分 | `/score` | 评分汇总 + 校准表 + min_edge 阈值扫描 |
| 💼 持仓 | `/positions` | 当前持仓明细（成本口径） |
| 🕘 最近预测 | `/recent` | 最近 5 条预测（p̂ vs 市场价 + 决策理由） |
| 🔄 手动一轮 | `/run` | 立即触发主循环（完成后推送摘要） |
| ⛔ 暂停 | `/kill` | 置位 kill switch（哨兵文件级，进程外等效） |
| ▶️ 恢复 | `/resume` | 解除 kill switch |

安全：bot 只响应 `TELEGRAM_CHAT_ID` 指定会话的消息，其他人发命令被静默忽略。

### Ops API（无 UI）

```bash
curl localhost:3000/status                 # 运行快照（模式/资金/回撤/预测统计/账本完整性）
curl -X POST localhost:3000/cycle/run \
     -H "Content-Type: application/json" \
     -d '{"trigger":"manual"}'             # 立即跑一轮主循环
curl localhost:3000/ops/score              # brier_delta / 10 桶校准表 / 阈值扫描 / 规则列表
curl localhost:3000/ops/ledger/verify      # hash 链账本完整性校验
curl -X POST localhost:3000/ops/kill-switch \
     -H "Content-Type: application/json" \
     -d '{"enabled":true,"reason":"halt"}' # 紧急停止（进程外亦可直接 touch data/kill.switch）
curl -X POST localhost:3000/ops/rules \
     -H "Content-Type: application/json" \
     -d '{"name":"no-crypto","def":{"type":"exclude_category","category":"crypto"}}'  # 创建影子规则
```

### 配置说明（`.env`）

全部配置带 zod 校验，非法值启动即失败（fail-fast）。分组概览：

| 分组 | 关键项 |
|---|---|
| 运行模式 | `PAPER_ONLY`（默认 true）、`BANKROLL_USD`、`TWIN_ORDERS`、`WALLET_PRIVATE_KEY` |
| LLM | `LLM_PROVIDER`(anthropic/none)、`LLM_BASE_URL`、`LLM_AUTH_TOKEN`/`ANTHROPIC_API_KEY`、`LLM_MODEL`、`LLM_MAX_TOKENS` |
| 证据源 | `TAVILY_API_KEY`（可选，无 key 自动闭卷降级） |
| Polymarket | `GAMMA_HOST`、`CLOB_HOST`、`WS_ENABLED`（订单簿 WS 增量，默认关）、`PROXY_URL`（出站代理） |
| 扫描 | `SCAN_LIMIT`、`MIN_LIQUIDITY`、`MIN_VOLUME24H`、`MIN/MAX_DAYS_TO_END`、`BLACKLIST_CATEGORIES` |
| 决策 | `MIN_EDGE`、`KELLY_FRACTION`、`SLIPPAGE_BUFFER_PCT`、`TAKER_FEE_DEFAULT` |
| 风控硬帽 | `MAX_SINGLE_PCT`(2%)、`MAX_MARKET_PCT`(5%)、`MAX_TOTAL_PCT`(50%)、`MAX_POSITIONS`(20)、`DAILY_LOSS_HALT`(5%)、`DRAWDOWN_HALT`(20%) |
| 退出 | `TAKE_PROFIT_AT`(0.95)、`STOP_LOSS_AT`(0.05) |
| 告警 | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（可选） |
| 调度 | `CYCLE_CRON`、`LIGHT_CRON`（六位 cron） |

> ⚠️ 永远不要把真实 `.env` 提交进仓库——它已在 `.gitignore`。风控硬帽是**环境级配置**，LLM 在架构上无权修改（策略编辑面仅限 `strategy/playbook.md`）。

---

## 项目结构

```
polymarket-agent/
├── src/
│   ├── config/          # zod 环境校验 + 类型安全配置门面（fail-fast）
│   ├── common/          # Decimal 精确运算 / sha256 / 幂等 ID
│   ├── db/              # node:sqlite（零原生依赖）· 8 表 · snake→camel 映射层
│   ├── polymarket/      # Gamma API · CLOB 行情 · 订单簿服务（深度走单/占位书检测）· 费率表 · WS
│   ├── llm/             # Anthropic 协议 Provider（流式）· zod 结构化输出 · 无 key 降级
│   ├── research/        # 市场筛选流水线 · 证据检索 · superforecaster 五步法 · prompts
│   ├── decision/        # 校准层（牛顿法+恒等正则）· 规则引擎 · edge 计算 · Kelly 仓位
│   ├── risk/            # kill switch 哨兵 · regime 分档 · 风控引擎（单一入口）
│   ├── execution/       # Broker 接口 · PaperBroker · LiveBroker（物理隔离）· 孪生单
│   ├── forecast/        # Forecast Journal · 结算守护（Gamma 回填 + brier_delta 配对）
│   ├── evolution/       # 评分（brier_delta/luck-z/校准表/阈值扫描）· 复盘 · 策略文件库 · 影子晋升
│   ├── audit/           # SHA-256 hash 链账本 + verify
│   ├── alerting/        # Telegram 告警（可选降级 console）
│   ├── portfolio/       # 组合记账（现金/持仓事务、幂等、回撤锚点）
│   ├── cycle/           # 主循环编排（互斥锁）· 轻触发 · 动态 cron 调度
│   ├── cli/             # 运行过程 CLI 渲染器（分阶段/逐市场/摘要面板）
│   └── status/          # Ops API（/status · /cycle/run · /ops/*）
├── strategy/            # LLM 唯一可编辑策略面（playbook.md append-only）
│   ├── playbook.md      # 策略手册（复盘代理受限追加）
│   ├── params.json      # 人工管辖参数对照（LLM 无权修改）
│   └── proposals/       # LLM 参数建议落盘处（待人工审阅）
├── test/                # 8 套不变量测试（费率/edge/Kelly/风控/评分/撮合/账本/影子晋升）
├── docs/                # 开发计划与进度
└── data/                # 运行时产物（SQLite · kill.switch）——不入库
```

## 测试

```bash
npm test        # 31 个不变量测试，全绿
npm run build   # tsc 零错误
```

测试覆盖的都是**钱的数学**与**防自欺机制**：费率公式、edge 盈亏平衡、Kelly 截断、风控各熔断路径、hash 链防篡改、影子规则统计晋升/退役、深度走单确定性、幂等重放。

---

## 路线图

- [x] M01-M18 全模块实现（一次性交付）
- [x] 31 个不变量测试 + 真实 API 全链路冒烟
- [x] CLI 运行过程渲染 + Telegram 告警
- [ ] P1 影子纸面正式运行（≥6 周数据采集）
- [ ] P0 离线回测接入（Jon-Becker 数据集）
- [ ] 消融实验（去 LLM / 换模型 / 固定市场面 vs 开放发现）
- [ ] P2 小额实盘 + 孪生单偏差报告
- [ ] negRisk 多结果市场支持、事件聚类配对检验自动化

## 已知限制

- Polymarket 国际版按 IP 地域限制访问，部分网络环境需配置 `PROXY_URL`。
- LLM 语义筛选与预测的质量强依赖模型本身；baseline 模式下系统自动退化为 H0 基线（这是特性，不是缺陷）。
- Tavily 免费档有调用配额；无 key 时研究层自动闭卷降级并标注。
- 结算依赖 Gamma 的 `outcomePrices` 判定；极少数争议市场可能有滞后。
- 当前单市场（YES 侧）做多，不做市、不做跨平台套利（相关关系套利见 oracle3 的独立实现）。

## 致谢与参考

架构与实验方法受益于这些公开项目与研究（各自许可证见其仓库）：

- [Polymarket/agents](https://github.com/Polymarket/agents) — 官方 AI Agent 框架（架构骨架参考与反面教训）
- [bennyjo/phil](https://github.com/bennyjo/phil) — 自我改进交易 Agent（影子晋升/孪生单/复盘纪律的出处）
- [YichengYang-Ethan/oracle3-prediction-market-agent](https://github.com/YichengYang-Ethan/oracle3-prediction-market-agent) — 预测市场交易引擎 + MCP（纯函数决策核心/费率兜底/物理隔离范式）
- [alsk1992/CloddsBot](https://github.com/alsk1992/CloddsBot) — 广域 AI 交易终端（风控流水线参考）
- [howdymary/autopredict](https://github.com/howdymary/autopredict) — 自改进框架（诚实校准/晋升统计门槛）
- [Jon-Becker/prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis) — 7210 万笔成交数据集与微观结构实证
- [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) — 实战做市机器人（执行层参考）
- [pmxt-dev/pmxt](https://github.com/pmxt-dev/pmxt) — 预测市场的 CCXT（跨市场接口思路）
- Prediction Arena（arXiv 2604.07355）· LiveTradeBench（arXiv 2511.03628）— LLM 实盘交易评测

## License

MIT
