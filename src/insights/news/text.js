function plain(value,maxLength=1200) {
  const text=typeof value==='string'?value:typeof value?._==='string'?value._:'';
  return text.replace(/<[^>]*>/g,' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\s+/g,' ').trim().slice(0,maxLength);
}

function normalizeText(value) {
  return String(value||'').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\s]+/gu,' ').trim();
}

module.exports={plain,normalizeText};
