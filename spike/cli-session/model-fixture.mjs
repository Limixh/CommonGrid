// Deterministic local wire fixtures. These are not model inference, token usage
// measurements or real-provider/account evidence.
export function toolNames(tools = []) {
  return tools.flatMap((tool) => tool.type === "namespace" ? (tool.tools ?? []).map((nested) => `${tool.name}.${nested.name}`) : [tool.name ?? tool.function?.name ?? tool.type]);
}
export function advertisedToolNames(body) {
  return [...new Set(toolNames(body.tools).concat((body.input ?? []).filter((item) => item.type === "additional_tools").flatMap((item) => toolNames(item.tools))))];
}
export function claudeEvents(name, args, model, done = false) {
  const block = done ? { type: "text", text: "Fixture completed." } : { type: "tool_use", id: "call_fixture", name, input: {} };
  return [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: done ? { type: "text", text: "" } : block },
    { type: "content_block_delta", index: 0, delta: done ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(args) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
}
export function codexEvents(name, args, model, done = false) {
  // Keep the inventory qualified; Responses calls carry namespace separately.
  const functionIdentity = name === "functions.task_exec" ? { name: "task_exec", namespace: "functions" } : { name };
  const response = { id: "resp_fixture", object: "response", created_at: 1, model, status: "in_progress", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const item = done ? { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture completed.", annotations: [] }], status: "completed" } : { id: "fc_fixture", type: "function_call", call_id: "call_fixture", ...functionIdentity, arguments: JSON.stringify(args), status: "completed" };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: done ? { ...item, content: [], status: "in_progress" } : { ...item, arguments: "", status: "in_progress" } },
    ...(done ? [
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Fixture completed." },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "Fixture completed." },
    ] : [
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", output: [item] } },
  ];
}
