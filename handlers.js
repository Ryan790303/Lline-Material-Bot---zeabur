// handlers.js
const { getProperties } = require('./stateManager');
const utils = require('./utils.js');
const formatters = require('./formatters.js');

/**
 * @description 從事件物件中安全地取得文字或 postback data
 * @param {Object} event - LINE 事件物件
 * @returns {string}
 */
function getEventData(event) {
  if (event.type === 'postback') return event.postback.data;
  if (event.type === 'message' && event.message.type === 'text') return event.message.text;
  return '';
}

/**
 * @description 根據圖文選單的頂層指令啟動對應的流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function startFlow(event, token, CONFIG) {
  const userId = event.source.userId;
  const userProperties = getProperties(userId);
  const action = event.postback.data.split('=')[1];
  let replyMessages = [];
  
  switch (action) {
    case 'query': {
      const queryTypes = (CONFIG.QR_QUERY_TYPES || '').split(',');
      const queryButtons = queryTypes.map(type => ({ type: 'action', action: { type: 'postback', label: type, data: `query_type=${encodeURIComponent(type)}` } }));
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_QUERY_TYPE', {}, CONFIG), quickReply: { items: queryButtons } });
      break;
    }
    case 'add': {
      const categoriesRaw = CONFIG.QR_CATEGORIES;
      if (!categoriesRaw) {
        replyMessages.push({ type: 'text', text: '系統錯誤：找不到分類設定。' });
        break;
      }
      userProperties.setProperty('state', 'add_awaiting_category');
      userProperties.setProperty('temp_data', JSON.stringify({}));
      const categories = categoriesRaw.split(',');
      const categoryButtons = categories.map(cat => {
        const [key, value] = cat.split(':');
        return { type: 'action', action: { type: 'postback', label: value || key, data: `add_category=${key}` } };
      });
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_CATEGORY', {}, CONFIG), quickReply: { items: categoryButtons } });
      break;
    }
    case 'inbound':
    case 'outbound': {
      userProperties.setProperty('state', `stock_${action}_awaiting_search_type`);
      const searchTypes = (CONFIG.QR_STOCK_SEARCH_TYPES || '').split(',');
      const searchTypeButtons = searchTypes.map(type => {
        const searchMethod = type === '用品名查詢' ? 'by_name' : 'by_serial';
        return { type: 'action', action: { type: 'postback', label: type, data: `stock_search_type=${searchMethod}` }};
      });
      const cancelLabel = CONFIG.LABEL_CANCEL || '取消';
      searchTypeButtons.push({ type: 'action', action: { type: 'postback', label: cancelLabel, data: 'action=cancel' }});
      const actionText = action === 'inbound' ? '入庫' : '出庫';
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_STOCK_SEARCH', { action: actionText }, CONFIG), quickReply: { items: searchTypeButtons } });
      break;
    }
    case 'edit': {
      const { displayName } = await utils.getUserProfile(userId, token, CONFIG);
      const records = await utils.getUserRecords(displayName, CONFIG);
      replyMessages.push(await formatters.formatUserRecords(records, CONFIG));
      break;
    }
    case 'help': {
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_HELP', {}, CONFIG) });
      break;
    }
    case 'cancel': {
      userProperties.deleteAllProperties();
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_CANCEL_CONFIRM', {}, CONFIG) });
      break;
    }
    default: {
      if (action) {
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('INFO_WIP', { action }, CONFIG) });
      }
      break;
    }
  }
  return replyMessages;
}

/**
 * @description 處理所有「查詢」相關的對話流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function handleQueryFlow(event, token, CONFIG) {
  const userProperties = getProperties(event.source.userId);
  const state = userProperties.getProperty('state');
  const data = getEventData(event);
  let replyMessages = [];
  
  if (!state && event.type === 'postback') {
    const type = decodeURIComponent(data.split('=')[1]);
    let nextState = null;
    
    if (type === '用品名查詢') {
      nextState = 'query_awaiting_name';
      replyMessages.push({'type': 'text', 'text': formatters.getConfigMessage('PROMPT_QUERY_BY_NAME', {}, CONFIG)});
    } else if (type === '用序號查詢') {
      nextState = 'query_awaiting_serial';
      replyMessages.push({'type': 'text', 'text': formatters.getConfigMessage('PROMPT_QUERY_BY_SERIAL', {}, CONFIG)});
    } else if (type === '查詢所有庫存') {
      const allInventory = await utils.getAllInventory(CONFIG);
      replyMessages.push(formatters.formatSearchResults(allInventory, 'query', CONFIG));
    } else if (type === '查我的經手紀錄') {
      const { displayName } = await utils.getUserProfile(event.source.userId, token, CONFIG);
      const records = await utils.getUserRecords(displayName, CONFIG);
      replyMessages.push(await formatters.formatUserRecords(records, CONFIG));
    }
    
    if (nextState) userProperties.setProperty('state', nextState);

  } else if (state && event.type === 'message') {
    let replyMessageObject;
    if (state === 'query_awaiting_name') {
      const searchResults = await utils.searchMaterials(data, CONFIG);
      replyMessageObject = formatters.formatSearchResults(searchResults, 'query', CONFIG);
    } else if (state === 'query_awaiting_serial') {
      const result = await utils.searchMaterialByCompositeKey(data, CONFIG);
      replyMessageObject = result ? formatters.createSingleResultFlex(result, 'query', CONFIG) : { 'type': 'text', 'text': formatters.getConfigMessage('MSG_QUERY_NOT_FOUND', {}, CONFIG) };
    }
    if (replyMessageObject) replyMessages.push(replyMessageObject);
    userProperties.deleteAllProperties();
  }
  return replyMessages;
}

/**
 * @description 處理所有「新增」相關的對話流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function handleAddFlow(event, token, CONFIG) {
  const userProperties = getProperties(event.source.userId);
  const state = userProperties.getProperty('state');
  const eventType = event.type;
  const data = getEventData(event);
  
  let tempData = JSON.parse(userProperties.getProperty('temp_data') || '{}');
  let replyMessages = [];
  let nextState = null;
  const value = eventType === 'postback' ? decodeURIComponent(data.split('=')[1] || '') : data;

  switch (state) {
    case 'add_awaiting_category':
      if (eventType !== 'postback' || !data.startsWith('add_category=')) return [];
      tempData.分類 = value;
      nextState = 'add_awaiting_name';
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_NAME', { category: tempData.分類 }, CONFIG) });
      break;

    case 'add_awaiting_name':
      if (eventType !== 'message') return [];
      tempData.品名 = data;
      nextState = 'add_awaiting_model';
      const modelButtons = [{ type: 'action', action: { type: 'postback', label: '無型號(跳過)', data: 'add_model=' }}];
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_MODEL', { name: tempData.品名 }, CONFIG), quickReply: { items: modelButtons }});
      break;

    case 'add_awaiting_model':
      if (eventType === 'postback' && data.startsWith('add_model=')) {
        tempData.型號 = value;
      } else if (eventType === 'message') {
        tempData.型號 = data;
      } else { return []; }
      nextState = 'add_awaiting_spec';
      const specButtons = [{ type: 'action', action: { type: 'postback', label: '無規格(跳過)', data: 'add_spec=' }}];
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_SPEC', { model: tempData.型號 }, CONFIG), quickReply: { items: specButtons }});
      break;
      
    case 'add_awaiting_spec':
      if (eventType === 'postback' && data.startsWith('add_spec=')) {
        tempData.規格 = value;
      } else if (eventType === 'message') {
        tempData.規格 = data;
      } else { return []; }
      nextState = 'add_awaiting_unit';
      const units = (CONFIG.QR_UNITS || '').split(',').filter(u => u.trim() !== '手動輸入' && u.trim() !== '');
      const unitButtons = units.map(unit => ({ type: 'action', action: { type: 'postback', label: unit, data: `add_unit=${encodeURIComponent(unit)}` } }));
      unitButtons.push({ type: 'action', action: { type: 'postback', label: '手動輸入', data: `add_unit=${encodeURIComponent('手動輸入')}` } });
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_UNIT', { spec: tempData.規格 }, CONFIG), quickReply: { items: unitButtons } });
      break;
      
    case 'add_awaiting_unit':
      if (eventType !== 'postback' || !data.startsWith('add_unit=')) return [];
      if (value === '手動輸入') {
        nextState = 'add_typing_unit';
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_MANUAL_UNIT', {}, CONFIG) });
      } else {
        tempData.單位 = value;
        nextState = 'add_awaiting_quantity';
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_QUANTITY', { unit: tempData.單位 }, CONFIG) });
      }
      break;

    case 'add_typing_unit':
      if (eventType !== 'message' || !data) return [];
      tempData.單位 = data;
      nextState = 'add_awaiting_quantity';
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_ADD_QUANTITY', { unit: tempData.單位 }, CONFIG) });
      break;
      
    case 'add_awaiting_quantity':
      if (eventType !== 'message' || isNaN(data) || data.trim() === '') {
        replyMessages.push({ 'type': 'text', text: formatters.getConfigMessage('ERROR_INVALID_QUANTITY', {}, CONFIG) });
        nextState = 'add_awaiting_quantity';
        break;
      }
      tempData.數量 = data;
      nextState = 'add_awaiting_confirmation';
      const confirmText = formatters.getConfigMessage('PROMPT_ADD_CONFIRM', { category: tempData.分類, name: tempData.品名, model: tempData.型號, spec: tempData.規格, unit: tempData.單位, quantity: tempData.數量 }, CONFIG);
      const confirmActions = (CONFIG.QR_ADD_CONFIRM || '').split(',');
      const confirmButtons = confirmActions.map(action => ({ type: 'action', action: { type: 'postback', label: action, data: `add_confirm=${encodeURIComponent(action)}` } }));
      replyMessages.push({ type: 'text', text: confirmText, quickReply: { items: confirmButtons } });
      break;
      
    case 'add_awaiting_confirmation': {
      if (eventType !== 'postback' || !data.startsWith('add_confirm=')) return [];
      if (value === '確認新增') {
        const isDuplicate = await utils.doesMaterialExist(tempData, CONFIG);
        if (isDuplicate) {
          const errorMessage = formatters.getConfigMessage('ERROR_DUPLICATE_ITEM', { name: tempData.品名, model: tempData.型號, spec: tempData.規格 }, CONFIG);
          replyMessages.push({ type: 'text', text: errorMessage });
        } else {
          tempData.序號 = await utils.generateNewSerial(tempData.分類, CONFIG);
          tempData.類型 = '新增';
          const { displayName } = await utils.getUserProfile(event.source.userId, token, CONFIG);
          await utils.addTransactionRecord(tempData, displayName, CONFIG);
          replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_ADD_SUCCESS', { id: `${tempData.分類}${tempData.序號}` }, CONFIG) });
        }
      } else {
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_CANCEL_CONFIRM', {}, CONFIG) });
      }
      userProperties.deleteAllProperties();
      nextState = null;
      break;
    }
  }

  if (nextState) {
    userProperties.setProperty('state', nextState);
    userProperties.setProperty('temp_data', JSON.stringify(tempData));
  }
  return replyMessages;
}

/**
 * @description 處理所有「入庫/出庫」相關的對話流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function handleStockFlow(event, token, CONFIG) {
  const userProperties = getProperties(event.source.userId);
  const state = userProperties.getProperty('state');
  const eventType = event.type;
  const data = getEventData(event);
  
  let tempData = JSON.parse(userProperties.getProperty('temp_data') || '{}');
  let replyMessages = [];
  let nextState = null;
  const action = state ? state.split('_')[1] : null;

  if (eventType === 'postback') {
    const params = data.split('&').reduce((acc, part) => { const [k, v] = part.split('='); acc[k] = decodeURIComponent(v || ''); return acc; }, {});

    if (params.stock_search_type) {
      nextState = `stock_${action}_awaiting_${params.stock_search_type}_search`;
      const promptKey = params.stock_search_type === 'by_name' ? 'PROMPT_QUERY_BY_NAME' : 'PROMPT_QUERY_BY_SERIAL';
      replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage(promptKey, {}, CONFIG) });
    } 
    else if ('stock_select' in params) {
      const selectedMaterial = await utils.searchMaterialByCompositeKey(params.key, CONFIG);
      if (selectedMaterial) {
        tempData.selectedItem = selectedMaterial;
        tempData.action = params.action;
        nextState = `stock_${params.action}_awaiting_quantity`;
        const actionText = params.action === 'inbound' ? '入庫' : '出庫';
        replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('PROMPT_STOCK_QUANTITY', { name: selectedMaterial.品名, action: actionText }, CONFIG) });
      } else {
        replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('MSG_QUERY_NOT_FOUND', {}, CONFIG) });
        userProperties.deleteAllProperties();
      }
    } 
    else if (params.stock_confirm) {
      if (params.stock_confirm === '確認') {
        const item = tempData.selectedItem;
        const record = {
          分類: item.分類, 序號: item.序號, 品名: item.品名, 型號: item.型號,
          規格: item.規格, 單位: item.單位, 照片: item.照片,
          數量: tempData.action === 'inbound' ? tempData.quantity : -tempData.quantity,
          類型: tempData.action === 'inbound' ? '入庫' : '出庫',
        };
        const { displayName } = await utils.getUserProfile(event.source.userId, token, CONFIG);
        await utils.addTransactionRecord(record, displayName, CONFIG);
        
        const newStockItem = await utils.searchMaterialByCompositeKey(`${item.分類}${item.序號}`, CONFIG);
        const successIcon = tempData.action === 'inbound' ? '✅' : '➡️';
        replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('MSG_STOCK_SUCCESS', { icon: successIcon, action: record.類型, name: item.品名, newStock: newStockItem.庫存, unit: item.單位 }, CONFIG) });
      } else {
        replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('MSG_CANCEL_CONFIRM', {}, CONFIG) });
      }
      userProperties.deleteAllProperties();
    }
  } 
  else if (eventType === 'message' && state) {
    if (state.endsWith('_awaiting_by_name_search') || state.endsWith('_awaiting_by_serial_search')) {
      const searchResults = state.includes('_by_name_') ? await utils.searchMaterials(data, CONFIG) : [await utils.searchMaterialByCompositeKey(data, CONFIG)].filter(Boolean);
      const message = formatters.formatSearchResults(searchResults, action, CONFIG); 
      replyMessages.push(message);
      userProperties.deleteProperty('state');
    } 
    else if (state.endsWith('_awaiting_quantity')) {
      if (isNaN(data) || data.trim() === '' || Number(data) <= 0) {
        replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('ERROR_INVALID_QUANTITY', {}, CONFIG) });
        nextState = state;
      } else {
        const quantity = Number(data);
        const item = tempData.selectedItem;
        if (action === 'outbound' && item.庫存 < quantity) {
          replyMessages.push({ 'type': 'text', 'text': formatters.getConfigMessage('MSG_STOCK_INSUFFICIENT', { name: item.品名, currentStock: item.庫存, unit: item.單位 }, CONFIG) });
          userProperties.deleteAllProperties();
        } else {
          tempData.quantity = quantity;
          nextState = `stock_${action}_awaiting_confirmation`;
          const actionText = action === 'inbound' ? '入庫' : '出庫';
          const confirmText = formatters.getConfigMessage('PROMPT_STOCK_CONFIRM_PROMPT', { action: actionText, name: item.品名, quantity: quantity, unit: item.單位 }, CONFIG);
          const confirmButtons = [
            { type: 'action', action: { type: 'postback', label: `確認${actionText}`, data: 'stock_confirm=確認' }},
            { type: 'action', action: { type: 'postback', label: '取消', data: 'stock_confirm=取消' }}
          ];
          replyMessages.push({ 'type': 'text', 'text': confirmText, 'quickReply': { 'items': confirmButtons } });
        }
      }
    }
  }

  if (nextState) {
    userProperties.setProperty('state', nextState);
    userProperties.setProperty('temp_data', JSON.stringify(tempData));
  } else if (nextState === null) {
    // This is a special case. If nextState is explicitly null, it means we should delete properties.
    // Otherwise, properties are kept (e.g. after a search, waiting for a button click).
    userProperties.deleteAllProperties();
  }
  
  return replyMessages;
}

/**
 * @description 處理所有「修改」相關的對話流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function handleEditFlow(event, token, CONFIG) {
  const userProperties = getProperties(event.source.userId);
  const state = userProperties.getProperty('state');
  const eventType = event.type;
  const data = getEventData(event);
  
  let tempData = JSON.parse(userProperties.getProperty('temp_data') || '{}');
  let replyMessages = [];
  let nextState = null;

  // --- 內部輔助函式區 ---
  function sendNewItemEditMenu(leadingText = '') {
    const confirmText = formatters.getConfigMessage('PROMPT_NEW_ITEM_CHOICE', {
      leadingText: leadingText, name: tempData.newData.品名, model: tempData.newData.型號 || '-',
      spec: tempData.newData.規格 || '-', unit: tempData.newData.單位, quantity: tempData.newData.數量
    }, CONFIG);
    const fieldButtons = [
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_NAME || '修改品名', data: 'edit_field=品名' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_MODEL || '修改型號', data: 'edit_field=型號' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_SPEC || '修改規格', data: 'edit_field=規格' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_UNIT || '修改單位', data: 'edit_field=單位' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_QUANTITY || '修改數量', data: 'edit_field=數量' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_FINISH_EDIT || '✅ 完成修改，儲存', data: 'edit_field=finish' }}
    ];
    replyMessages.push({ type: 'text', text: confirmText, quickReply: { items: fieldButtons } });
  }
  
  function sendStockEditMenu(leadingText = '') {
    const promptText = formatters.getConfigMessage('PROMPT_EDIT_STOCK_CHOICE', {
      leadingText: leadingText, name: tempData.newData.品名,
      type: tempData.newData.類型, quantity: tempData.newData.數量
    }, CONFIG);
    const choiceButtons = [
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_QUANTITY || '修改數量', data: 'edit_stock_choice=quantity' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_EDIT_TYPE || '修改類型', data: 'edit_stock_choice=type' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_FINISH_EDIT || '✅ 完成修改，儲存', data: 'edit_stock_choice=finish' }}
    ];
    replyMessages.push({ type: 'text', text: promptText, quickReply: { items: choiceButtons }});
  }
  
  async function finalizeEdit() {
    const { displayName } = await utils.getUserProfile(event.source.userId, token, CONFIG);
    const finalData = tempData.newData;
    const originalRecord = tempData.originalRecord;
    const rowIndex = tempData.rowIndex;

    if (finalData.類型 === '出庫') {
      const compositeKey = `${finalData.分類}${finalData.序號}`;
      const item = await utils.searchMaterialByCompositeKey(compositeKey, CONFIG);
      const currentStock = item ? item.庫存 : 0;
      const originalEffect = Number(originalRecord[6]);
      const stockAfterVoid = currentStock - originalEffect;
      
      if (stockAfterVoid < finalData.數量) {
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_STOCK_INSUFFICIENT', {name: finalData.品名, currentStock: stockAfterVoid, unit: finalData.單位}, CONFIG) });
        nextState = 'edit_stock_awaiting_choice';
        return;
      }
    }

    let reason = '使用者修改(未變更內容)';
    if (originalRecord[7] === '新增') {
      const original = {品名:originalRecord[2], 型號:originalRecord[3], 規格:originalRecord[4], 單位:originalRecord[5], 數量:originalRecord[6]};
      const changedFields = Object.keys(original).filter(key => String(original[key] || '') !== String(finalData[key] || ''));
      if (changedFields.length > 0) reason = `因【${changedFields.join('、')}】錯誤修改`;
    } else {
      const changedFields = [];
      const originalQty = Math.abs(Number(originalRecord[6]));
      const originalType = originalRecord[7];
      if (originalQty !== finalData.數量) changedFields.push('數量');
      if (originalType !== finalData.類型) changedFields.push('類型');
      if (changedFields.length > 0) reason = `因【${changedFields.join('、')}】錯誤修改`;
    }

    const recordToSave = { ...finalData };
    if (recordToSave.類型 === '出庫') {
      recordToSave.數量 = -Math.abs(recordToSave.數量);
    } else {
      recordToSave.數量 = Math.abs(recordToSave.數量);
    }

    await utils.voidRecordByRowIndex(rowIndex, `由 ${displayName} 修改`, displayName, CONFIG);
    await utils.updateRecordCells(rowIndex, { 10: reason }, CONFIG);
    await utils.addTransactionRecord(recordToSave, displayName, CONFIG);
    
    replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_EDIT_SUCCESS_MODIFY', {}, CONFIG) });
    userProperties.deleteAllProperties();
  }

  if (!state && event.type === 'postback' && data.startsWith('edit_start')) {
    const params = data.split('&').reduce((acc, part) => { const [k, v] = part.split('='); if (v !== undefined) { acc[k] = decodeURIComponent(v); } return acc; }, {});
    const editType = params.type;
    const rowIndex = Number(params.row);
    
    // 為了安全，重新從資料庫讀取一次
    const allRecordsText = await utils.sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: CONFIG.SHEET_NAME_RECORDS });
    const recordData = allRecordsText.data.values[rowIndex - 1];
    
    tempData = {
      originalRecord: recordData,
      rowIndex: rowIndex,
      newData: {
        分類: recordData[0], 序號: recordData[1], 品名: recordData[2], 型號: recordData[3],
        規格: recordData[4], 單位: recordData[5], 數量: Math.abs(Number(recordData[6])), 類型: recordData[7], 照片: recordData[12]
      }
    };

    if (editType === 'new') {
      nextState = 'edit_new_awaiting_choice';
    } else if (editType === 'stock') {
      nextState = 'edit_stock_awaiting_choice';
    }
  }
  else if (state) {
    const value = event.type === 'postback' ? decodeURIComponent(data.split('=')[1] || '') : data;
    
    if (state === 'edit_stock_awaiting_choice') {
      const choice = data.split('=')[1];
      if (choice === 'finish') {
        await finalizeEdit();
      } else if (choice === 'quantity') {
        nextState = 'edit_stock_awaiting_quantity';
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_EDIT_NEW_VALUE', {field: '數量'}, CONFIG) });
      } else if (choice === 'type') {
        nextState = 'edit_stock_awaiting_type';
        const typeButtons = [ { type: 'action', action: { type: 'postback', label: '入庫', data: 'edit_type=入庫' }}, { type: 'action', action: { type: 'postback', label: '出庫', data: 'edit_type=出庫' }} ];
        replyMessages.push({ type: 'text', text: '請選擇新的紀錄類型：', quickReply: { items: typeButtons } });
      }
    }
    else if (state === 'edit_stock_awaiting_quantity') {
      if (isNaN(data) || Number(data) < 0) {
        replyMessages.push({ 'type': 'text', text: formatters.getConfigMessage('ERROR_INVALID_QUANTITY', {}, CONFIG) });
        nextState = state;
      } else {
        tempData.newData.數量 = Number(data);
        nextState = 'edit_stock_awaiting_choice';
      }
    }
    else if (state === 'edit_stock_awaiting_type') {
      tempData.newData.類型 = value;
      nextState = 'edit_stock_awaiting_choice';
    }
    else if (state === 'edit_new_awaiting_choice') {
      const choice = data.split('=')[1];
      if (choice === 'finish') {
        await finalizeEdit();
      } else if (choice === '單位') {
        nextState = 'edit_new_awaiting_unit_choice';
        const units = (CONFIG.QR_UNITS || '').split(',').filter(u => u.trim() !== '手動輸入' && u.trim() !== '');
        const unitButtons = units.map(unit => ({ type: 'action', action: { type: 'postback', label: unit, data: `edit_unit=${encodeURIComponent(unit)}` } }));
        unitButtons.push({ type: 'action', action: { type: 'postback', label: '手動輸入', data: `edit_unit=${encodeURIComponent('手動輸入')}` } });
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_EDIT_SELECT_FIELD', {field: '單位'}, CONFIG), quickReply: { items: unitButtons } });
      } else {
        tempData.fieldToEdit = choice;
        nextState = 'edit_new_awaiting_new_value';
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_EDIT_NEW_VALUE', {field: choice}, CONFIG) });
      }
    }
    else if (state === 'edit_new_awaiting_unit_choice') {
      if (value === '手動輸入') {
        nextState = 'edit_new_awaiting_manual_unit';
        replyMessages.push({ type: 'text', text: formatters.getConfigMessage('PROMPT_MANUAL_UNIT', {}, CONFIG) });
      } else {
        tempData.newData['單位'] = value;
        nextState = 'edit_new_awaiting_choice';
      }
    }
    else if (state === 'edit_new_awaiting_manual_unit') {
      tempData.newData['單位'] = data;
      nextState = 'edit_new_awaiting_choice';
    }
    else if (state === 'edit_new_awaiting_new_value') {
      const fieldToEdit = tempData.fieldToEdit;
      tempData.newData[fieldToEdit] = data;
      delete tempData.fieldToEdit;
      nextState = 'edit_new_awaiting_choice';
    }
  }

  if (nextState === 'edit_new_awaiting_choice') {
    const leadingText = tempData.fieldToEdit ? `「${tempData.fieldToEdit}」已更新。\n\n` : '';
    sendNewItemEditMenu(leadingText);
  } else if (nextState === 'edit_stock_awaiting_choice') {
    sendStockEditMenu('資料已更新。\n');
  }
  
  if (nextState !== undefined) { // allow nextState to be null to clear
    userProperties.setProperty('state', nextState);
    userProperties.setProperty('temp_data', JSON.stringify(tempData));
  }
  if (replyMessages.length > 0) {
    return replyMessages;
  }
  return [];
}

/**
 * @description 處理所有「刪除」相關的對話流程
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function handleDeleteFlow(event, token, CONFIG) {
  const userProperties = getProperties(event.source.userId);
  const state = userProperties.getProperty('state');
  const eventType = event.type;
  const data = getEventData(event);
  
  let tempData = JSON.parse(userProperties.getProperty('temp_data') || '{}');
  let replyMessages = [];
  let nextState = null;

  // 步驟 1: 收到刪除請求，發送二次確認
  if (!state && eventType === 'postback' && data.startsWith('delete_record')) {
    const params = data.split('&').reduce((acc, part) => {
      const [key, value] = part.split('=');
      if (value !== undefined) { acc[key] = decodeURIComponent(value); }
      return acc;
    }, {});
    
    const rowIndex = Number(params.row);
    
    // 為了讓確認訊息更友善，讀取該筆紀錄的內容
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const sheetName = CONFIG.SHEET_NAME_RECORDS || '出入庫記錄';
    const range = `${sheetName}!A${rowIndex}:H${rowIndex}`; // 只需讀到 H 欄(類型)即可
    const response = await utils.sheets.spreadsheets.values.get({ spreadsheetId, range });
    const recordData = response.data.values[0];
    const recordName = recordData[2]; // 品名
    const recordType = recordData[7]; // 類型

    tempData.rowIndex = rowIndex;
    nextState = 'delete_awaiting_confirmation';
    
    const confirmText = formatters.getConfigMessage('PROMPT_DELETE_CONFIRM', { name: recordName, type: recordType }, CONFIG);
    const confirmButtons = [
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_CONFIRM_DELETE || '⚠️ 確認刪除', data: 'delete_confirm=yes' }},
      { type: 'action', action: { type: 'postback', label: CONFIG.LABEL_CANCEL || '取消', data: 'delete_confirm=no' }}
    ];
    replyMessages.push({ type: 'text', text: confirmText, quickReply: { items: confirmButtons }});
  } 
  // 步驟 2: 處理使用者的確認結果
  else if (state === 'delete_awaiting_confirmation') {
    const choice = data.split('=')[1];
    
    if (choice === 'yes') {
      const rowIndex = tempData.rowIndex;
      const { displayName } = await utils.getUserProfile(event.source.userId, token, CONFIG);
      const reason = CONFIG.DEFAULT_DELETE_REASON || '資料錯誤';
      await utils.voidRecordByRowIndex(rowIndex, reason, displayName, CONFIG);
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_DELETE_SUCCESS', {}, CONFIG) });
    } else {
      replyMessages.push({ type: 'text', text: formatters.getConfigMessage('MSG_CANCEL_CONFIRM', {}, CONFIG) });
    }
    
    userProperties.deleteAllProperties();
  }

  if (nextState) {
    userProperties.setProperty('state', nextState);
    userProperties.setProperty('temp_data', JSON.stringify(tempData));
  }
  return replyMessages;
}

/**
 * @description 主處理器，負責所有邏輯的路由。
 * @param {Object} event - LINE 事件物件
 * @param {string} token - Channel Access Token
 * @param {Object} CONFIG - 從試算表讀取的設定物件
 * @returns {Array} - 一個包含要回覆訊息物件的陣列
 */
async function mainHandler(event, token, CONFIG) {
  const userId = event.source.userId;
  const userProperties = getProperties(userId);
  const state = userProperties.getProperty('state');
  const eventType = event.type;
  
  // 優先處理會重置流程的主選單指令
  if (eventType === 'postback' && event.postback.data.startsWith('action=')) {
    userProperties.deleteAllProperties();
    return await startFlow(event, token, CONFIG);
  }
  
  // 根據 state 或 postback 指令判斷目前屬於哪個流程
  let flowType = null;
  if (state) {
    flowType = state.split('_')[0];
  } else if (eventType === 'postback') {
    const postbackPrefix = event.postback.data.split('_')[0];
    if (['query', 'add', 'stock', 'edit', 'delete'].includes(postbackPrefix)) {
      flowType = postbackPrefix;
    }
  }

  console.log(`路由判斷結果 flowType: ${flowType} for user: ${userId}`);

  // 根據流程類型，將事件轉交給對應的處理器
  switch (flowType) {
    case 'query':
      return await handleQueryFlow(event, token, CONFIG);
    case 'add':
      return await handleAddFlow(event, token, CONFIG);
    case 'stock':
      return await handleStockFlow(event, token, CONFIG);
    case 'edit':
      return await handleEditFlow(event, token, CONFIG);
    case 'delete':
      return await handleDeleteFlow(event, token, CONFIG);
    default:
      console.log('沒有對應的 flowType，不進行任何回覆。');
      return [];
  }
}

module.exports = { mainHandler };