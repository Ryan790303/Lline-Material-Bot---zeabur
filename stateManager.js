// stateManager.js

// 這是一個簡單的、存在記憶體中的物件，用來模擬 UserProperties
// 警告：當伺服器重啟時，這裡面的所有資料都會消失。
const userStates = {};

function getProperties(userId) {
  if (!userStates[userId]) {
    userStates[userId] = {};
  }
  return {
    getProperty: (key) => userStates[userId][key] || null,
    setProperty: (key, value) => { userStates[userId][key] = value; },
    deleteAllProperties: () => { userStates[userId] = {}; },
  };
}

module.exports = { getProperties };