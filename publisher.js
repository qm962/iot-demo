require('dotenv').config();
const mqtt = require('mqtt');
const express = require('express');
const path = require('path');

const url = process.env.MQTT_URL || 'mqtt://localhost:1883';
const topic = process.env.TOPIC || 'iot/demo/temperature';
const webPort = Number(process.env.WEB_PORT) || 3000;
const MAX_POINTS = 100;

// 最近数据点缓存 + SSE 客户端集合
const history = [];
const sseClients = new Set();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 首屏回填最近数据
app.get('/api/history', (req, res) => {
  res.json({ topic, points: history });
});

// SSE 实时推送
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

  // 模拟设备上报温度
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

    // 记录并实时推送到可视化网页
    history.push(data);
    if (history.length > MAX_POINTS) history.shift();
    broadcast(data);
  }, 2000);
});

client.on('error', (err) => console.error('[PUB] Error:', err.message));
