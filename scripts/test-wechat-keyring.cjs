const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const ts = require('typescript')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'notewake-keyring-fixture-'))
const osKey=crypto.randomBytes(32);const primary=crypto.randomBytes(32).toString('hex')
const salt=crypto.randomBytes(16).toString('hex');const dbKey=crypto.randomBytes(32).toString('hex')
let available=true
const storage={isEncryptionAvailable:()=>available,
 encryptString: text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',osKey,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()])},
 decryptString: bytes=>{const cipher=crypto.createDecipheriv('aes-256-gcm',osKey,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString()},
}
const dependencies={electron:{safeStorage:storage},crypto,fs,path,
 './runtimePaths':{getUserDataPath:()=>directory},
 './wechatDatabaseKeys':{resolveWechatAccount:(p,w)=>({wxid:w,dbStoragePath:p})},
}
const moduleObject={exports:{}}
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../electron/services/wechatKeyring.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
vm.runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,Buffer,process:{platform:'win32',pid:12345},require:id=>{assert(Object.hasOwn(dependencies,id));return dependencies[id]}})
const {saveWechatKeyring,loadWechatKeyring,isWechatDatabaseKeyring}=moduleObject.exports
try {
 assert.equal(loadWechatKeyring('C:\\data\\one','one',primary),undefined)
 assert.equal(isWechatDatabaseKeyring({[salt]:dbKey}),true)
 assert.equal(isWechatDatabaseKeyring({oops:dbKey}),false)
 saveWechatKeyring('C:\\data\\one','one',primary,{[salt]:dbKey})
 const file=path.join(directory,'wechat-database-keyrings.v1.json'),bytes=fs.readFileSync(file)
 assert(!bytes.includes(primary));assert(!bytes.includes(dbKey));assert(!bytes.includes(salt))
 assert.equal(loadWechatKeyring('c:\\data\\one','one',primary)[salt],dbKey)
 assert.equal(loadWechatKeyring('C:\\data\\two','two',primary),undefined)
 assert.equal(loadWechatKeyring('C:\\data\\one','one','ab'.repeat(32)),undefined)
 available=false
 assert.throws(()=>saveWechatKeyring('C:\\data\\one','one',primary,{[salt]:dbKey}))
 assert.throws(()=>loadWechatKeyring('C:\\data\\one','one',primary))
 assert(fs.readFileSync(file).equals(bytes))
 available=true
 const data=JSON.parse(bytes);const id=Object.keys(data.entries)[0]
 const encrypted=Buffer.from(data.entries[id],'base64');encrypted[15]^=1;data.entries[id]=encrypted.toString('base64')
 fs.writeFileSync(file,JSON.stringify(data))
 assert.throws(()=>loadWechatKeyring('C:\\data\\one','one',primary))
 console.log('Encrypted keyring persistence, account/path/key isolation, corruption and unavailable OS storage checks passed')
} finally {fs.rmSync(directory,{recursive:true,force:true});osKey.fill(0)}
