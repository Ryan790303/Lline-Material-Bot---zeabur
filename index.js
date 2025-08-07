// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { mainHandler } = require('./handlers');
const { loadConfig } = require('./configLoader'); // 1. 引入讀取器

let CONFIG = {}; // 2. 準備一個變數來存放我們所有的設定

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const app = express();
const client = new line.Client(config);

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(event => handleEvent(event, client))) // <-- 修改處
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event, client) { // <-- 修改處
  if (event.type !== 'message' && event.type !== 'postback') {
    return Promise.resolve(null);
  }

  // 3. 將讀取好的 CONFIG 傳遞給總機
  const replyMessages = await mainHandler(event, client, CONFIG); // <-- 修改處

  if (replyMessages && replyMessages.length > 0) {
    return client.replyMessage(event.replyToken, replyMessages);
  } else {
    return Promise.resolve(null);
  }
}

// 4. 建立一個非同步的啟動函式
async function startServer() {
  // 在伺服器啟動前，先等待設定檔載入完成
  CONFIG = await loadConfig();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`伺服器正在 port ${port} 上運行...`);
  });
}

startServer(); // 執行啟動函式