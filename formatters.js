// formatters.js
const utils = require('./utils.js'); // 引入我們所有的資料工具函式

/**
 * @description 從 CONFIG 物件中，安全地取得訊息文案、替換變數並修正換行符號。
 */
function getConfigMessage(key, replacements = {}, CONFIG) {
  let message = CONFIG[key] || `[錯誤:找不到設定 ${key}]`;
  for (const placeholder in replacements) {
    message = message.replace(new RegExp(`{${placeholder}}`, 'g'), replacements[placeholder]);
  }
  return message.replace(/\\n/g, '\n');
}

/**
 * @description 將 Google Drive 的分享網址或檔案ID，轉換成可以直接顯示的圖片網址。
 */
function convertGoogleDriveFileIdToDirectUrl(urlOrId, CONFIG) {
  const defaultUrl = CONFIG.DEFAULT_IMAGE_URL || 'https://via.placeholder.com/500x300.png?text=No+Image';
  if (!urlOrId || typeof urlOrId !== 'string' || urlOrId.trim() === '') {
    return defaultUrl;
  }
  
  let fileId = urlOrId;
  if (urlOrId.includes('drive.google.com/file/d/')) {
    fileId = urlOrId.split('/d/')[1].split('/')[0];
  } else if (urlOrId.includes('drive.google.com/open?id=')) {
    fileId = urlOrId.split('id=')[1].split('&')[0];
  }

  if (fileId && fileId.length > 20 && !fileId.includes('http')) {
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  }
  if (urlOrId.startsWith('http')) {
    return urlOrId;
  }
  return defaultUrl;
}

/**
 * @description [輔助] 建立單張物料資訊的 Flex Message 卡片。
 */
function createSingleResultFlex(item, context = 'query', CONFIG) {
  const compositeKey = `${item.分類}${item.序號}`;
  const bubble = {
    "type": "bubble", "hero": { "type": "image", "url": convertGoogleDriveFileIdToDirectUrl(item.照片, CONFIG), "size": "full", "aspectRatio": "20:13", "aspectMode": "fit", "backgroundColor": "#EEEEEE" },
    "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [
        { "type": "text", "text": item.品名, "weight": "bold", "size": "xl", "wrap": true },
        { "type": "box", "layout": "vertical", "margin": "lg", "spacing": "sm", "contents": [
            { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "【庫存】", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": `${String(item.庫存)} ${item.單位}`, "wrap": true, "color": "#666666", "size": "md", "flex": 5, "weight": "bold" } ]},
            { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "【序號】", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": compositeKey, "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]},
            { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "【型號】", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": String(item.型號 || '-'), "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]},
            { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "【規格】", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": String(item.規格 || '-'), "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]}
          ]
        }
      ]
    },
    "footer": { "type": "box", "layout": "horizontal", "spacing": "sm", "contents": [
        { "type": "button", "style": "primary", "color": "#4CAF50", "height": "sm", "action": { "type": "postback", "label": "入庫", "data": `stock_select&action=inbound&key=${compositeKey}` }},
        { "type": "button", "style": "primary", "color": "#F44336", "height": "sm", "action": { "type": "postback", "label": "出庫", "data": `stock_select&action=outbound&key=${compositeKey}` }}
      ]
    }
  };
  return { "type": "flex", "altText": `查詢結果：${item.品名}`, "contents": bubble };
}

/**
 * @description [輔助] 建立輪播 Flex Message。
 */
function createCarouselFlex(items, context = 'query', CONFIG) {
  const bubbles = items.map(item => createSingleResultFlex(item, context, CONFIG).contents);
  return { "type": "flex", "altText": `找到了 ${items.length} 筆相關結果`, "contents": { "type": "carousel", "contents": bubbles } };
}

/**
 * @description 主要的結果格式化函式。
 */
function formatSearchResults(results, context = 'query', CONFIG) {
  if (!results || results.length === 0) {
    return { 'type': 'text', 'text': getConfigMessage('MSG_QUERY_NOT_FOUND', {}, CONFIG) };
  }

  if (results.length > 1) {
    results.sort((a, b) => {
      const categoryA = a.分類 || ''; 
      const categoryB = b.分類 || '';
      const serialA = a.序號 || '';
      const serialB = b.序號 || '';
      const categoryCompare = categoryA.localeCompare(categoryB);
      if (categoryCompare !== 0) return categoryCompare;
      return serialA.localeCompare(serialB);
    });
  }

  if (results.length === 1) {
    return createSingleResultFlex(results[0], context, CONFIG);
  } else if (results.length > 1 && results.length <= 12) {
    return createCarouselFlex(results, context, CONFIG);
  } else {
    let replyText = getConfigMessage('INFO_TOO_MANY_RESULTS_HEADER', { count: results.length }, CONFIG);
    results.forEach(item => {
      replyText += getConfigMessage('TEMPLATE_ALL_INVENTORY_ITEM', {
        id: `${item.分類}${item.序號}`, name: item.品名, model: item.型號 || '-',
        spec: item.規格 || '-', stock: item.庫存, unit: item.單位
      }, CONFIG);
    });
    return { 'type': 'text', 'text': replyText.trim() };
  }
}

/**
 * @description 將個人經手紀錄格式化為 Flex Message Carousel。
 */
async function formatUserRecords(records, CONFIG) {
  if (!records || records.length === 0) {
    return { 'type': 'text', 'text': getConfigMessage('INFO_NO_RECORDS', {}, CONFIG) };
  }

  const materialsMap = await utils.getInventoryMap(CONFIG);

  const bubbles = records.map(recordInfo => {
    const record = recordInfo.data;
    const rowIndex = recordInfo.index;
    const compositeKey = `${record[0]}${record[1]}`;
    const material = materialsMap.get(compositeKey);
    const photoUrl = material ? material.照片 : '';
    
    const recordType = String(record[7]);
    const quantity = String(Math.abs(Number(record[6])));
    const unit = String(record[5]);
    const productName = String(record[2]);
    const model = String(record[3] || '-');
    const spec = String(record[4] || '-');
    // 使用 Node.js 的標準方法來格式化日期
    const timestamp = record[11];
    const status = record[8];

    let editButtonLabel = '';
    let editButtonData = '';
    if (recordType === '新增') {
      editButtonLabel = '修改整筆資料';
      editButtonData = `edit_start&type=new&row=${rowIndex}`;
    } else if (recordType === '入庫' || recordType === '出庫') {
      editButtonLabel = '修改數量/類型';
      editButtonData = `edit_start&type=stock&row=${rowIndex}`;
    }

    const bubble = {
      "type": "bubble",
      "hero": { "type": "image", "url": convertGoogleDriveFileIdToDirectUrl(photoUrl, CONFIG), "size": "full", "aspectRatio": "20:13", "aspectMode": "fit", "backgroundColor": "#EEEEEE" },
      "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [
          ...(status === CONFIG.STATUS_VOID ? [{ "type": "text", "text": "⚠️ 這是一筆已作廢的舊紀錄", "color": "#FF5555", "size": "sm", "weight": "bold", "margin": "md", "wrap": true }] : []),
          { "type": "text", "text": productName, "weight": "bold", "size": "lg", "wrap": true },
          { "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm", "contents": [
              { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "型號", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": model, "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]},
              { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "規格", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": spec, "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]},
              { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "類型", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": recordType, "wrap": true, "color": "#666666", "size": "sm", "flex": 5, "weight": "bold" } ]},
              { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "數量", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": `${quantity} ${unit}`, "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]},
              { "type": "box", "layout": "baseline", "spacing": "sm", "contents": [ { "type": "text", "text": "時間", "color": "#aaaaaa", "size": "sm", "flex": 2 }, { "type": "text", "text": timestamp, "wrap": true, "color": "#666666", "size": "sm", "flex": 5 } ]}
            ]
          }
        ]
      }
    };

    if (status !== CONFIG.STATUS_VOID) {
      const buttons = [];
      if (editButtonLabel) {
        buttons.push({ "type": "button", "style": "primary", "color": "#5E81AC", "height": "sm", "action": { "type": "postback", "label": editButtonLabel, "data": editButtonData } });
      }
      buttons.push({ "type": "button", "style": "primary", "color": "#ff0000ff", "height": "sm", "action": { "type": "postback", "label": "刪除", "data": `delete_record&row=${rowIndex}` }
      });
      bubble.footer = { "type": "box", "layout": "horizontal", "spacing": "sm", "contents": buttons };
    }
    
    return bubble;
  });

  return { "type": "flex", "altText": `這是您最近的 ${records.length} 筆經手紀錄`, "contents": { "type": "carousel", "contents": bubbles } };
}

module.exports = {
  getConfigMessage,
  convertGoogleDriveFileIdToDirectUrl,
  createSingleResultFlex,
  createCarouselFlex,
  formatSearchResults,
  formatUserRecords,
};