// test-sheet.js
require('dotenv').config(); // 讓程式可以讀取 .env 檔案
const { google } = require('googleapis');
const path = require('path');

// 這個函式會自動使用 credentials.json 來進行認證
async function main() {
  console.log('正在嘗試連接 Google Sheets API...');

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'credentials.json'), // 指向你的金鑰檔案
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const spreadsheetId = process.env.SPREADSHEET_ID;
  const range = 'Config!A1'; // 我們試著讀取 Config 分頁的 A1 儲存格

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const value = response.data.values ? response.data.values[0][0] : '找不到值';
    console.log('✅ 連接成功！');
    console.log(`在 ${range} 讀取到的值是: ${value}`);
  } catch (err) {
    console.error('❌ 讀取 Google Sheet 時發生錯誤:', err.message);
    console.log('---');
    console.log('請檢查：1. SPREADSHEET_ID是否正確？ 2. 是否已將服務帳號的 email 分享到你的 Sheet？ 3. Google Sheets API 是否已啟用？');
  }
}

main();