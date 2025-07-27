// configLoader.js
const sheets = require('./google-sheets-client');

async function loadConfig() {
  console.log('正在讀取設定檔...');
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const range = 'Config!A:B'; // 讀取 A 和 B 兩欄的所有資料

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('在 Config 分頁中找不到任何資料。');
      return {};
    }

    // 將 [key, value] 的陣列，轉換成 { key: value } 的物件
    const config = rows.reduce((acc, row) => {
      if (row[0]) { // 確保 key 不是空的
        acc[row[0]] = row[1];
      }
      return acc;
    }, {});
    
    console.log('✅ 設定檔成功載入！');
    return config;

  } catch (err) {
    console.error('❌ 讀取 Config 設定時發生嚴重錯誤:', err.message);
    // 發生錯誤時回傳一個空物件，避免整個專案崩潰
    return {};
  }
}

module.exports = { loadConfig };