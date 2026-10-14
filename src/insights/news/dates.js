const MONTHS=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const ZONES={UT:'Z',UTC:'Z',GMT:'Z',Z:'Z',EST:'-05:00',EDT:'-04:00',MST:'-07:00',MDT:'-06:00',PST:'-08:00',PDT:'-07:00'};

function validCalendar(year,month,day,hour=0,minute=0,second=0) {
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return year>=1&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=days[month-1]&&hour>=0&&hour<=23&&minute>=0&&minute<=59&&second>=0&&second<=59;
}

function publicationDate(raw) {
  const value=(typeof raw==='string'?raw:typeof raw?._==='string'?raw._:'').trim();
  const result={value:null,status:value?'invalid':'missing',precision:null,raw:value?value.slice(0,160):null};
  if(!value||value.length>160)return result;
  const iso=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(value);
  const rfc=/^(?:[a-z]{3},?\s+)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[a-z]{1,4})$/i.exec(value);
  let year,month,day,hour=0,minute=0,second=0,zone='Z',fraction='';
  if(iso){
    year=Number(iso[1]);month=Number(iso[2]);day=Number(iso[3]);
    hour=Number(iso[4]||0);minute=Number(iso[5]||0);second=Number(iso[6]||0);fraction=iso[7]||'';
    if(!validCalendar(year,month,day,hour,minute,second))return result;
    if(!iso[4])return {...result,status:'ambiguous',precision:'date_only'};
    if(!iso[8])return {...result,status:'ambiguous',precision:'timestamp'};
    zone=iso[8].toUpperCase();result.precision='timestamp';
  }else if(rfc){
    year=Number(rfc[3]);month=MONTHS.indexOf(rfc[2].toLowerCase())+1;day=Number(rfc[1]);
    hour=Number(rfc[4]);minute=Number(rfc[5]);second=Number(rfc[6]||0);
    if(!validCalendar(year,month,day,hour,minute,second))return result;
    const named=rfc[7].toUpperCase();
    if(['CST','CDT'].includes(named))return {...result,status:'ambiguous',precision:'timestamp'};
    zone=ZONES[named]||(/^[+-]\d{4}$/.test(named)?named:null);
    if(!zone)return result;
    result.precision='timestamp';
  }else return result;
  if(zone!=='Z'){
    const offset=/^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if(!offset||Number(offset[2])>23||Number(offset[3])>59)return result;
    zone=offset[1]+offset[2]+':'+offset[3];
  }
  const pad=value=>String(value).padStart(2,'0');
  const timestamp=Date.parse(`${String(year).padStart(4,'0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}${zone}`);
  return Number.isFinite(timestamp)?{value:new Date(timestamp).toISOString(),status:'known',precision:result.precision,raw:result.raw}:result;
}

module.exports={publicationDate};
