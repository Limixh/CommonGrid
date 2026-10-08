import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManagedSessionArgs } from "./managed-session.mts";

const owner="2a1dab0e-7b5f-407b-b80b-efb88ae628d0";
const selection=["--host-trust-pem","D:\\chosen root.pem","--host-trust-proof","D:\\chosen proof.json"];

test("prepare uses bundled trust without a local file selection",()=>{
  for(const provider of ["claude","codex"]){
    assert.deepEqual(parseManagedSessionArgs(["prepare",provider]),{command:"prepare",provider,owner:undefined,hostTrust:undefined});
  }
});
test("optional trust requires both explicit files for one Claude profile",()=>{
  for(const command of ["prepare","install-host-trust"]){
    const prefix=command==="prepare"?[command,"claude"]:[command,"claude",owner];
    const expected={command,provider:"claude",owner:command==="prepare"?undefined:owner,hostTrust:{pemPath:selection[1],proofPath:selection[3]}};
    assert.deepEqual(parseManagedSessionArgs([...prefix,...selection]),expected);
    assert.deepEqual(parseManagedSessionArgs([...prefix,...selection.slice(2),...selection.slice(0,2)]),expected);
  }
});
test("profile operations validate identity before any metadata or runtime access",()=>{
  for(const command of ["install-trust","install-coding-profile","status","login","refresh","logout","destroy"]){
    for(const provider of ["claude","codex"]){
      assert.equal(parseManagedSessionArgs([command,provider,owner]).owner,owner);
      for(const invalid of [undefined,"../private","",owner.toUpperCase(),owner.replace("407b","307b"),"not-a-profile"]){
        const args=invalid===undefined?[command,provider]:[command,provider,invalid];
        assert.throws(()=>parseManagedSessionArgs(args),{message:"managed_session_args_invalid"});
      }
    }
  }
});
test("ambiguous, incomplete or unrelated trust arguments are rejected",()=>{
  const cases=[
    [],["unknown","claude"],["prepare","unknown"],["prepare","claude",owner],
    ["install-host-trust","claude",owner],
    ["prepare","claude",...selection.slice(0,2)],
    ["prepare","claude",...selection,...selection],
    ["prepare","claude","--host-trust-pem","root.pem","--host-trust-pem","other.pem"],
    ["prepare","claude","--host-trust-pem","root.pem","--unknown","proof.json"],
    ["prepare","codex",...selection],["install-host-trust","codex",owner,...selection],
    ...["install-trust","install-coding-profile","status","login","refresh","logout","destroy"].map(command=>[command,"claude",owner,...selection]),
    ...[""," ","--host-trust-proof","root\u0000.pem","root\n.pem","root\r.pem"].map(value=>["prepare","claude","--host-trust-pem",value,"--host-trust-proof","proof.json"]),
  ];
  for(const args of cases)assert.throws(()=>parseManagedSessionArgs(args),/^(?:Error: )?managed_(?:session_args_invalid|host_trust_selection_required)$/);
});
