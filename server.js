const mqtt = require('mqtt');
const express = require('express');
const app = express();
const port = 3000;

// 托管public里面的网页
app.use(express.static('public'));

const MQTT_URL = 'mqtt://127.0.0.1:1883';
const TOPIC = 'iot/demo/temperature';
const client = mqtt.connect(MQTT_URL);

let historyPoints = [];
const MAX_HISTORY = 50;
const streamClients = [];

client.on('connect', () => {
  console.log('MQTT连接成功，订阅主题：', TOPIC);
  client.subscribe(TOPIC);
})

client.on('message', (topic, payload) => {
  try {
    const data = JSON.parse(payload.toString());
    historyPoints.push(data);
    if(historyPoints.length > MAX_HISTORY) historyPoints.shift();
    // 推送给所有网页
    streamClients.forEach(res=>{
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    })
  }catch(e){}
})

// SSE实时流接口，给网页用
app.get('/api/stream', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  streamClients.push(res);
  req.on('close',()=>{
    const idx = streamClients.indexOf(res);
    if(idx>-1) streamClients.splice(idx,1);
  })
})

// 历史数据接口
app.get('/api/history', (req,res)=>{
  res.json({topic:TOPIC, points:historyPoints})
})

app.listen(port, ()=>{
  console.log(`服务启动，访问 http://localhost:${port}`)
})
