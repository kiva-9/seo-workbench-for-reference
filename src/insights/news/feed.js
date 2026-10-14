const Parser = require('rss-parser');
const {hash} = require('../contracts');
const {checkedUrl} = require('./safe-fetch');
const {plain,normalizeText} = require('./text');
const {publicationDate} = require('./dates');
const {sourceMetadata,filterReport,clusterReports} = require('./curation');

const MAX_FEED_ITEMS=100;
const MAX_RAW_REPORT_BYTES=40000;

function canonicalUrl(raw,base) {
  let url;
  try { url=checkedUrl(new URL(raw,base).href); } catch { return null; }
  for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||['fbclid','gclid','msclkid'].includes(key.toLowerCase()))url.searchParams.delete(key);
  return url.href;
}

async function parseFeed(xml,{source,url=source.url,fetched_at}) {
  if(typeof xml!=='string')throw Object.assign(new Error('NEWS_FEED_INVALID'),{code:'NEWS_FEED_INVALID'});
  const upper=xml.toUpperCase();
  if(upper.includes('<!DOCTYPE')||upper.includes('<!ENTITY'))throw Object.assign(new Error('NEWS_XML_UNSAFE'),{code:'NEWS_XML_UNSAFE'});
  // Preserve raw date strings so an invalid Atom date cannot fail the entire otherwise valid feed.
  const dates=new Set(['pubDate','dc:date','published','updated']);
  const parser=new Parser({xml2js:{valueProcessors:[(value,name)=>dates.has(name)?{_:value}:value]},customFields:{item:[
    ['description','rss_summary'],['summary','atom_summary'],['pubDate','rss_published'],
    ['dc:date','dc_published'],['published','atom_published'],['updated','atom_updated'],
    ['source','rss_source'],
  ]}});
  let feed;
  try { feed=await parser.parseString(xml); } catch { throw Object.assign(new Error('NEWS_FEED_INVALID'),{code:'NEWS_FEED_INVALID'}); }
  const items=Array.isArray(feed.items)?feed.items:[],reports=[];
  let invalid=0;
  for(const item of items.slice(0,MAX_FEED_ITEMS)){
    const title=plain(item.title,500),guid=plain(item.guid||item.id,512);
    const link=item.link||(/^https?:\/\//i.test(guid)?guid:'');
    let originalUrl=null;
    if(link){try { originalUrl=checkedUrl(new URL(link,url).href).href; } catch { /* Unsafe links cannot become original-source links. */ }}
    const canonical=originalUrl?canonicalUrl(originalUrl,url):null;
    if(!title||!originalUrl||originalUrl.length>2000||!canonical||canonical.length>2000){invalid++;continue;}
    // Feed summaries are sufficient; content:encoded and Atom content may contain full articles.
    const summary=plain(item.rss_summary??item.atom_summary??item.summary??'',1200);
    const rawDate=item.atom_published??item.rss_published??item.dc_published;
    const publication=publicationDate(rawDate),published_at=publication.value,updated_at=publicationDate(item.atom_updated).value;
    const date_status=publication.status;
    const dedupe_key='report:'+hash([source.id,guid?'guid':'url',guid||canonical]);
    const reportedPublisher=source.kind==='search'?plain(item.rss_source?._??item.rss_source,160):null;
    const report=sourceMetadata({
      id:'news:'+hash(dedupe_key).slice(0,32),dedupe_key,source_id:source.id,source_name:source.name,
      source_url:source.url,guid:guid||null,url:originalUrl,canonical_url:canonical,title,summary,
      published_at,first_published_at:published_at,first_publication_quality:date_status,publication_precision:publication.precision,
      raw_published_at:publication.raw,first_publication_raw:publication.raw,
      updated_at,date_status,fetched_at,first_fetched_at:fetched_at,
      content_hash:hash({title:normalizeText(title),summary:normalizeText(summary)}),
      ...(reportedPublisher?{reported_publisher:reportedPublisher}:{}),discovery_source:source.kind==='search',
    },source);
    if(Buffer.byteLength(JSON.stringify(report),'utf8')>MAX_RAW_REPORT_BYTES){invalid++;continue;}
    reports.push(report);
  }
  return {reports,received:items.length,invalid,truncated:Math.max(0,items.length-MAX_FEED_ITEMS)};
}

module.exports={MAX_FEED_ITEMS,MAX_RAW_REPORT_BYTES,plain,normalizeText,canonicalUrl,parseFeed,filterReport,clusterReports};
