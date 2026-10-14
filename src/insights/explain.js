const {fail,hash,VERSION,validateExplanation,explanationDiagnostic}=require('./contracts');
const identity=model=>model?.identity||{model:model?'injected':'disabled',prompt_version:VERSION};
const STOP_CODES=new Set(['STALE_AUTHORIZATION','FORBIDDEN','BUDGET_EXCEEDED','EXTERNAL_UNCERTAIN','EXTERNAL_DISABLED','MODEL_INPUT_LIMIT','MODEL_SECRET_ECHO']);

async function explainEvidence({evidence,settings,background,module,runId,projectId,expectedIdentity,resolveModel,external,assertActive}){
  if(!settings.enabled||!settings.data_approved)return {status:'disabled',explanation:null};
  const mode=settings.budget_mode||'cost',countOnly=mode==='calls'||mode==='unlimited',unlimited=mode==='unlimited';
  if((!unlimited&&!settings.daily_calls)||(!countOnly&&(!settings.call_cost_limit||!settings.daily_cost)))return {status:'budget_exceeded',explanation:null};
  const {adapter:primary}=await resolveModel();
  if(!primary)return {status:'disabled',explanation:null};
  if(Buffer.byteLength(JSON.stringify(evidence))>40000)return {status:'failed',explanation:null,error_code:'MODEL_INPUT_LIMIT'};
  if(hash(identity(primary))!==hash(expectedIdentity))fail('STALE_AUTHORIZATION','模型配置已变化，请重新运行');
  const models=[primary,...(primary.fallback?[primary.fallback]:[])],attempts=[];
  for(const [index,model]of models.entries()){
    let completed;
    const request={evidence,background,purpose:module,max_tokens:settings.max_tokens,request_id:hash({run:runId,evidence,...(index?{attempt:index}:{})}),signal:AbortSignal.timeout(45000),cost_limit:settings.call_cost_limit,budget_mode:mode,assertActive};
    try{
      await assertActive();model.preflight?.(request);
      const invoke=()=>new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Object.assign(new Error('模型调用超时'),{code:'MODEL_TIMEOUT'})),45000);
        Promise.resolve().then(()=>model(request)).then(resolve,reject).finally(()=>clearTimeout(timeout));
      });
      completed=await external('model',String(projectId),invoke,{
        daily:unlimited?Number.MAX_SAFE_INTEGER:settings.daily_calls,projectDaily:unlimited?Number.MAX_SAFE_INTEGER:settings.daily_calls,
        ...(unlimited?{minute:Number.MAX_SAFE_INTEGER}:{}),
        ...(countOnly?{}:{cost:settings.call_cost_limit,dailyCost:settings.daily_cost}),
        model_name:model.identity?.model||'injected',model_profile_id:model.identity?.profile_id||null,
      });
      if(completed.finish_reason&&completed.finish_reason!=='stop')fail('MODEL_OUTPUT_INCOMPLETE','模型输出未完整结束');
      if(completed.references_valid===false)fail('MODEL_EVIDENCE','模型引用不在输入证据中');
      if(completed.output===null||completed.output===undefined||(typeof completed.output==='string'&&!completed.output.trim()))fail('MODEL_INVALID','模型未返回正文');
      const output=typeof completed.output==='string'?JSON.parse(completed.output):completed.output;
      const explanation=validateExplanation(output,evidence,{module});
      attempts.push({model:completed.model||model.identity?.model||'configured',profile_id:model.identity?.profile_id||null,status:'succeeded',usage:completed.usage??null});
      return {status:'succeeded',explanation,usage:completed.usage??null,model:completed.model??'configured',profile_id:model.identity?.profile_id||null,prompt_version:VERSION,prompt_hash:completed.prompt_hash??null,fallback_used:index>0,attempts};
    }catch(error){
      if(['STALE_AUTHORIZATION','FORBIDDEN'].includes(error.code))throw error;
      const diagnostic=explanationDiagnostic(error),code=error.code||'MODEL_INVALID';
      const result={status:error.uncertain?'uncertain':'failed',explanation:null,error_code:code,
        ...(diagnostic?{validation:diagnostic}:{}),...(completed?{usage:completed.usage??null,finish_reason:completed.finish_reason??null}:{})};
      attempts.push({model:model.identity?.model||'configured',profile_id:model.identity?.profile_id||null,status:result.status,error_code:code,...(completed?{usage:completed.usage??null}: {})});
      // A backup is one separate, accounted attempt after a definitive refusal or a completed response.
      if(index===models.length-1||error.uncertain||STOP_CODES.has(code)||(!completed&&!error.definitive&&!['MODEL_KEY_UNAVAILABLE','MODEL_PRICING_REQUIRED'].includes(code)))return {...result,attempts};
    }
  }
}
module.exports={explainEvidence};
