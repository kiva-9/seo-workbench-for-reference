const {Router}=require('express');
const {wrap}=require('../lib/http');
const {fail}=require('../insights/contracts');
module.exports=({modelSettings})=>{
  const router=Router(),route='/api/admin/ai-model';
  router.use(route,wrap(async(req,res,next)=>{res.set('Cache-Control','no-store');await modelSettings.assertAdmin(req.user.id);next();}));
  router.get(route,wrap(async(req,res)=>res.json(await modelSettings.get(req.user.id))));
  router.put(route,wrap(async(req,res)=>{if(!req.body||JSON.stringify(req.body).length>160000)fail('VALIDATION_ERROR','配置正文过大或无效',400);res.json(await modelSettings.save(req.user.id,req.body));}));
  router.get('/api/admin/ai-runtime',wrap(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await modelSettings.runtimeSettings.get(req.user.id));}));
  router.put('/api/admin/ai-runtime',wrap(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await modelSettings.runtimeSettings.save(req.user.id,req.body));}));
  return router;
};
