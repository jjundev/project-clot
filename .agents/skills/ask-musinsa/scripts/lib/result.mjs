// result.mjs
export const fail=(code,message)=>Object.assign(new Error(message),{code});
export const numberOrNull=v=>!['number','string'].includes(typeof v)||String(v).trim()===''||!Number.isFinite(Number(v))?null:Number(v);
export const booleanOrNull=v=>typeof v==='boolean'?v:null;
export const envelope=(data,warnings,sourceUrls,fetchedAt)=>({
  status:warnings.length?'partial':'ok',data,warnings,sourceUrls,fetchedAt
});
