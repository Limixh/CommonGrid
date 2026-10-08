import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeFunctionalTestModelGuard, claudeFunctionalTestObservedModels, claudeFunctionalTestModel, codexFunctionalTestModel, validateClaudeFunctionalTestJsonModel } from "../testing/functional-test-models.ts";
import { ProviderFailure, RpcLifecycle, failureCode } from "../src/session-protocol.ts";

const model=claudeFunctionalTestObservedModels[0];
const init=(selected:unknown=model)=>({type:"system",subtype:"init",model:selected,apiKeySource:"fixture-private-secret"});
const assistant=(selected:unknown=model)=>({type:"assistant",message:{model:selected,content:[{type:"text",text:"fixture-private-secret"}]}});
const result=(usage?:unknown)=>({type:"result",subtype:"success",is_error:false,...(usage===undefined?{}:{modelUsage:usage})});
const rejects=(category:"model"|"protocol")=>(error:unknown)=>{
  assert.ok(error instanceof ProviderFailure);assert.equal(error.category,category);
  assert.equal(error.message,`managed_provider_${category}`);
  assert.equal(JSON.stringify(error).includes("fixture-private"),false);
  assert.equal(error.stack?.includes("fixture-private"),false);
  return true;
};

test("functional-test requests retain Luna and Haiku policy",()=>{
  assert.equal(codexFunctionalTestModel,"gpt-6-luna");assert.equal(claudeFunctionalTestModel,"haiku");
});
test("each exact official Haiku identity passes init, assistant and usage checks",()=>{
  for(const selected of claudeFunctionalTestObservedModels){
    const guard=new ClaudeFunctionalTestModelGuard();
    guard.observe(init(selected));guard.observe(assistant(selected));guard.observe(result({[selected]:{inputTokens:1}}));
    assert.equal(guard.observedModel,selected);
    assert.equal(validateClaudeFunctionalTestJsonModel(result({[selected]:{}})),selected);
  }
});
test("aliases, expensive models, unknown IDs and private strings are rejected without disclosure",()=>{
  for(const selected of ["haiku","default","sonnet","opus","claude-sonnet-4-6","claude-opus-4-6","claude-haiku-unknown","prefix-claude-haiku-5-5","fixture-private-secret"]){
    const guard=new ClaudeFunctionalTestModelGuard();
    assert.throws(()=>guard.observe(init(selected)),rejects("model"));
    assert.equal(guard.observedModel,undefined);
    assert.throws(()=>guard.observe(init(model)),rejects("model"),"failed selection is sticky");
    assert.throws(()=>validateClaudeFunctionalTestJsonModel(result({[selected]:{}})),rejects("model"));
  }
});
test("missing and malformed init identities fail before acceptance",()=>{
  for(const selected of [undefined,null,{},[],1,""]){
    const guard=new ClaudeFunctionalTestModelGuard();assert.throws(()=>guard.observe({...init(),model:selected}),rejects("protocol"));
  }
  for(const event of [null,[],{},assistant(),result()]){
    const guard=new ClaudeFunctionalTestModelGuard();assert.throws(()=>guard.observe(event),rejects("protocol"));
  }
});
test("duplicate init and model events after completion are protocol failures",()=>{
  const duplicate=new ClaudeFunctionalTestModelGuard();duplicate.observe(init());
  assert.throws(()=>duplicate.observe(init()),rejects("protocol"));
  for(const event of [init(),assistant(),result()]){
    const guard=new ClaudeFunctionalTestModelGuard();guard.observe(init());guard.observe(result());
    assert.throws(()=>guard.observe(event),rejects("protocol"));
  }
});
test("later assistant model changes and missing model fields fail closed",()=>{
  for(const selected of ["claude-sonnet-4-6","fixture-private-secret",claudeFunctionalTestObservedModels[2]]){
    const guard=new ClaudeFunctionalTestModelGuard();guard.observe(init());
    assert.throws(()=>guard.observe(assistant(selected)),rejects("model"));
    assert.throws(()=>guard.observe(result()),rejects("model"));
  }
  for(const event of [{type:"assistant"},{type:"assistant",message:{}},assistant(null)]){
    const guard=new ClaudeFunctionalTestModelGuard();guard.observe(init());assert.throws(()=>guard.observe(event),rejects("protocol"));
  }
});
test("aggregate modelUsage must be nonempty structured actual model evidence",()=>{
  for(const usage of [undefined,null,[],{}, {[model]:null}]){
    assert.throws(()=>validateClaudeFunctionalTestJsonModel(result(usage)),rejects("protocol"));
  }
  assert.throws(()=>validateClaudeFunctionalTestJsonModel({type:"result",subtype:"error_during_execution",is_error:true,modelUsage:{[model]:{}}}),rejects("protocol"));
});
test("mixed, expensive and changed aggregate usage cannot pass even with a valid init",()=>{
  for(const usage of [{[model]:{},"claude-sonnet-4-6":{}},{[model]:{},"fixture-private-secret":{}},{[model]:{},[claudeFunctionalTestObservedModels[2]]:{}}]){
    const guard=new ClaudeFunctionalTestModelGuard();guard.observe(init());
    assert.throws(()=>guard.observe(result(usage)),rejects("model"));
    assert.throws(()=>validateClaudeFunctionalTestJsonModel(result(usage)),rejects("model"));
  }
  const changed=new ClaudeFunctionalTestModelGuard();changed.observe(init());
  assert.throws(()=>changed.observe(result({[claudeFunctionalTestObservedModels[2]]:{}})),rejects("model"));
});
test("pre-init provider error can retain its category without claiming an observed model",()=>{
  const guard=new ClaudeFunctionalTestModelGuard();guard.observe({type:"result",subtype:"error_during_execution",is_error:true});
  assert.equal(guard.observedModel,undefined);
});
test("model rejection terminates RPC and immediate stop actions before any later request",async()=>{
  const actions:string[]=[],guard=new ClaudeFunctionalTestModelGuard();
  const rpc=new RpcLifecycle(()=>actions.push("unexpected_request"),1000,()=>{actions.push("bridge_close","child_end","child_kill");});
  try {
    try{guard.observe(init("claude-sonnet-4-6"));}catch(error){rpc.fail(error as ProviderFailure);}
    await assert.rejects(rpc.done,rejects("model"));
    await assert.rejects(rpc.request("turn/start",{}),rejects("model"));
    assert.deepEqual(actions,["bridge_close","child_end","child_kill"]);
    const report={success:false,failure:failureCode(new ProviderFailure("model")),requested_model:claudeFunctionalTestModel,observed_model:guard.observedModel??null,model_verified:false};
    assert.equal(report.observed_model,null);assert.equal(report.model_verified,false);
  }finally{rpc.dispose();}
});
