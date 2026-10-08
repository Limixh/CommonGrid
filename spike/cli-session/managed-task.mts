// Small fixed, controlled real-account acceptance task. No arbitrary task input.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TaskToolsRuntime } from "../../packages/agent-adapters/src/task-runtime.ts";
import { executeTaskTool } from "../../packages/agent-adapters/src/task-tool.ts";
import { ManagedCliRuntime, startBridge, taskImage } from "./managed-runtime.mts";
import { codingPrompt, seedTask, snapshotCandidate, verifyCandidate, createDiff } from "./coding-task.mts";
import { assertCodingProfileVerified, codexCodingModel } from "./codex-profile.mts";
import { claudeFunctionalTestModel, ClaudeFunctionalTestModelGuard } from "@commongrid/agent-adapters/testing/functional-test-models";
import { BoundedJsonInput, BoundedJsonLines, OperationCancellation, ProviderFailure, RpcLifecycle, TaskCallbackGuard, assertBridgeHealthy, classifyProviderFailure, failureCode, isRecord, validRpcId, validateClaudeStatus, validateClaudeResult, validateCodexIdentity, validateCodexTurn } from "../../packages/agent-adapters/src/session-protocol.ts";
const [provider,owner]=process.argv.slice(2);assert.ok(provider === "claude" || provider === "codex");
ManagedCliRuntime.restore({owner,provider}); // Validate UUID before constructing the metadata path.
const root=fileURLToPath(new URL("../../",import.meta.url));
const saved=JSON.parse(await readFile(path.join(root,".local/managed-session",`${owner}.json`),"utf8"));assert.equal(saved.owner,owner);assert.equal(saved.provider,provider);
const runtime=ManagedCliRuntime.restore({owner,provider,trust:saved.trust});
const directory=path.join(root,".local/managed-task",randomUUID());await mkdir(directory,{recursive:true});
const schema=JSON.parse(await readFile(new URL("tool-schema.json",import.meta.url),"utf8"));
const requestedModel=provider === "claude"?claudeFunctionalTestModel:codexCodingModel;
const report:Record<string,any>={checked_at:new Date().toISOString(),purpose:"controlled_real_subscription_coding_task_in_isolated_cli",provider,owner,model:null,requested_model:requestedModel,observed_model:null,model_verified:false,credential_files_copied:false,paid_api_fallback:false,execution_enabled:false,isolation_gate:"not_evaluated",real_model_inference_attempted:false,task_calls:0,cleanup_confirmed:false};
let task:TaskToolsRuntime|undefined,bridge:Awaited<ReturnType<typeof startBridge>>|undefined,child:ChildProcessWithoutNullStreams|undefined;
const rpc=new RpcLifecycle(line=>child!.stdin.write(line),180_000,()=>{try{bridge?.close();}finally{child?.stdin.end();child?.kill();}});
const claudeModelGuard=new ClaudeFunctionalTestModelGuard();
const operation=new OperationCancellation();
const cancel=()=>{operation.cancel();rpc.fail(new ProviderFailure("canceled"));};process.on("SIGINT",cancel);process.on("SIGTERM",cancel);
const request=(method:string,params:unknown)=>rpc.request(method,params);
let lines:ReturnType<typeof createInterface>|undefined;
let input:BoundedJsonInput|undefined;
try {
  const catalog=provider === "codex"?await assertCodingProfileVerified():undefined;
  if(catalog){report.catalog_sha256=catalog.sha256;report.tool_profile="pinned_catalog_direct_no_multi_agent";}
  await runtime.start();
  rpc.assertActive();
  if(catalog)assert.equal((await runtime.exec(["node","-e","console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/cg/catalog.json')).digest('hex')); "])).stdout.trim(),catalog.sha256);
  task=await TaskToolsRuntime.create({image:taskImage,cpu:1,memoryMb:256},600_000);rpc.assertActive();await seedTask(task);
  rpc.assertActive();
  bridge=await startBridge(runtime,task);
  const args=provider === "claude"?["/opt/cg/claude","--print","--verbose","--output-format","stream-json","--tools","","--restricted","--strict-mcp-config","--mcp-config","/home/node/mcp.json","--setting-sources","","--disable-slash-commands","--no-session-persistence","--no-chrome","--permission-mode","dontAsk","--allowedTools","mcp__commongrid__task_exec","--model",claudeFunctionalTestModel,"--fallback-model",claudeFunctionalTestModel,codingPrompt]:
    ["/opt/cg/codex","app-server","--listen","stdio://","-c",'cli_auth_credentials_store="file"',"-c",`model="${codexCodingModel}"`,"-c",'model_catalog_json="/opt/cg/catalog.json"',"-c","agents.enabled=false","-c",'model_reasoning_effort="low"',"-c",'model_provider="openai"',"-c",'web_search="disabled"',"-c","features.multi_agent=false","-c","features.multi_agent_v2=false","-c","features.apps=false","-c","features.code_mode_only=false","-c","features.code_mode=false","-c","features.goals=false","-c","features.current_time_reminder=false","-c","features.sleep_tool=false","-c","features.tool_search=false","-c","features.token_budget=false","-c","tools.experimental_request_user_input.enabled=false"];
  if(provider === "claude") {
    const status=await runtime.exec(["/opt/cg/claude","auth","status","--json"]);validateClaudeStatus(status.stdout,status.code,true);
  }
  rpc.assertActive();
  const containerId=await runtime.verifyOperation();
  child=spawn("docker",["exec","-i",containerId,...args],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  child.stderr.on("data",()=>{});child.stdin.on("error",()=>rpc.fail(new ProviderFailure("process")));child.stdout.on("error",()=>rpc.fail(new ProviderFailure("process")));child.on("error",()=>rpc.fail(new ProviderFailure("process")));child.on("close",()=>{void queue.finally(()=>rpc.processExit());});
  const decoder=new BoundedJsonLines(4_194_304,1_048_576),callbacks=new TaskCallbackGuard();
  let threadId:string|undefined,turnId:string|undefined,earlyTurn:unknown,turnRequested=false,queue=Promise.resolve();
  input=new BoundedJsonInput(4_194_304,1_048_576);input.on("error",()=>rpc.fail(new ProviderFailure("protocol")));
  lines=createInterface({input,crlfDelay:Infinity});child.stdout.pipe(input);
  lines.on("error",()=>rpc.fail(new ProviderFailure("protocol")));
  lines.on("line",line=>{
    // Account for incoming bytes before waiting for a running tool callback.
    // This also bounds all queued messages by the total stream limit.
    let event:Record<string,any>;
    try{event=decoder.decode(line);}catch{rpc.fail(new ProviderFailure("protocol"));return;}
    queue=queue.then(async()=>{
      rpc.assertHealthy();
      if(provider === "claude") {
        claudeModelGuard.observe(event);
        if(claudeModelGuard.observedModel)report.observed_model=claudeModelGuard.observedModel;
        if(event.type === "result"){
          report.provider_result={is_error:event.is_error===true,subtype:["success","error_during_execution","error_max_turns","error_max_budget_usd","error_max_structured_output_retries"].includes(event.subtype)?event.subtype:"unknown"};
          validateClaudeResult(event);report.model=claudeModelGuard.observedModel;report.model_verified=true;rpc.finish();}
        else if(typeof event.type!=="string")throw new ProviderFailure("protocol");
      }else if(rpc.response(event))return;
      else if(event.method === "item/tool/call") {
        rpc.assertActive();
        if(!turnRequested)throw new ProviderFailure("protocol");
        const arguments_=callbacks.validate(event,threadId);
        report.task_calls++;assert.ok(report.task_calls<=16,"managed_task_call_limit");
        const reply=await executeTaskTool(task!,arguments_);
        rpc.assertActive();
        const text=Buffer.byteLength(JSON.stringify(reply))>48_000?'{"error":"task_output_limit"}':JSON.stringify(reply);
        child!.stdin.write(JSON.stringify({id:event.id,result:{success:!("error" in reply)&&reply.exit_code===0,contentItems:[{type:"inputText",text}]}})+"\n");
      }else if(Object.hasOwn(event,"id")){
        if(validRpcId(event.id))child!.stdin.write(JSON.stringify({id:event.id,error:{code:-32601,message:"Unsupported callback in coding spike"}})+"\n");
        throw new ProviderFailure("protocol");
      }else if(typeof event.method!=="string"||!event.method||!isRecord(event.params))throw new ProviderFailure("protocol");
      else if(event.method === "turn/completed"){
        if(!turnRequested||!threadId||earlyTurn!==undefined)throw new ProviderFailure("protocol");
        if(turnId){validateCodexTurn(event.params,threadId,turnId);rpc.finish();}
        else earlyTurn=event.params;
      }
      else if(event.method === "error")throw new ProviderFailure(classifyProviderFailure(event.params.error??event.params));
    }).catch(error=>rpc.fail(error instanceof ProviderFailure?error:new ProviderFailure("protocol")));
  });
  if(provider === "claude") {report.real_model_inference_attempted=true;child.stdin.end();}
  else {
    await request("initialize",{clientInfo:{name:"commongrid_managed_coding_spike",version:"0.1.0"},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:"initialized"})+"\n");
    const account=await request("account/read",{refreshToken:true});validateCodexIdentity(account,"refresh");report.managed_refresh_requested=true;
    const models=await request("model/list",{});if(!isRecord(models)||!Array.isArray(models.data)||!models.data.every((item:unknown)=>isRecord(item)&&typeof item.model==="string"&&item.model.length<=128&&typeof item.hidden==="boolean"))throw new ProviderFailure("protocol");report.available_models=models.data.filter((item:any)=>!item.hidden).map((item:any)=>item.model);assert.ok(models.data.some((item:any)=>item.model===codexCodingModel&&!item.hidden),"fixture_validated_model_unavailable");
    const started=await request("thread/start",{model:codexCodingModel,modelProvider:"openai",cwd:"/home/node",approvalPolicy:"never",sandbox:"read-only",ephemeral:true,environments:[],baseInstructions:codingPrompt,dynamicTools:[{type:"function",name:"task_exec",description:"Execute argv only in the isolated /task workspace, with no credentials or network. Paths refer to that workspace.",inputSchema:schema}]});
    if(!isRecord(started)||!isRecord(started.thread))throw new ProviderFailure("protocol");if(started.model!==codexCodingModel)throw new ProviderFailure("model");report.model=codexCodingModel;report.observed_model=codexCodingModel;report.model_verified=true;threadId=started.thread.id;
    if(typeof threadId!=="string"||!threadId||threadId.length>128)throw new ProviderFailure("protocol");
    report.real_model_inference_attempted=true;turnRequested=true;const turn=await request("turn/start",{threadId,input:[{type:"text",text:codingPrompt,text_elements:[]}]});
    if(!isRecord(turn)||!isRecord(turn.turn)||typeof turn.turn.id!=="string"||!turn.turn.id||turn.turn.id.length>128)throw new ProviderFailure("protocol");turnId=turn.turn.id;
    if(earlyTurn!==undefined){validateCodexTurn(earlyTurn,threadId,turnId);rpc.finish();}
  }
  await rpc.done;lines.close();await queue;rpc.assertHealthy();operation.assertActive();assertBridgeHealthy(bridge.stats);rpc.dispose();child.stdout.unpipe(input);input.destroy();
  report.task_calls+=provider === "claude"?bridge.stats.task_calls:0;assert.ok(report.task_calls>0);
  child.stdin.end();child.kill();bridge.close();
  const source=await snapshotCandidate(task);operation.assertActive();
  report.verifier=await verifyCandidate(source);operation.assertActive();assert.equal(report.verifier.passed,true,"managed_candidate_rejected");
  report.diff=await createDiff(source,path.join(directory,"artifact"));operation.assertActive();assertBridgeHealthy(bridge.stats);report.real_coding_verified=true;report.success=true;report.network=bridge.stats;
}catch(error){report.success=false;report.failure=failureCode(error);if(error instanceof ProviderFailure){report.provider_error_category=error.category;if(error.category==="model"||provider==="claude"&&error.category==="protocol"){report.model_verified=false;report.model=null;}}process.exitCode=1;}
finally {
  rpc.dispose();lines?.close();if(input){child?.stdout.unpipe(input);input.destroy();}child?.stdin.end();child?.kill();if(bridge)report.network=bridge.stats;bridge?.close();
  let taskCleanup=true,runtimeCleanup=true;
  try{if(task)await task.close();}catch{taskCleanup=false;}
  try{await runtime.stop();}catch{runtimeCleanup=false;}
  report.cleanup_confirmed=taskCleanup&&runtimeCleanup;if(!report.cleanup_confirmed)process.exitCode=1;
  if(bridge)try{assertBridgeHealthy(bridge.stats);}catch{report.failure??="managed_bridge_control_failed";report.success=false;process.exitCode=1;}
  try{operation.assertActive();}catch{report.failure="managed_provider_canceled";report.provider_error_category="canceled";report.success=false;process.exitCode=1;}
  report.success=report.success===true&&report.cleanup_confirmed;
  process.off("SIGINT",cancel);process.off("SIGTERM",cancel);
  await writeFile(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");console.log(`Managed ${provider} coding: success=${report.success}, cleanup=${report.cleanup_confirmed}`);console.log(`Report: ${path.join(directory,"report.json")}`);
}
