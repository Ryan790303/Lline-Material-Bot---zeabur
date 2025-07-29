// google-sheets-client.js
const { google } = require('googleapis');
const path = require('path');

const authConfig = {
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
};

// 判斷當前環境
// 如果在 Zeabur 上，它會讀取 GOOGLE_CREDENTIALS_JSON 這個環境變數
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  console.log('使用來自環境變數的 Google 憑證。');
  authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
} else {
  // 如果是在你的電腦上本地運行，它會繼續使用 credentials.json 檔案
  console.log('使用本地的 credentials.json 檔案。');
  authConfig.keyFile = path.join(__dirname, 'credentials.json');
}

const auth = new google.auth.GoogleAuth(authConfig);
const sheets = google.sheets({ version: 'v4', auth });

module.exports = sheets;