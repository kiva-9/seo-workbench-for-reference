function startInsightBackground(service,{enabled=true,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}={}){
  let stopped=false,timer,running=null,again=false;
  function schedule(ms){if(stopped||!enabled)return;timer=setTimer(tick,ms);timer.unref?.();}
  async function tick(){
    timer=null;if(stopped||running)return;
    running=(async()=>{
      try{await service.schedule();}catch(error){onError(error.code||'AI_SCHEDULE_FAILED');}
      // A scheduling conflict must not block manual jobs or expired-lease recovery.
      try{return await service.runOnce();}catch(error){onError(error.code||'AI_BACKGROUND_FAILED');return {processed:0};}
    })();
    const result=await running;running=null;const wait=again?0:result.processed?100:15000;again=false;schedule(wait);
  }
  function wake(){if(stopped||!enabled)return;if(running){again=true;return;}if(timer)clearTimer(timer);schedule(0);}
  schedule(1000);
  return {wake,stop(){stopped=true;if(timer)clearTimer(timer);return running||Promise.resolve();}};
}
module.exports={startInsightBackground};
