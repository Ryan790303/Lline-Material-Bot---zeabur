// utils.js
const sheets = require('./google-sheets-client');
const NodeCache = require('node-cache');
const axios = require('axios');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat'); // 引入客製化格式解析插件
dayjs.extend(customParseFormat);
const line = require('@line/bot-sdk');

// --- 修改處 START ---
const { google } = require('googleapis');

// 建立並設定 OAuth2 用戶端
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/oauth2callback' // 此處的重新導向 URI 僅為建立物件所需，不會在伺服器端被使用
);
// 設定我們儲存好的 Refresh Token，讓用戶端可以自動更新 Access Token
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

// 初始化一個使用 OAuth 驗證的 Drive 服務
const drive = google.drive({ version: 'v3', auth: oauth2Client });
// --- 修改處 END ---

// 建立一個快取實例，stdTTL 是標準的過期秒數 (5 分鐘)
const appCache = new NodeCache({ stdTTL: 300 });

// --- 庫存讀取相關函式 ---
async function getInventoryMap(CONFIG) {
  const cacheKey = CONFIG.CACHE_KEY_INVENTORY || 'inventory_map';
  const cachedData = appCache.get(cacheKey);
  if (cachedData) {
    console.log('從快取讀取庫存資料...');
    return cachedData;
  }

  console.log('快取未命中，從試算表讀取庫存資料...');
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
  
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log(`在 ${sheetName} 分頁中找不到任何資料。`);
      return new Map();
    }
    
    const materialsMap = new Map();
    const statusValid = CONFIG.STATUS_VALID || '有效';

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length > 8 && row[8] === statusValid) {
        const compositeKey = `${row[0]}${row[1]}`;
        if (!materialsMap.has(compositeKey)) {
          materialsMap.set(compositeKey, {
            分類: row[0], 序號: row[1], 品名: row[2], 型號: row[3], 規格: row[4],
            單位: row[5], 庫存: 0, 照片: (row.length > 12 ? row[12] : '')
          });
        }
        materialsMap.get(compositeKey).庫存 += Number(row[6] || 0);
      }
    }
    
    const expiration = Number(CONFIG.CACHE_EXPIRATION_INVENTORY) || 300;
    appCache.set(cacheKey, materialsMap, expiration);
    console.log(`庫存資料已計算完畢並存入快取 (有效期: ${expiration}秒)。`);

    return materialsMap;
  } catch (err) {
    console.error(`讀取 ${sheetName} 資料時發生錯誤:`, err.message);
    return new Map();
  }
}

async function searchMaterials(query, CONFIG) {
  const materialsMap = await getInventoryMap(CONFIG);
  const normalizedQuery = query.toLowerCase().replace(/\s/g, '');
  if (!normalizedQuery) return [];

  const results = [];
  for (const material of materialsMap.values()) {
    const normalizedName = material.品名.toLowerCase().replace(/\s/g, '');
    if (normalizedName.includes(normalizedQuery)) {
      results.push(material);
    }
  }
  return results;
}

async function searchMaterialByCompositeKey(compositeKey, CONFIG) {
  const materialsMap = await getInventoryMap(CONFIG);
  return materialsMap.get(compositeKey.toUpperCase()) || null;
}

async function getAllInventory(CONFIG) {
  const materialsMap = await getInventoryMap(CONFIG);
  const allMaterials = Array.from(materialsMap.values());
  return allMaterials;
}

async function doesMaterialExist(materialData, CONFIG) {
  const materialsMap = await getInventoryMap(CONFIG);
  const { 品名, 型號, 規格 } = materialData;

  for (const existingMaterial of materialsMap.values()) {
    if (existingMaterial.品名 === 品名 &&
        existingMaterial.型號 === (型號 || '') &&
        existingMaterial.規格 === (規格 || '')) {
      return true;
    }
  }
  return false;
}

// --- 使用者讀取相關函式 ---
async function getUsersMap(CONFIG) {
  try {
    const cacheKey = CONFIG.CACHE_KEY_USERS || 'users_map';
    const cachedData = appCache.get(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    console.log('快取未命中，從 Users 分頁讀取資料...');
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_USERS || 'Users';
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName });
    
    const rows = response.data.values || [];
    const usersMap = new Map();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0]) usersMap.set(rows[i][0], rows[i][1]);
    }

    const expiration = Number(CONFIG.CACHE_EXPIRATION_USERS) || 3600;
    appCache.set(cacheKey, usersMap, expiration);
    return usersMap;
  } catch (err) {
    console.error(`讀取 ${CONFIG.SHEET_NAME_USERS || 'Users'} 資料時發生錯誤:`, err.message);
    return new Map();
  }
}

async function getUserProfile(userId, client, CONFIG) {
  try {
    const usersMap = await getUsersMap(CONFIG);
    if (usersMap.has(userId)) {
      return { displayName: usersMap.get(userId) };
    }

    console.log('新使用者，開始呼叫 LINE Profile API...');
    const token = client.config.channelAccessToken;
    const response = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    
    const profile = response.data;
    const displayName = profile.displayName;

    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_USERS || 'Users';
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: sheetName,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[userId, displayName]] },
    });
    
    appCache.del(CONFIG.CACHE_KEY_USERS || 'users_map');
    console.log(`新使用者 ${displayName} 已成功寫入資料庫。`);
    
    return profile;
  } catch (err) {
    console.error("Get User Profile 失敗: " + err.message);
    return { displayName: CONFIG.DEFAULT_UNKNOWN_USER || '未知使用者' };
  }
}

async function getUserRecords(userName, CONFIG) {
  try {
    const limit = Number(CONFIG.RECORDS_FETCH_LIMIT) || 5;
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetName });
    const rows = response.data.values || [];
    
    const userRecords = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length > 10 && rows[i][10] === userName) {
        userRecords.push({ index: i + 1, data: rows[i] });
      }
    }

    // --- 修改處 START ---
    // 定義一個符合您試算表格式的樣板
    // YYYY: 四位數年, M: 月, D: 日
    // A: 上午/下午, hh: 12小時制的小時
    const customTimeFormat = 'YYYY/M/D A h:mm:ss';
    
    // 使用 dayjs 和我們定義的格式樣板來進行精準排序
    userRecords.sort((a, b) => {
      return dayjs(b.data[11], customTimeFormat) - dayjs(a.data[11], customTimeFormat);
    });
    // --- 修改處 END ---
    
    return userRecords.slice(0, limit);
  } catch (err) {
    console.error("讀取個人紀錄時發生錯誤: " + err.message);
    return [];
  }
}

// --- 新增的資料寫入相關函式 ---

/**
 * @description 清除庫存快取
 */
function clearInventoryCache(CONFIG) {
  const cacheKey = CONFIG.CACHE_KEY_INVENTORY || 'inventory_map';
  appCache.del(cacheKey);
  console.log('庫存快取已清除。');
}

/**
 * @description 產生一個新的、不重複的物料序號
 */
async function generateNewSerial(category, CONFIG) {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:I` });
    
    const rows = response.data.values || [];
    let maxSerial = 0;
    const statusVoid = CONFIG.STATUS_VOID || '已作廢';

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // A欄(索引0)是分類，I欄(索引8)是狀態
      if (row.length > 8 && row[0] === category && row[8] !== statusVoid) {
        const currentSerial = parseInt(row[1], 10);
        if (currentSerial > maxSerial) {
          maxSerial = currentSerial;
        }
      }
    }
    return (maxSerial + 1).toString().padStart(3, '0');
  } catch (err) {
    console.error("產生新序號時發生錯誤: " + err.message);
    return "ERROR";
  }
}

/**
 * @description 將一筆新的交易紀錄寫入資料庫
 */
async function addTransactionRecord(recordData, userName, CONFIG) {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
    const timestamp = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const newRow = [
      recordData.分類,
      `'${recordData.序號}`, // 序號維持文字格式
      recordData.品名,
      recordData.型號 ? `'${recordData.型號}` : '', // 型號強制為文字格式
      recordData.規格 ? `'${recordData.規格}` : '', // 規格強制為文字格式
      recordData.單位,
      Number(recordData.數量),
      recordData.類型,
      CONFIG.STATUS_VALID || '有效',
      '',
      userName,
      timestamp,
      recordData.照片 || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: sheetName,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] },
    });
    
    clearInventoryCache(CONFIG);
  } catch (err) {
    console.error("寫入新紀錄時發生錯誤: " + err.message);
  }
}

/**
 * @description 作廢一筆指定列的紀錄
 */
async function voidRecordByRowIndex(rowIndex, reason, userName, CONFIG) {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
    const range = `${sheetName}!I${rowIndex}:L${rowIndex}`;
    const timestamp = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
    const values = [[
      CONFIG.STATUS_VOID || '已作廢', // I欄: 狀態
      reason,                        // J欄: 修改原因
      userName,                      // K欄: 來源名稱
      timestamp                      // L欄: 時間 (使用格式化後的 timestamp)
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });

    clearInventoryCache(CONFIG);
  } catch (err) {
    console.error(`作廢第 ${rowIndex} 列紀錄時發生錯誤: ` + err.message);
  }
}

/**
 * @description 通用的儲存格更新工具
 */
async function updateRecordCells(rowIndex, updateObject, CONFIG) {
  try {
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
    
    const data = Object.keys(updateObject).map(colIndex => {
      const colLetter = String.fromCharCode(64 + Number(colIndex));
      return {
        range: `${sheetName}!${colLetter}${rowIndex}`,
        values: [[updateObject[colIndex]]]
      };
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data
      }
    });
  } catch (err) {
    console.error(`更新第 ${rowIndex} 列儲存格時發生錯誤: ` + err.message);
  }
}

/**
 * @description 接收 LINE 的圖片 messageId，下載後上傳至 Google Drive，並回傳公開網址
 * @param {line.Client} lineClient - 已初始化的 LINE Client 物件
 * @param {string} messageId - 來自 LINE 事件的圖片 message ID
 * @returns {Promise<string|null>} 成功時回傳公開的圖片網址，失敗時回傳 null
 */
async function uploadImageToDrive(lineClient, messageId) {
  try {
    console.log(`準備從 LINE 下載圖片 (ID: ${messageId})...`);
    const imageStream = await lineClient.getMessageContent(messageId);
    
    console.log('圖片下載完成，準備上傳至 Google Drive...');
    const response = await drive.files.create({
      supportsAllDrives: true, // 確保支援共用雲端硬碟
      requestBody: {
        name: `${messageId}.jpg`,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: 'image/jpeg',
        body: imageStream,
      },
      fields: 'id' 
    });

    const fileId = response.data.id;
    console.log(`✅ 檔案成功上傳至 Google Drive，File ID: ${fileId}`);
    
    // 將檔案權限設定為公開可讀
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      }
    });
    console.log('✅ 檔案權限已設定為公開。');

    const publicUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
    return publicUrl;

  } catch (error) {
    console.error('uploadImageToDrive 函式發生錯誤:', error.message);
    return null; // 發生錯誤時回傳 null
  }
}

/**
 * @description 將系統事件記錄到 Google Sheets 的 '系統日誌' 分頁
 * @param {object} eventData - 包含 { status, message } 的物件
 * @param {object} CONFIG - 全域設定物件
 */
async function logSystemEvent(eventData, CONFIG) {
  try {
    const logSheetName = CONFIG.SHEET_NAME_LOGS || '系統日誌';
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const newRow = [
      timestamp,
      eventData.status || '資訊',
      eventData.message || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: logSheetName,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] },
    });
  } catch (err) {
    // 如果連寫入日誌都失敗，只能在後台 console 印出錯誤
    console.error(`寫入系統日誌時發生嚴重錯誤:`, err.message);
    console.error('原始日誌內容:', eventData);
  }
}

/**
 * @description 執行每月庫存結轉的核心函式
 */
async function monthlyClosing(CONFIG) {
  const recordsSheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';

  try {
    // --- 1. 準備工作與安全性檢查 ---
    const lastMonth = dayjs().subtract(1, 'month');
    const backupSheetName = lastMonth.format('YYYY年M月記錄');

    console.log(`月結任務：準備備份 ${recordsSheetName} 至 ${backupSheetName}`);
    
    // 取得所有工作表，檢查備份是否已存在
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID });
    const sheetExists = spreadsheetInfo.data.sheets.some(s => s.properties.title === backupSheetName);

    if (sheetExists) {
      throw new Error(`備份分頁 ${backupSheetName} 已存在，本月月結可能已執行過，任務中止。`);
    }

    // 讀取當前所有出入庫紀錄
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: recordsSheetName });
    const allRecords = response.data.values || [];

    if (allRecords.length <= 1) { // 只有標題列或沒有任何資料
      await logSystemEvent({ status: '資訊', message: `月結任務中止：${recordsSheetName} 中沒有需要結轉的資料。` }, CONFIG);
      console.log(`月結任務：${recordsSheetName} 中沒有資料，任務提前結束。`);
      return;
    }
    
    const headerRow = allRecords[0];
    const dataRows = allRecords.slice(1);

    // --- 2. 備份 ---
    console.log(`月結任務：正在建立備份分頁 ${backupSheetName}...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: backupSheetName } } }] },
    });

    console.log(`月結任務：正在將 ${dataRows.length} 筆紀錄寫入備份分頁...`);
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${backupSheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: allRecords },
    });

    // --- 3. 統整 (計算月底庫存) ---
    console.log('月結任務：正在計算月底庫存...');
    const materialsMap = new Map();
    const statusValid = CONFIG.STATUS_VALID || '有效';

    for (const row of dataRows) {
      if (row.length > 8 && row[8] === statusValid) {
        const compositeKey = (`${row[0]}${row[1]}`).toUpperCase();
        if (!materialsMap.has(compositeKey)) {
          materialsMap.set(compositeKey, {
            分類: row[0], 序號: row[1], 品名: row[2], 型號: row[3], 規格: row[4],
            單位: row[5], 庫存: 0, 照片: (row.length > 12 ? row[12] : '')
          });
        }
        materialsMap.get(compositeKey).庫存 += Number(row[6] || 0);
      }
    }

    // --- 4. 統整 (清空並寫入期初庫存) ---
    console.log('月結任務：正在清空當前紀錄分頁...');
    // getSheetId 是一個新的輔助函式，我們需要建立它
    const sheetId = spreadsheetInfo.data.sheets.find(s => s.properties.title === recordsSheetName).properties.sheetId;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SPREADSHEET_ID,
      resource: { requests: [{ deleteRange: {
        range: { sheetId: sheetId, startRowIndex: 1 }, // 從第二行開始刪
        shiftDimension: 'ROWS'
      }}]},
    });

    console.log('月結任務：正在寫入新月份的期初庫存...');
    const openingBalanceRows = [];
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    for (const item of materialsMap.values()) {
      if (item.庫存 !== 0) { // 只結轉有庫存的品項
        const newRow = [
          item.分類, `'${item.序號}`, item.品名,
          item.型號 ? `'${item.型號}` : '', item.規格 ? `'${item.規格}` : '', item.單位,
          item.庫存, '上月結轉', statusValid, // 類型設定為 "上月結轉"
          '系統月結', '系統', timestamp, item.照片 || ''
        ];
        openingBalanceRows.push(newRow);
      }
    }

    if (openingBalanceRows.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: recordsSheetName,
        valueInputOption: 'USER_ENTERED',
        resource: { values: openingBalanceRows },
      });
    }
    
    // --- 5. 清除快取並記錄成功日誌 ---
    clearInventoryCache(CONFIG);
    const successMessage = `月結成功執行。備份分頁：${backupSheetName}。共結轉 ${openingBalanceRows.length} 筆期初庫存。`;
    await logSystemEvent({ status: '成功', message: successMessage }, CONFIG);
    console.log(`月結任務：${successMessage}`);

  } catch (error) {
    console.error('月結流程發生嚴重錯誤:', error.message);
    await logSystemEvent({ status: '失敗', message: `月結流程錯誤: ${error.message}` }, CONFIG);
  }
}

// 將所有函式匯出
module.exports = {
  sheets,
  getInventoryMap,
  searchMaterials,
  searchMaterialByCompositeKey,
  getAllInventory,
  doesMaterialExist,
  getUsersMap,
  getUserProfile,
  getUserRecords,
  clearInventoryCache,
  generateNewSerial,
  addTransactionRecord,
  voidRecordByRowIndex,
  updateRecordCells,
  uploadImageToDrive,
  logSystemEvent, // <-- !! 加上這一行
  monthlyClosing, // <-- !! 加上這一行
};