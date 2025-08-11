// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const { mainHandler } = require('./handlers');
const { loadConfig } = require('./configLoader'); // 1. 引入讀取器
const cron = require('node-cron'); // 1. 在檔案最上方，引入 node-cron
const utils = require('./utils.js');

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
  // --- 月結排程任務區塊，移動到這裡 ---
  // 2. 在 CONFIG 載入後，才設定排程
  const dayOfMonth = CONFIG.MONTHLY_CLOSING_DAY_OF_MONTH;
  const hour = CONFIG.MONTHLY_CLOSING_HOUR;
  const minute = CONFIG.MONTHLY_CLOSING_MINUTE;

  if (dayOfMonth && hour && minute && 
      !isNaN(dayOfMonth) && !isNaN(hour) && !isNaN(minute)) {
      
      const cronSchedule = `${minute} ${hour} ${dayOfMonth} * *`;
      
      console.log(`✅ 設定月結排程任務，將於每月 ${dayOfMonth} 日 ${hour} 時 ${minute} 分執行 (Cron: ${cronSchedule})。`);
      
      cron.schedule(cronSchedule, async () => {
          const currentTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
          console.log(`[${currentTime}] 觸發月結排程任務，開始執行...`);
          
          try {
              await utils.monthlyClosing(CONFIG); 
          } catch (error) {
              console.error('執行月結排程任務時發生未預期的嚴重錯誤:', error);
              await utils.logSystemEvent({
                  status: '嚴重失敗',
                  message: `排程任務頂層錯誤: ${error.message}`,
              }, CONFIG);
          }
          
      }, {
          scheduled: true,
          timezone: "Asia/Taipei"
      });

  } else {
      console.error('❌ 警告：月結排程設定無效或不完整，任務未啟動。請檢查 Config 工作表中的 MONTHLY_CLOSING... 相關設定。');
  }
  // --- 月結排程任務區塊 END ---

  // 3. 最後才啟動網頁伺服器
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`伺服器正在 port ${port} 上運行...`);
  });
}

startServer(); // 執行啟動函式