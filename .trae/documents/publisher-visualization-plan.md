# publisher.js 数据可视化网页界面（Express）实现计划

## Summary（概述）

为 [publisher.js](file:///d:/project/iot-demo/publisher.js) 增加一个基于 **Express** 的实时数据可视化网页：
- 在 `publisher.js` 进程内启动一个 Express HTTP 服务（默认端口 `3000`）。
- 服务端保留最近发布的 N 条数据（内存环形缓冲），并通过 **SSE（Server-Sent Events）** 实时推送给浏览器。
- 前端单页仪表盘展示温度 / 湿度实时折线图（Chart.js，CDN 加载）+ 最新值 + 统计信息。
- 保持现有 MQTT 发布逻辑与模拟数据格式完全不变，仅在其基础上旁路新增「记录 + 推送」能力。

## Current State Analysis（现状分析）

| 项 | 现状 |
| --- | --- |
| [publisher.js](file:///d:/project/iot-demo/publisher.js) | 连接 MQTT broker，`connect` 后每 2s 发布一条 `{deviceId, ts, temperature, humidity}` JSON 到 `TOPIC`（默认 `iot/demo/temperature`）。无任何 HTTP/Web 能力。 |
| [subscriber.js](file:///d:/project/iot-demo/subscriber.js) | 订阅同一 topic，仅 `console.log`。本任务不改动。 |
| [package.json](file:///d:/project/iot-demo/package.json) | 依赖仅 `dotenv`、`mqtt`；脚本 `pub` / `sub`。**未安装 express**。 |
| 依赖安装状态 | 仓库根目录**不存在 `node_modules`**，需要执行 `npm install`。 |
| 配置 | 无 `.env` 文件；[.gitignore](file:///d:/project/iot-demo/.gitignore) 已忽略 `.env` 与 `node_modules/`。环境变量通过 `dotenv` + `process.env` 读取。 |

已有约定（需沿用）：`require('dotenv').config()` 置顶；环境变量带 `||` 默认值；日志前缀 `[PUB]` / `[SUB]`；发布数据字段与 `TOPIC` 命名。

## Proposed Changes（改动方案）

### 1. [package.json](file:///d:/project/iot-demo/package.json) — 新增 express 依赖

**What**：在 `dependencies` 中新增 `"express": "^4.21.2"`。
**Why**：用户指定采用 Express 框架；SSE + 静态资源托管均由 Express 提供。
**How**：仅追加一行依赖，不改动现有 `mqtt` / `dotenv` 版本与 `scripts`（`pub` 脚本自动带上 Web 服务，无需新增脚本）。

```json
"dependencies": {
  "dotenv": "^16.0.0",
  "mqtt": "^5.0.0",
  "express": "^4.21.2"
}
```

### 2. [publisher.js](file:///d:/project/iot-demo/publisher.js) — 内嵌 Express + SSE

**What**：在保留原有 MQTT 全部逻辑的前提下，新增：
- Express 应用，托管 `public/` 静态目录；
- `GET /api/history`：返回最近数据点（用于页面首屏回填）；
- `GET /api/stream`：SSE 长连接，实时推送新数据点；
- 内存 `history` 数组（上限 100 条，超出裁剪）；
- `broadcast(point)`：向所有 SSE 客户端推送；
- 在原有 `setInterval` 内、发布成功后，追加 `history.push` + `broadcast`。

**Why**：SSE 为纯 Express/HTTP 实现，**无需新增 WebSocket 依赖**，契合本项目轻量定位；数据来源直接复用 publisher 自身发布的数据（无需额外再订阅 broker）。
**How**（关键代码形态）：

```js
require('dotenv').config();
const mqtt = require('mqtt');
const express = require('express');
const path = require('path');

const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
const topic = process.env.TOPIC || 'iot/demo/temperature';
const webPort = Number(process.env.WEB_PORT) || 3000;
const MAX_POINTS = 100;

const history = [];          // 最近数据点
const sseClients = new Set(); // SSE 连接集合

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/history', (req, res) => {
  res.json({ topic, points: history });
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.listen(webPort, () => {
  console.log(`[WEB] Dashboard: http://localhost:${webPort}`);
});

function broadcast(point) {
  const msg = `data: ${JSON.stringify(point)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

const client = mqtt.connect(url, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
});

client.on('connect', () => {
  console.log('[PUB] Connected:', url);

  setInterval(() => {
    const data = {
      deviceId: 'sensor-001',
      ts: Date.now(),
      temperature: (20 + Math.random() * 5).toFixed(2),
      humidity: (40 + Math.random() * 10).toFixed(2),
    };
    const payload = JSON.stringify(data);
    client.publish(topic, payload, { qos: 0 }, (err) => {
      if (err) {
        console.error('[PUB] Publish error:', err.message);
      } else {
        console.log('[PUB] Sent:', payload);
      }
    });

    // 新增：记录并实时推送
    history.push(data);
    if (history.length > MAX_POINTS) history.shift();
    broadcast(data);
  }, 2000);
});

client.on('error', (err) => console.error('[PUB] Error:', err.message));
```

> 说明：数据生成/发布时机（`connect` 之后、每 2s）与数据字段保持不变，仅在发布后旁路增加记录与推送，不影响原有 MQTT 行为。

### 3. `public/index.html`（新增）— 可视化仪表盘页面

**What**：新增单页仪表盘 `public/index.html`，由 Express 静态托管，访问根路径 `/` 打开。
**Why**：作为独立静态资源由 `express.static` 提供是 Express 的标准做法；相比把大段 HTML 内联进 `publisher.js`，独立文件更清晰、可维护。
**How**（页面能力）：
- 通过 **Chart.js CDN**（`https://cdn.jsdelivr.net/npm/chart.js`）渲染「温度 / 湿度」双折线图；X 轴为时间（`ts`），Y 轴数值。
- 首屏 `fetch('/api/history')` 回填历史数据。
- `new EventSource('/api/stream')` 实时接收新点并追加到图表；超出 100 点自动左移。
- 顶部卡片展示：当前温度、当前湿度、最近更新时间、已接收点数、MQTT topic。
- 连接断开时显示状态提示，`EventSource` 自动重连（配合 `retry: 3000`）。

### 4. 端口/配置约定

- 新增可选环境变量 `WEB_PORT`（默认 `3000`）。
- 复用现有 `MQTT_URL` / `TOPIC` / `MQTT_USERNAME` / `MQTT_PASSWORD`。
- 不新增 `.env` 或 `.env.example` 文件（用户未要求；默认值已足够运行）。

## Assumptions & Decisions（假设与决策）

1. **数据来源 = publisher 自身发布的数据**（而非再订阅 broker）。理由：需求是「为 publisher.js 添加可视化界面」，直接展示其产出最直观，且无需二次订阅、无循环风险。
2. **实时通道采用 SSE 而非 WebSocket**。理由：SSE 仅依赖 Express，无需新增 `socket.io`/`ws` 依赖，实现更轻量，满足单向「服务端 → 浏览器」推送场景。
3. **图表库使用 Chart.js（CDN）**。理由：零本地依赖、体积小、开箱即用的折线图；不引入打包工具（项目当前无构建流程）。
4. **Express 版本锁定 4.x**。理由：生态稳定、API 兼容性好；项目中不存在对 Express 5 特性的需求。
5. **保持 MQTT 发布行为不变**：可视化在 publisher 进程内旁路实现，subscriber.js 与 topic/数据格式均不改动。
6. **不新增文档文件**，不改动 `README.md`（未被要求）。
7. 若本地无 MQTT broker，则 `client.on('connect')` 不触发，因而无数据推送；Web 服务与页面本身仍可正常访问（显示「等待数据」状态）。此为保持原有行为的自然结果，不在本次改动范围内扩展。

## Verification（验证步骤）

1. `npm install` — 安装新增的 `express` 依赖。
2. 启动 MQTT broker（如本地 `mosquitto`，`mqtt://localhost:1883`），或设置 `MQTT_URL` 指向可用 broker。
3. `npm run pub` — 观察控制台输出 `[WEB] Dashboard: http://localhost:3000` 与周期性 `[PUB] Sent: ...`。
4. 浏览器打开 `http://localhost:3000`：
   - 折线图每约 2s 追加一个数据点；
   - 顶部卡片实时更新温度/湿度/时间/计数；
   - 刷新页面后能通过 `/api/history` 回填最近数据。
5. 直接访问 `http://localhost:3000/api/history` 应返回 `{ topic, points: [...] }` JSON。
6. 验证 `npm run sub` 仍能正常收到并打印相同数据（确认原有发布行为未被破坏）。
