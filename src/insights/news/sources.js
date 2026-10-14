const {fail}=require('../contracts');
function searchUrl(query){
  if(typeof query!=='string'||!query.trim()||query.length>300)fail('VALIDATION_ERROR','资讯搜索需要明确的关键词或查询式',400);
  const url=new URL('https://news.google.com/rss/search');
  url.search=new URLSearchParams({q:query.trim(),hl:'en-US',gl:'US',ceid:'US:en'}).toString();return url.href;
}
function normalizeSources(sources){return sources.map(source=>source.kind==='search'?{...source,url:searchUrl(source.query),tier:'secondary',publisher:''}:source);}
module.exports={searchUrl,normalizeSources};
