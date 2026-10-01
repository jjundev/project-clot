import {parseArgs} from 'node:util';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {fail} from './lib/result.mjs';
import * as commands from './lib/commands.mjs';
const help=`musinsa: search <query>, product <goodsNo-or-url>, options <goodsNo-or-url>, recommend
search: --limit 1..100 --page N --sort popular|sale|price_low|price_high|newest|review
        --gender all|men|women --is-used true|false --size M,L --shoe-size 270 --measure 총장:70-75
recommend: --limit 1..100 --gender M|F|A --store musinsa|outlet|beauty|player|boutique`;
export async function run(argv,deps={}) {
  try {
    const {values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{
      help:{type:'boolean'},limit:{type:'string'},page:{type:'string'},sort:{type:'string'},gender:{type:'string'},
      'is-used':{type:'string'},size:{type:'string'},'shoe-size':{type:'string'},measure:{type:'string'},store:{type:'string'}
    }});
    if(values.help) return {exitCode:0,result:{help}};
    const [command,arg]=positionals;
    const opts={...values};delete opts.help;
    if(!['search','product','options','recommend'].includes(command)||positionals.length!==(command==='recommend'?1:2))
      throw fail('INVALID_ARGUMENT','명령 또는 위치 인자 형식 오류');
    const result=await (command==='recommend'?commands.recommend(opts,deps):commands[command](arg,opts,deps));
    return {exitCode:0,result};
  } catch(error) {
    const code=error.code?.startsWith('ERR_PARSE_ARGS')?'INVALID_ARGUMENT':error.code??'INTERNAL_ERROR';
    return {exitCode:code==='INVALID_ARGUMENT'?2:1,result:{status:'error',data:[],warnings:[],sourceUrls:[],
      fetchedAt:(deps.clock??(()=>new Date().toISOString()))(),error:{code,message:error.message}}};
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  const {exitCode,result}=await run(process.argv.slice(2));
  process.stdout.write(result.help?`${result.help}\n`:`${JSON.stringify(result)}\n`);process.exitCode=exitCode;
}
