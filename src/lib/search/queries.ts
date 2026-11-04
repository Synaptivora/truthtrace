// Explicit lexical alternatives, not assertions of semantic equivalence or truth.
const groups=[['退款','退钱','返款'],['到账','入账'],['定金','订金'],['微信','WeChat'],['钉钉','DingTalk']];
export function expandQuery(query:string):string[]{
 const trimmed=query.trim();if(trimmed.length>200)throw Error('Query exceeds 200 UTF-16 units');
 const variants=new Set([trimmed]);
 for(const group of groups)for(const word of group)if(trimmed.includes(word))for(const alternative of group)variants.add(trimmed.replaceAll(word,alternative));
 return [...variants];
}
