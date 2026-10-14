const {createInsightService}=require('./service');
const {createModelSettings}=require('./model-settings');
function createInsights({db,google,config={},modules,adapters={},modelSettings,modelSettingsOptions,...options}){
  const demo=config.AI_DEMO_MODE?require('./demo').demoOptions():{};
  const implementations=modules||{performance:require('./performance'),news:require('./news'),indexing:require('./indexing')};
  const settings=modelSettings||createModelSettings({db,config,...modelSettingsOptions});
  const mergedAdapters={...demo.adapters,...adapters};
  const resolveModel=async()=>{
    const state=await settings.runtime();
    return {...state,adapter:Object.hasOwn(mergedAdapters,'model')?mergedAdapters.model:state.adapter};
  };
  return createInsightService({db,google,config,modules:implementations,adapters:mergedAdapters,resolveModel,...(demo.now?{now:demo.now}:{}),...options});
}
module.exports={createInsights};
