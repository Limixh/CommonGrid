import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { claudeLoginScopes, validateClaudeAuthorizationUrl, validateClaudeLoginCode } from "../src/claude-login-contract.ts";
import { claudeManagedLogin, runClaudeLoginProtocol } from "../src/provider-session.ts";
import { acceptProfileSessionUpdate, validateProfileSessionStatus, validateProfileSessionSubmit, type ProfileSessionStatus } from "../src/profile-session-protocol.ts";
import { ClaudeLoginMailbox } from "../../../apps/desktop/native-worker/profile-session.ts";

export const state="S".repeat(43),code="fixture_authorization_code#"+state;
export const authorizationUrl="https://claude.com/cai/oauth/authorize?"+new URLSearchParams({code:"true",client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e",response_type:"code",redirect_uri:"https://platform.claude.com/oauth/code/callback",scope:claudeLoginScopes.join(" "),code_challenge:"P".repeat(43),code_challenge_method:"S256",state});
function fixture() {
  let kills=0;const input:string[]=[];
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){kills++;return true;}});
  child.stdin.on("data",bytes=>{input.push(bytes.toString());queueMicrotask(()=>child.emit("close",0));});
  const output=(url=authorizationUrl)=>child.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: "+url+"\nPaste code here if prompted > ");
  return {child:child as unknown as ChildProcessWithoutNullStreams & {stdout:PassThrough;stderr:PassThrough},input,output,get kills(){return kills;}};
}
test("pinned Claude authorization contract rejects foreign destinations, altered OAuth parameters and hidden controls",()=>{
  assert.equal(validateClaudeAuthorizationUrl(authorizationUrl),authorizationUrl);
  for(const value of [authorizationUrl.replace("claude.com/","claude.com.evil.test/"),authorizationUrl.replace("https:","http:"),authorizationUrl.replace("claude.com/","claude.com:443/"),authorizationUrl+"#fragment",authorizationUrl+"&state="+state,authorizationUrl+"&private=secret",authorizationUrl.replace("S256","plain"),authorizationUrl.replace("9d1c250a","11111111"),authorizationUrl.replace("user%3Aplugins","user%3Adesign"),authorizationUrl.replace("S".repeat(43),"x"),authorizationUrl.replace("code=true","code=%0a"),authorizationUrl+"\n",authorizationUrl.replace("claude.com/","user@claude.com/"),"x".repeat(2049)])assert.throws(()=>validateClaudeAuthorizationUrl(value),/contract_invalid/);
});
test("one bounded code binds to active state and submit requests contain no arbitrary control fields",()=>{
  assert.equal(validateClaudeLoginCode(code,authorizationUrl),code);
  const request={schema_version:"1.0",request_id:"10000000-0000-4000-8000-000000000001",expected_revision:2,code};
  assert.deepEqual(validateProfileSessionSubmit(request),request);
  for(const value of [code+"\n"," "+code,code.replace(state,"X".repeat(43)),"bad","x#x",code+"#extra","x".repeat(2049)+"#"+state])assert.throws(()=>validateClaudeLoginCode(value,authorizationUrl),/contract_invalid/);
  for(const value of [{...request,argv:[]},{...request,expected_revision:-1},{...request,request_id:"bad"},{...request,code:"bad"}])assert.throws(()=>validateProfileSessionSubmit(value),/contract_invalid/);
});
test("Claude stream login strips split terminal hyperlinks, returns no private data and sends code only to stdin",async context=>{
  const logs=[context.mock.method(console,"log",()=>{}),context.mock.method(console,"error",()=>{})];
  const f=fixture();let callbacks=0;
  const pending=runClaudeLoginProtocol(f.child,{onClaudeAuthorization:async(challenge,signal)=>{callbacks++;assert.equal(signal.aborted,false);assert.equal(Object.isFrozen(challenge),true);assert.deepEqual(challenge,{authorization_url:authorizationUrl});return code;}});
  await Promise.resolve();await Promise.resolve();
  const line="If the browser didn't open, visit: \x1b]8;;"+authorizationUrl+"\x1b\\"+authorizationUrl+"\x1b]8;;\x1b\\\nPaste code here if prompted > ";
  for(const chunk of [line.slice(0,35),line.slice(35,200),line.slice(200)])f.child.stdout.write(chunk);
  assert.equal(await pending,undefined);assert.equal(callbacks,1);assert.deepEqual(f.input,[code+"\n"]);assert.ok(f.kills>0);assert.ok(logs.every(log=>log.mock.callCount()===0));
});
test("Claude stream parser fails closed before input on malformed URLs, duplicate challenges and oversized streams",async()=>{
  for(const fault of ["url","duplicate","stdout","stderr"]){
    const f=fixture();let callbacks=0;
    const pending=runClaudeLoginProtocol(f.child,{onClaudeAuthorization:async()=>{callbacks++;return new Promise<string>(()=>{});}});
    await Promise.resolve();await Promise.resolve();
    if(fault==="url")f.output(authorizationUrl+"&unknown=PRIVATE");
    else if(fault==="duplicate"){f.output();f.output();}
    else f.child[fault as "stdout"|"stderr"].write("x".repeat(65_537));
    await assert.rejects(pending,/managed_provider_protocol/);assert.deepEqual(f.input,[]);assert.ok(f.kills>0);assert.equal(callbacks,0);
  }
});
test("Claude code state, callback errors and premature process success cannot authenticate",async()=>{
  for(const fault of ["state","callback","premature"]){
    const f=fixture();const pending=runClaudeLoginProtocol(f.child,{onClaudeAuthorization:async()=>{if(fault==="callback")throw Error("PRIVATE_UI_ERROR");return fault==="state"?code.replace(state,"X".repeat(43)):new Promise<string>(()=>{});}});
    await Promise.resolve();await Promise.resolve();f.output();if(fault==="premature")f.child.emit("close",0);
    await assert.rejects(pending,/managed_provider_protocol/);assert.deepEqual(f.input,[]);assert.ok(f.kills>0);
  }
});
test("Claude prompt cancellation and a hanging callback are bounded and cannot deliver later input",async()=>{
  const f=fixture(),controller=new AbortController();let late!:(code:string)=>void;
  const pending=runClaudeLoginProtocol(f.child,{signal:controller.signal,onClaudeAuthorization:async()=>new Promise(resolve=>{late=resolve;})});
  await Promise.resolve();await Promise.resolve();f.output();await Promise.resolve();controller.abort();
  await assert.rejects(pending,/managed_provider_canceled/);late(code);await Promise.resolve();assert.deepEqual(f.input,[]);
  const hung=fixture();const deadline=runClaudeLoginProtocol(hung.child,{deadlineMs:25,onClaudeAuthorization:async()=>new Promise<string>(()=>{})});
  await Promise.resolve();await Promise.resolve();hung.output();await assert.rejects(deadline,/managed_provider_deadline/);assert.ok(hung.kills>0);
});
test("worker mailbox accepts one exact request after its challenge and discards input on cancellation",async()=>{
  const requestId="10000000-0000-4000-8000-000000000001",controller=new AbortController(),mailbox=new ClaudeLoginMailbox(requestId);
  const frame={type:"claude_login_code",request_id:requestId,code};
  assert.throws(()=>mailbox.submit(frame));
  const pending=mailbox.wait({authorization_url:authorizationUrl},controller.signal);
  for(const value of [{...frame,request_id:"foreign"},{...frame,extra:"PRIVATE"},{...frame,code:code.replace(state,"X".repeat(43))}])assert.throws(()=>mailbox.submit(value));
  mailbox.submit(frame);assert.equal(await pending,code);assert.throws(()=>mailbox.submit(frame));mailbox.close();assert.throws(()=>mailbox.submit(frame));
  const canceled=new ClaudeLoginMailbox(requestId),waiting=canceled.wait({authorization_url:authorizationUrl},controller.signal);controller.abort();await assert.rejects(waiting,/managed_provider_canceled/);assert.throws(()=>canceled.submit(frame));
});

test("Claude login teardown absorbs late child and pipe errors after every terminal path",async()=>{
  for(const outcome of ["cancel","deadline","protocol","premature","passed"]){
    const f=fixture(),controller=new AbortController();
    const pending=runClaudeLoginProtocol(f.child,{signal:controller.signal,deadlineMs:outcome==="deadline"?25:1000,
      onClaudeAuthorization:async()=>outcome==="passed"?code:new Promise<string>(()=>{})});
    await Promise.resolve();await Promise.resolve();
    if(outcome==="protocol")f.output(authorizationUrl+"&unknown=private");else f.output();
    await Promise.resolve();
    if(outcome==="cancel")controller.abort();
    if(outcome==="premature")f.child.emit("close",0);
    if(outcome==="passed")await pending;else await assert.rejects(pending);
    // Native pipe errors are delivered asynchronously, including after kill.
    await new Promise<void>((resolve,reject)=>setImmediate(()=>{
      try{
        for(const source of [f.child,f.child.stdin,f.child.stdout,f.child.stderr])source.emit("error",Object.assign(new Error("pipe closed"),{code:"EPIPE"}));
        resolve();
      }catch(error){reject(error);}
    }));
  }
});

test("CLI failure aborts its pending authorization mailbox and prevents later submission",async()=>{
  for(const fault of ["close","process","stdout"]){
    const f=fixture(),requestId="10000000-0000-4000-8000-000000000001",mailbox=new ClaudeLoginMailbox(requestId);
    let callbackSignal:AbortSignal|undefined,waiting:Promise<string>|undefined;
    const pending=runClaudeLoginProtocol(f.child,{onClaudeAuthorization:(challenge,signal)=>{
      callbackSignal=signal;waiting=mailbox.wait(challenge,signal);return waiting;
    }});
    await Promise.resolve();await Promise.resolve();f.output();await Promise.resolve();
    assert.ok(waiting);assert.equal(callbackSignal?.aborted,false);
    const released=assert.rejects(waiting,/managed_provider_canceled/);
    if(fault==="close")f.child.emit("close",1);
    else if(fault==="process")f.child.emit("error",new Error("child failed"));
    else f.child.stdout.write("x".repeat(65_537));
    await assert.rejects(pending);await released;
    assert.equal(callbackSignal?.aborted,true);
    assert.throws(()=>mailbox.submit({type:"claude_login_code",request_id:requestId,code}));
    assert.deepEqual(f.input,[]);
  }
});
test("Claude managed login journals a fixed operation exec and verifies official status with a separate bounded deadline",async()=>{
  const original=childProcess.spawn;
  try{
    for(const authenticated of [true,false]){
      const f=fixture(),calls:string[]=[];
      childProcess.spawn=((command: string,argv: readonly string[] | undefined,options: unknown)=>{
        calls.push("spawn");assert.equal(command,"docker");assert.deepEqual(argv,["exec","-i","a".repeat(64),"/opt/cg/claude","auth","login","--claudeai"]);
        assert.deepEqual(options,{windowsHide:true,stdio:["pipe","pipe","pipe"]});setImmediate(()=>f.output());return f.child;
      }) as unknown as typeof childProcess.spawn;syncBuiltinESMExports();
      const runtime={async verifyOperation(){calls.push("verify");return"a".repeat(64);},async beginNamespaceExec(id:string){calls.push("journal");assert.equal(id,"a".repeat(64));return "10000000-0000-4000-8000-000000000001" as const;},async exec(argv:string[],deadline:number,options:{maxBytes?:number}){
        calls.push("status");assert.deepEqual(argv,["/opt/cg/claude","auth","status","--json"]);assert.equal(deadline,30_000);assert.equal(options.maxBytes,262_144);return{code:authenticated?0:1,stdout:JSON.stringify({loggedIn:authenticated,authMethod:authenticated?"claude.ai":"none"}),stderr:"PRIVATE_DISCARDED"};}};
      const pending=claudeManagedLogin(runtime,{deadlineMs:600_000,onClaudeAuthorization:async()=>code});
      if(authenticated)assert.deepEqual(await pending,{authenticated:true,method:"claude.ai"});else await assert.rejects(pending,/managed_provider_auth_required/);
      assert.deepEqual(calls,["verify","journal","spawn","status"]);
    }
  }finally{childProcess.spawn=original;syncBuiltinESMExports();}
});
test("pre-cancelled Claude login never verifies, journals, spawns or invokes its callback",async()=>{
  let calls=0;const controller=new AbortController();controller.abort();
  const runtime={async verifyOperation(){calls++;return"a".repeat(64);},async beginNamespaceExec(){calls++;return "10000000-0000-4000-8000-000000000001" as const;},async exec(){calls++;return{code:0,stdout:"",stderr:""};}};
  await assert.rejects(claudeManagedLogin(runtime,{signal:controller.signal,onClaudeAuthorization:async()=>{calls++;return code;}}),/managed_provider_canceled/);assert.equal(calls,0);
});
test("Claude challenge stays transient through code acceptance and cannot be rewritten at the same revision",()=>{
  const waiting:ProfileSessionStatus={schema_version:"1.0",availability:"available",operation:{request_id:"10000000-0000-4000-8000-000000000001",profile_id:"20000000-0000-4000-8000-000000000002",provider:"claude",action:"login",revision:3,phase:"waiting_for_login",outcome:null,session_state:"unknown",challenge:{authorization_url:authorizationUrl},error_code:null,cleanup:"pending"}};
  assert.deepEqual(validateProfileSessionStatus(waiting),waiting);
  const submitted={...waiting,operation:{...waiting.operation!,revision:4,challenge:null}};
  assert.deepEqual(acceptProfileSessionUpdate(waiting,submitted),submitted);
  assert.throws(()=>acceptProfileSessionUpdate(waiting,{...submitted,operation:{...submitted.operation,revision:3}}),/status_stale/);
  for(const changes of [{provider:"codex"},{action:"status"},{phase:"checking"},{challenge:{authorization_url:authorizationUrl,code:"PRIVATE"}}])assert.throws(()=>validateProfileSessionStatus({...waiting,operation:{...waiting.operation!,...changes}}),/contract_invalid/);
});
