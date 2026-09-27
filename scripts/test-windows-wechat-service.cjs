const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const key = '12'.repeat(32), salt = '34'.repeat(16)
function load(file, dependencies, globals = {}) {
 const module = {exports:{}}
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const req=id=>{if(Object.hasOwn(dependencies,id))return dependencies[id];throw new Error('Unexpected dependency '+id)}
 req.resolve=id=>id
 vm.runInNewContext(code,{module,exports:module.exports,require:req,Buffer,console,AbortController,setTimeout,clearTimeout,process:{platform:'win32',arch:'x64',execPath:'synthetic-electron'},...globals})
 return module.exports
}
function fixture(options={}) {
 const child=new EventEmitter();child.stdout={resume(){}};child.stderr={resume(){}};child.sent=[];child.kills=0
 child.send = m=>{child.sent.push(m);if(m.type==='cancel'&&!options.stall)setImmediate(()=>child.emit('exit',0))}
 child.kill=()=>{child.kills++;if(!options.stall)setImmediate(()=>child.emit('exit',0));return true}
 const statuses=[];const persisted=[];let probes=0
 const account={wxid:'synthetic-account',dbStoragePath:'/synthetic/db_storage',databases:[{core:true,salt,page:Buffer.alloc(4096)}]}
 const verifier={
  discoverWechatDatabases:(_root,wxid)=>{if(wxid&&wxid!==account.wxid)throw new Error('账号不匹配');return account},
  verifyWechatRawKey:(k,s)=>k===key&&s===salt,
  verifyWechatKeyCandidates:(_account,keys)=>({success:keys.get(salt)===key,primaryKey:keys.get(salt),keysBySalt:Object.fromEntries(keys),coreVerified:keys.size,coreTotal:1}),
 }
 const {WindowsWechatKeyService}=load('electron/services/windowsWechatKeyService.ts',{
  child_process:{fork:()=>child},fs:{existsSync:()=>true},path,
  electron:{safeStorage:{isEncryptionAvailable:()=>options.storage!==false}},
  './runtimePaths':{getAppPath:()=>'/synthetic',isElectronPackaged:()=>false},
  './workerEnvironment':{getElectronWorkerEnv:()=>({})},
  './wechatDatabaseKeys':verifier,
  './wechatKeyring':{saveWechatKeyring:(...args)=>{persisted.push(args)}},
  './wcdbService':{wcdbService:{testConnection:async(...args)=>{probes++;assert.equal(args[3][salt],key);if(options.probe)return options.probe();return {success:true}}}},
  '../../src/shared/wechatConnection':{redactWechatKey:e=>String(e instanceof Error?e.message:e).replace(/[a-f0-9]{64,}/gi,'[redacted]')},
 },options.fastTimers?{setTimeout:(fn,ms)=>setTimeout(fn,ms===3000?5:20)}:{})
 const stop=new AbortController();const service=new WindowsWechatKeyService()
 return {child,statuses,persisted,stop,probes:()=>probes,run:()=>service.capture({dbPath:'/synthetic',wxid:account.wxid,signal:stop.signal,onStatus:(s)=>statuses.push(s)})}
}
const tick=()=>new Promise(r=>setImmediate(r))
async function main(){
 const good=fixture();const result=good.run()
 assert.equal(good.child.sent[0].salts[0],salt)
 good.child.emit('message',{type:'candidate',key,salt:'56'.repeat(16)})
 good.child.emit('message',{type:'candidate',key:'ab'.repeat(32),salt})
 assert.equal(good.child.kills,0)
 good.child.emit('message',{type:'candidate',key,salt})
 const success=await result
 assert.equal(success.success,true);assert.equal(success.validatedWxid,'synthetic-account')
 assert.equal(good.persisted.length,1);assert.equal(good.child.kills,0);assert.equal(good.child.sent[1].type,'cancel');assert.equal(good.probes(),1)
 assert(!JSON.stringify(good.statuses).includes(key))
 const badReader=fixture({probe:()=>({success:false,error:'synthetic unavailable reader'})});const badRun=badReader.run()
 badReader.child.emit('message',{type:'candidate',key,salt})
 const failed=await badRun;assert.equal(failed.success,false);assert.equal(failed.key,undefined);assert.equal(badReader.persisted.length,0)
 assert.match(failed.error,/密钥已校验.*读取/)
 const cancelled=fixture();const cancelRun=cancelled.run();cancelled.stop.abort()
 cancelled.child.emit('message',{type:'candidate',key,salt})
 assert.equal((await cancelRun).success,false);assert.equal(cancelled.persisted.length,0);assert.equal(cancelled.probes(),0)
 const crashed=fixture();const crashRun=crashed.run();crashed.child.emit('exit',1)
 assert.equal((await crashRun).success,false);assert.equal(crashed.persisted.length,0)
 for(const reason of ['complete','timeout','no-process','permission-denied']){
  const partial=fixture();const partialRun=partial.run();partial.child.emit('message',{type:'done',reason})
  assert.equal((await partialRun).success,false);assert.equal(partial.persisted.length,0)
 }
 const stalled=fixture({stall:true,fastTimers:true});const stalledRun=stalled.run();stalled.child.emit('message',{type:'candidate',key,salt})
 assert.equal((await stalledRun).success,false);assert.equal(stalled.child.kills,1);assert.equal(stalled.persisted.length,0)
 assert.match((await stalled.run()).error,/仍在停止/);assert.equal(stalled.child.sent.filter(m=>m.type==='scan').length,1)
 const deadline=fixture({fastTimers:true});assert.equal((await deadline.run()).success,false);assert.equal(deadline.child.sent[1].type,'cancel');assert.equal(deadline.persisted.length,0)
 const unavailable=fixture({storage:false});assert.equal((await unavailable.run()).success,false);assert.equal(unavailable.child.sent.length,0)
 let finishProbe
 const duringProbe=fixture({probe:()=>new Promise(r=>{finishProbe=r})});const probing=duringProbe.run()
 duringProbe.child.emit('message',{type:'candidate',key,salt});await tick();duringProbe.stop.abort();finishProbe({success:true})
 assert.equal((await probing).success,false);assert.equal(duringProbe.persisted.length,0)
 console.log('Windows acquisition isolation, salt validation, reader gate, cancellation, private status and atomic persistence gates passed')
}
main().catch(e=>{console.error(e);process.exitCode=1})
