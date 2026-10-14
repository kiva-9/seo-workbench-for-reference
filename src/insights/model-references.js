function referenceLabel(index) {
  let value=index+1,label='';
  while(value){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}
  return 'e'+label;
}

function projectReferences(evidence) {
  const byId=new Map(evidence.map((item,index)=>[item.id,referenceLabel(index)]));
  const byLabel=new Map([...byId].map(([id,label])=>[label,id]));
  function project(value,key=''){
    if(typeof value==='string')return /(^id$|_id$|_ids$)/.test(key)&&byId.has(value)?byId.get(value):value;
    if(Array.isArray(value))return value.map(item=>project(item,key));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,project(item,name)]));
    return value;
  }
  return {evidence:project(evidence),allowed:[...byLabel.keys()],byLabel};
}

function restoreReferences(content,byLabel) {
  if(typeof content!=='string')return {output:null,references_valid:null};
  let output;try{output=JSON.parse(content);}catch{return {output:content,references_valid:null};}
  if(!Array.isArray(output?.evidenceIds))return {output:content,references_valid:null};
  // Unknown labels remain a validation failure; a typo is never repaired by fuzzy matching.
  const references_valid=output.evidenceIds.every(label=>byLabel.has(label));
  return {output:JSON.stringify({...output,evidenceIds:output.evidenceIds.map(label=>byLabel.get(label)??label)}),references_valid};
}

module.exports={projectReferences,restoreReferences};
