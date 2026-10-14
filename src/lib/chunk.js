// chunk.js —— 把数组按固定大小切块

function chunk(arr, size) {
  const n = Math.max(1, Math.floor(size));
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = { chunk };
