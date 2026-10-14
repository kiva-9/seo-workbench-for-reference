const fs=require('node:fs');
const path=require('node:path');
const express=require('express');

function scriptJson(value) {
  // JSON 不是可执行脚本；仍须转义 HTML 的结束标签及行分隔符。
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
}

module.exports=function createFrontend(config) {
  const router=express.Router();
  const version=/^[a-f0-9]{40}$/.test(config.DEPLOYMENT_SHA||'')?config.DEPLOYMENT_SHA:null;
  const htmlPath=path.join(config.PUBLIC_DIR,'index.html');
  const renderTemplate=()=>fs.readFileSync(htmlPath,'utf8').replace(/(src|href)="\.\/([^"]+)"/g,
    (_,attribute,file)=>`${attribute}="${version?'/assets/'+version:''}/${file}"`);
  const releaseHtml=version?renderTemplate():null;
  router.get(['/', '/index.html'],(req,res)=>{
    const user=req.user?{...req.user,logout_url:req.logoutUrl}:null;
    const html=(releaseHtml||renderTemplate()).replace('<!-- app-bootstrap -->',
      `<script type="application/json" id="app-bootstrap">${scriptJson({user})}</script>`);
    // 身份来自本次已验证的请求；任何共享或浏览器缓存都不能保存个性化 HTML。
    res.set('Cache-Control','private, no-store');
    res.set('Cloudflare-CDN-Cache-Control','no-store');
    res.set('Content-Type','text/html; charset=utf-8');
    res.end(html);
  });
  router.use('/assets/:version',(req,res,next)=>{
    if(!version||req.params.version!==version||path.extname(req.path).toLowerCase()==='.html'){res.set('Cache-Control','no-store');return res.sendStatus(404);}
    next();
  },express.static(config.PUBLIC_DIR,{
    index:false,etag:true,maxAge:'1y',immutable:true,
  }));
  // 兼容旧入口，并让未带发布版本的开发文件始终重新加载。
  router.use(express.static(config.PUBLIC_DIR,{index:false,etag:true,setHeaders:res=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control','no-store');
  }}));
  return router;
};
