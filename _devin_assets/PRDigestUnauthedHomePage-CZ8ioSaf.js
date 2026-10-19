import{n as e}from"./rolldown-runtime-C0FnF6B9.js";import{_t as t,gt as n}from"./app-initial-DidTZFDP.js";import{Kl as r,zs as i}from"./helpers-B8eh1ViS.js";import{t as a}from"./react-B3wg_K76.js";import{t as o}from"./jsx-runtime-BdxMnOeJ.js";import{r as s,t as c}from"./link-6OiMDHJY.js";import{Ft as l,It as u}from"./ScrollAreaCorner-C-sn5SVv.js";import{It as d,Pt as ee}from"./app-initial-8fmMceYE.js";import{c_ as f,cv as p,lv as m,s_ as te}from"./central-icons-Ca-e14_a.js";import{Tt as h,wt as ne}from"./app-initial-C1_LlZmJ.js";import{dr as g,fr as _}from"./app-initial-B_-dZb-D.js";import{B as re,z as ie}from"./app-initial-D-pQhXyv.js";import{X as ae,Y as oe,k as se,x as ce}from"./host-embedded-Bb4tMi_e.js";import{n as le,r as ue}from"./useNavigate-JptBsM-o.js";import{Y as de,q as fe}from"./app-initial-BRRsdy1n.js";import{C as pe,b as me}from"./app-initial-3XpEMiTp.js";import{F as he,N as ge,nn as _e,ot as ve,st as ye,tn as be}from"./app-initial-Bhot5TsV.js";import{at as xe,ct as Se,it as Ce,ot as we,rt as Te}from"./app-initial-Aonpig8Z.js";import{n as Ee,t as De}from"./Trans-B6Lrsb_Y.js";import{fn as Oe,pn as ke}from"./app-initial-C4_91278.js";import{n as Ae,t as je}from"./useTimeSpentTracker-ugF5-t0d.js";import{at as Me,it as Ne}from"./app-initial-CjPkusmS.js";import{D as v,O as Pe}from"./lib-hdcpZ3gz.js";import{F as y,H as Fe,I as b,U as Ie,it as Le,n as x,o as Re,rt as ze,s as Be,t as S}from"./proxy-DuRtql75.js";import{n as Ve,t as He}from"./use-transform-DBsunO2A.js";import{n as Ue,t as We}from"./use-motion-value-VKwMvSer.js";import{n as Ge,t as Ke}from"./use-reduced-motion-BYstmvnw.js";import{o as qe,s as Je}from"./RenderDisplayItems-DsC1M0wp.js";import{f as Ye,h as Xe,m as Ze,n as Qe,p as $e,r as et}from"./PRDetailPage-CpdtUIcF.js";import{M as tt,N as nt}from"./app-initial-L0oq9fn7.js";import{a as rt,i as it,n as at,r as ot,t as st}from"./floatingCardOverlayStore-DU4Dr7mu.js";import{At as ct,B as lt,Ct as ut,Et as dt,H as ft,R as pt,T as mt,Tt as ht,U as gt,V as _t,c as vt,ct as yt,kt as bt,l as xt,lt as St,p as Ct,w as wt,wt as Tt,z as Et}from"./ReviewStoppedBanner-DciUxX2-.js";import{bt as Dt,vt as Ot}from"./CopyableBranchName-BbNNNFe8.js";import{n as kt,t as At}from"./SectionCard-BUjXq426.js";function jt(e,t,n={}){let r=e.get(),i=null,a=r,o,s=typeof r==`string`?r.replace(/[\d.-]/g,``):void 0,c=()=>{i&&=(i.stop(),null),e.animation=void 0},l=()=>{let t=w(e.get()),r=w(a);if(t===r){c();return}let s=i?i.getGeneratorVelocity():e.getVelocity();c(),i=new Fe({keyframes:[t,r],velocity:s,type:`spring`,restDelta:.001,restSpeed:.01,...n,onUpdate:o})},u=()=>{l(),e.animation=i??void 0,e.events.animationStart?.notify(),i?.then(()=>{e.animation=void 0,e.events.animationComplete?.notify()})};if(e.attach((e,t)=>{a=e,o=e=>t(C(e,s)),ze.postRender(u)},c),b(t)){let r=n.skipInitialAnimation===!0,i=t.on(`change`,t=>{r?(r=!1,e.jump(C(t,s),!1)):e.set(C(t,s))}),a=e.on(`destroy`,i);return()=>{i(),a()}}return c}function C(e,t){return t?e+t:e}function w(e){return typeof e==`number`?e:parseFloat(e)}function T(){return(T=e((()=>{Ie(),y(),Le()})))()}function Mt(e,t,n){(0,E.useInsertionEffect)(()=>e.on(t,n),[e,t,n])}var E;function D(){return(D=e((()=>{E=a()})))()}function Nt(e,t={}){let{isStatic:n}=(0,O.useContext)(Re),r=()=>b(e)?e.get():e;if(n)return Ve(r);let i=Ue(r());return(0,O.useInsertionEffect)(()=>jt(i,e,t),[i,JSON.stringify(t)]),i}var O;function k(){return(k=e((()=>{T(),y(),O=a(),Be(),We(),He()})))()}function Pt(e,t={}){return Nt(e,{type:`spring`,...t})}function A(){return(A=e((()=>{k()})))()}function j({text:e,direction:t=`down-right`,className:n,glow:r=!1}){let{curve:i,head:a}=N[t],o=t===`up-right`||t===`up-left`,s=(0,M.jsx)(`span`,{className:`text-22 text-text-primary block opacity-70`,style:{fontFamily:`'Excalifont', 'Virgil', 'Segoe Print', 'Bradley Hand', cursive`,...r&&{textShadow:`0 0 2px color-mix(in srgb, currentColor 80%, transparent)`}},children:e}),c=(0,M.jsxs)(`svg`,{width:`80`,height:`60`,viewBox:`0 0 80 60`,fill:`none`,className:g(`opacity-70`,o?`mb-1`:`mt-1`,t===`down-right`&&`ml-16`,t===`down-left`&&`mr-16`,t===`up-right`&&`ml-16`,t===`up-left`&&`mr-16 rotate-[-60deg]`),"aria-hidden":`true`,focusable:`false`,children:[(0,M.jsx)(`defs`,{children:(0,M.jsxs)(`filter`,{id:`glow`,x:`-50%`,y:`-50%`,width:`200%`,height:`200%`,children:[(0,M.jsx)(`feGaussianBlur`,{stdDeviation:`2`,result:`blur`}),(0,M.jsxs)(`feMerge`,{children:[(0,M.jsx)(`feMergeNode`,{in:`blur`}),(0,M.jsx)(`feMergeNode`,{in:`SourceGraphic`})]})]})}),(0,M.jsx)(`path`,{d:i,stroke:`currentColor`,strokeWidth:`2`,strokeLinecap:`round`,className:`text-text-primary`,fill:`none`,filter:r?`url(#glow)`:void 0}),(0,M.jsx)(`path`,{d:a,stroke:`currentColor`,strokeWidth:`2`,strokeLinecap:`round`,strokeLinejoin:`round`,className:`text-text-primary`,fill:`none`,filter:r?`url(#glow)`:void 0})]});return(0,M.jsxs)(x.div,{className:g(`pointer-events-none`,n),initial:{opacity:0},animate:{opacity:1},transition:{duration:.3,delay:.3,ease:`easeOut`},children:[s,c]})}var M,N;function P(){return(P=e((()=>{_(),S(),M=o(),N={"down-right":{curve:`M5 5 C 20 5, 40 10, 50 25 C 60 40, 65 50, 70 55`,head:`M62 52 L 70 55 L 68 46`},"down-left":{curve:`M75 5 C 60 5, 40 10, 30 25 C 20 40, 15 50, 10 55`,head:`M18 52 L 10 55 L 12 46`},"up-right":{curve:`M5 55 C 20 55, 40 50, 50 35 C 60 20, 65 10, 70 5`,head:`M62 8 L 70 5 L 68 14`},"up-left":{curve:`M75 55 C 60 55, 40 50, 30 35 C 20 20, 15 10, 10 5`,head:`M18 8 L 10 5 L 12 14`}}})))()}var F;function I(){return(I=e((()=>{F=`/assets/digest1-73Lo_BD4.png`})))()}var L;function Ft(){return(Ft=e((()=>{L=`/assets/digest2-DcxmoGy3.png`})))()}var R;function It(){return(It=e((()=>{R=`/assets/digest3-UqYbjBNV.png`})))()}var z;function Lt(){return(Lt=e((()=>{z={"sgl-router/src/routers/grpc/regular/responses/conversions.rs":`//! Conversion utilities for translating between /v1/responses and /v1/chat/completions formats
//!
//! This module implements the conversion approach where:
//! 1. ResponsesRequest → ChatCompletionRequest (for backend processing)
//! 2. ChatCompletionResponse → ResponsesResponse (for client response)
//!
//! This allows the gRPC router to reuse the existing chat pipeline infrastructure
//! without requiring Python backend changes.

use crate::protocols::{
    chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage, UserMessageContent},
    common::{FunctionCallResponse, StreamOptions, ToolCall, UsageInfo},
    responses::{
        ResponseContentPart, ResponseInput, ResponseInputOutputItem, ResponseOutputItem,
        ResponseReasoningContent::ReasoningText, ResponseStatus, ResponsesRequest,
        ResponsesResponse, ResponsesUsage, StringOrContentParts,
    },
};

/// Convert a ResponsesRequest to ChatCompletionRequest for processing through the chat pipeline
///
/// # Conversion Logic
/// - \`input\` (text/items) → \`messages\` (chat messages)
/// - \`instructions\` → system message (prepended)
/// - \`max_output_tokens\` → \`max_completion_tokens\`
/// - Tool-related fields are passed through
/// - Response-specific fields (previous_response_id, conversation) are handled by router
pub fn responses_to_chat(req: &ResponsesRequest) -> Result<ChatCompletionRequest, String> {
    let mut messages = Vec::new();

    // 1. Add system message if instructions provided
    if let Some(instructions) = &req.instructions {
        messages.push(ChatMessage::System {
            content: instructions.clone(),
            name: None,
        });
    }

    // 2. Convert input to chat messages
    match &req.input {
        ResponseInput::Text(text) => {
            // Simple text input → user message
            messages.push(ChatMessage::User {
                content: UserMessageContent::Text(text.clone()),
                name: None,
            });
        }
        ResponseInput::Items(items) => {
            // Structured items → convert each to appropriate chat message
            for item in items {
                match item {
                    ResponseInputOutputItem::SimpleInputMessage { content, role, .. } => {
                        // Convert SimpleInputMessage to chat message
                        let text = match content {
                            StringOrContentParts::String(s) => s.clone(),
                            StringOrContentParts::Array(parts) => {
                                // Extract text from content parts (only InputText supported)
                                parts
                                    .iter()
                                    .filter_map(|part| match part {
                                        ResponseContentPart::InputText { text } => {
                                            Some(text.as_str())
                                        }
                                        _ => None,
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            }
                        };

                        match role.as_str() {
                            "user" => {
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                            "assistant" => {
                                messages.push(ChatMessage::Assistant {
                                    content: Some(text),
                                    name: None,
                                    tool_calls: None,
                                    reasoning_content: None,
                                });
                            }
                            "system" => {
                                messages.push(ChatMessage::System {
                                    content: text,
                                    name: None,
                                });
                            }
                            _ => {
                                // Unknown role, treat as user message
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                        }
                    }
                    ResponseInputOutputItem::Message { role, content, .. } => {
                        // Extract text from content parts
                        let text = extract_text_from_content(content);

                        match role.as_str() {
                            "user" => {
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                            "assistant" => {
                                messages.push(ChatMessage::Assistant {
                                    content: Some(text),
                                    name: None,
                                    tool_calls: None,
                                    reasoning_content: None,
                                });
                            }
                            "system" => {
                                messages.push(ChatMessage::System {
                                    content: text,
                                    name: None,
                                });
                            }
                            _ => {
                                // Unknown role, treat as user message
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                        }
                    }
                    ResponseInputOutputItem::FunctionToolCall {
                        id,
                        name,
                        arguments,
                        output,
                        ..
                    } => {
                        // Tool call from history - add as assistant message with tool call
                        // followed by tool response if output exists

                        // Add assistant message with tool_calls (the LLM's decision)
                        messages.push(ChatMessage::Assistant {
                            content: None,
                            name: None,
                            tool_calls: Some(vec![ToolCall {
                                id: id.clone(),
                                tool_type: "function".to_string(),
                                function: FunctionCallResponse {
                                    name: name.clone(),
                                    arguments: Some(arguments.clone()),
                                },
                            }]),
                            reasoning_content: None,
                        });

                        // Add tool result message if output exists
                        if let Some(output_text) = output {
                            messages.push(ChatMessage::Tool {
                                content: output_text.clone(),
                                tool_call_id: id.clone(),
                            });
                        }
                    }
                    ResponseInputOutputItem::Reasoning { content, .. } => {
                        // Reasoning content - add as assistant message with reasoning_content
                        let reasoning_text = content
                            .iter()
                            .map(|c| match c {
                                ReasoningText { text } => text.as_str(),
                            })
                            .collect::<Vec<_>>()
                            .join("\\n");

                        messages.push(ChatMessage::Assistant {
                            content: None,
                            name: None,
                            tool_calls: None,
                            reasoning_content: Some(reasoning_text),
                        });
                    }
                    ResponseInputOutputItem::FunctionCallOutput {
                        call_id, output, ..
                    } => {
                        // Function call output - add as tool message
                        // Note: The function name is looked up from prev_outputs in Harmony path
                        // For Chat path, we just use the call_id
                        messages.push(ChatMessage::Tool {
                            content: output.clone(),
                            tool_call_id: call_id.clone(),
                        });
                    }
                }
            }
        }
    }

    // Ensure we have at least one message
    if messages.is_empty() {
        return Err("Request must contain at least one message".to_string());
    }

    // 3. Build ChatCompletionRequest
    let is_streaming = req.stream.unwrap_or(false);

    Ok(ChatCompletionRequest {
        messages,
        model: if req.model.is_empty() {
            "default".to_string()
        } else {
            req.model.clone()
        },
        temperature: req.temperature,
        max_completion_tokens: req.max_output_tokens,
        stream: is_streaming,
        stream_options: if is_streaming {
            Some(StreamOptions {
                include_usage: Some(true),
            })
        } else {
            None
        },
        parallel_tool_calls: req.parallel_tool_calls,
        top_logprobs: req.top_logprobs,
        top_p: req.top_p,
        skip_special_tokens: true,
        // Note: tools and tool_choice will be handled separately for MCP transformation
        tools: None,       // Will be set by caller if needed
        tool_choice: None, // Will be set by caller if needed
        ..Default::default()
    })
}

/// Extract text content from ResponseContentPart array
fn extract_text_from_content(content: &[ResponseContentPart]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ResponseContentPart::InputText { text } => Some(text.as_str()),
            ResponseContentPart::OutputText { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Convert a ChatCompletionResponse to ResponsesResponse
///
/// # Conversion Logic
/// - \`id\` → \`response_id_override\` if provided, otherwise \`chat_resp.id\`
/// - \`model\` → \`model\` (pass through)
/// - \`choices[0].message\` → \`output\` array (convert to ResponseOutputItem::Message)
/// - \`choices[0].finish_reason\` → determines \`status\` (stop/length → Completed)
/// - \`created\` timestamp → \`created_at\`
pub fn chat_to_responses(
    chat_resp: &ChatCompletionResponse,
    original_req: &ResponsesRequest,
    response_id_override: Option<String>,
) -> Result<ResponsesResponse, String> {
    // Extract the first choice (responses API doesn't support n>1)
    let choice = chat_resp
        .choices
        .first()
        .ok_or_else(|| "Chat response contains no choices".to_string())?;

    // Convert assistant message to output items
    let mut output: Vec<ResponseOutputItem> = Vec::new();

    // Convert message content to output item
    if let Some(content) = &choice.message.content {
        if !content.is_empty() {
            output.push(ResponseOutputItem::Message {
                id: format!("msg_{}", chat_resp.id),
                role: "assistant".to_string(),
                content: vec![ResponseContentPart::OutputText {
                    text: content.clone(),
                    annotations: vec![],
                    logprobs: choice.logprobs.clone(),
                }],
                status: "completed".to_string(),
            });
        }
    }

    // Convert reasoning content if present (O1-style models)
    if let Some(reasoning) = &choice.message.reasoning_content {
        if !reasoning.is_empty() {
            output.push(ResponseOutputItem::Reasoning {
                id: format!("reasoning_{}", chat_resp.id),
                summary: vec![],
                content: vec![ReasoningText {
                    text: reasoning.clone(),
                }],
                status: Some("completed".to_string()),
            });
        }
    }

    // Convert tool calls if present
    if let Some(tool_calls) = &choice.message.tool_calls {
        for tool_call in tool_calls {
            output.push(ResponseOutputItem::FunctionToolCall {
                id: tool_call.id.clone(),
                call_id: tool_call.id.clone(),
                name: tool_call.function.name.clone(),
                arguments: tool_call.function.arguments.clone().unwrap_or_default(),
                output: None, // Tool hasn't been executed yet
                status: "in_progress".to_string(),
            });
        }
    }

    // Determine response status based on finish_reason
    let status = match choice.finish_reason.as_deref() {
        Some("stop") | Some("length") => ResponseStatus::Completed,
        Some("tool_calls") => ResponseStatus::InProgress, // Waiting for tool execution
        Some("failed") | Some("error") => ResponseStatus::Failed,
        _ => ResponseStatus::Completed, // Default to completed
    };

    // Convert usage from Usage to UsageInfo, then wrap in ResponsesUsage
    let usage = chat_resp.usage.as_ref().map(|u| {
        let usage_info = UsageInfo {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            reasoning_tokens: u
                .completion_tokens_details
                .as_ref()
                .and_then(|d| d.reasoning_tokens),
            prompt_tokens_details: None, // Chat response doesn't have this
        };
        ResponsesUsage::Classic(usage_info)
    });

    // Generate response
    Ok(ResponsesResponse {
        id: response_id_override.unwrap_or_else(|| chat_resp.id.clone()),
        object: "response".to_string(),
        created_at: chat_resp.created as i64,
        status,
        error: None,
        incomplete_details: None,
        instructions: original_req.instructions.clone(),
        max_output_tokens: original_req.max_output_tokens,
        model: chat_resp.model.clone(),
        output,
        parallel_tool_calls: original_req.parallel_tool_calls.unwrap_or(true),
        previous_response_id: original_req.previous_response_id.clone(),
        reasoning: None, // TODO: Map reasoning effort if needed
        store: original_req.store.unwrap_or(true),
        temperature: original_req.temperature,
        text: None,
        tool_choice: "auto".to_string(), // TODO: Map from original request
        tools: original_req.tools.clone().unwrap_or_default(),
        top_p: original_req.top_p,
        truncation: None,
        usage,
        user: None,
        safety_identifier: original_req.user.clone(),
        metadata: original_req.metadata.clone().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_input_conversion() {
        let req = ResponsesRequest {
            input: ResponseInput::Text("Hello, world!".to_string()),
            instructions: Some("You are a helpful assistant.".to_string()),
            model: "gpt-4".to_string(),
            temperature: Some(0.7),
            ..Default::default()
        };

        let chat_req = responses_to_chat(&req).unwrap();
        assert_eq!(chat_req.messages.len(), 2); // system + user
        assert_eq!(chat_req.model, "gpt-4");
        assert_eq!(chat_req.temperature, Some(0.7));
    }

    #[test]
    fn test_items_input_conversion() {
        let req = ResponsesRequest {
            input: ResponseInput::Items(vec![
                ResponseInputOutputItem::Message {
                    id: "msg_1".to_string(),
                    role: "user".to_string(),
                    content: vec![ResponseContentPart::InputText {
                        text: "Hello!".to_string(),
                    }],
                    status: None,
                },
                ResponseInputOutputItem::Message {
                    id: "msg_2".to_string(),
                    role: "assistant".to_string(),
                    content: vec![ResponseContentPart::OutputText {
                        text: "Hi there!".to_string(),
                        annotations: vec![],
                        logprobs: None,
                    }],
                    status: None,
                },
            ]),
            ..Default::default()
        };

        let chat_req = responses_to_chat(&req).unwrap();
        assert_eq!(chat_req.messages.len(), 2); // user + assistant
    }

    #[test]
    fn test_empty_input_error() {
        let req = ResponsesRequest {
            input: ResponseInput::Text("".to_string()),
            ..Default::default()
        };

        // Empty text should still create a user message, so this should succeed
        let result = responses_to_chat(&req);
        assert!(result.is_ok());
    }
}`,"src/bun.js/test/timers/FakeTimers.zig":`#active: bool = false,
/// The sorted fake timers. TimerHeap is not optimal here because we need these operations:
/// - peek/takeFirst (provided by TimerHeap)
/// - peekLast (cannot be implemented efficiently with TimerHeap)
/// - count (cannot be implemented efficiently with TimerHeap)
timers: TimerHeap = .{ .context = {} },

pub var current_time: struct {
    const min_timespec = bun.timespec{ .sec = std.math.minInt(i64), .nsec = std.math.minInt(i64) };
    /// starts at 0. offset in milliseconds.
    offset_raw: bun.timespec = min_timespec,
    offset_lock: std.Thread.RwLock = .{},
    date_now_offset: f64 = 0,
    pub fn getTimespecNow(this: *@This()) ?bun.timespec {
        this.offset_lock.lockShared();
        defer this.offset_lock.unlockShared();
        const value = this.offset_raw;
        if (value.eql(&min_timespec)) return null;
        return value;
    }
    pub fn set(this: *@This(), globalObject: *jsc.JSGlobalObject, v: struct {
        offset: *const bun.timespec,
        js: ?f64 = null,
    }) void {
        const vm = globalObject.bunVM();
        {
            this.offset_lock.lock();
            defer this.offset_lock.unlock();
            this.offset_raw = v.offset.*;
        }
        const timespec_ms: f64 = @floatFromInt(v.offset.ms());
        if (v.js) |js| {
            this.date_now_offset = @floor(js) - timespec_ms;
        }
        bun.cpp.JSMock__setOverridenDateNow(globalObject, this.date_now_offset + timespec_ms);

        vm.overridden_performance_now = @bitCast(v.offset.ns());
    }
    pub fn clear(this: *@This(), globalObject: *jsc.JSGlobalObject) void {
        const vm = globalObject.bunVM();
        {
            this.offset_lock.lock();
            defer this.offset_lock.unlock();
            this.offset_raw = min_timespec;
        }
        bun.cpp.JSMock__setOverridenDateNow(globalObject, -1);
        vm.overridden_performance_now = null;
    }
} = .{};

fn assertValid(this: *FakeTimers, mode: enum { locked, unlocked }) void {
    if (!bun.Environment.ci_assert) return;
    const owner: *bun.api.Timer.All = @fieldParentPtr("fake_timers", this);
    switch (mode) {
        .locked => bun.assert(owner.lock.tryLock() == false),
        .unlocked => {}, // can't assert unlocked because another thread could be holding the lock
    }
}

pub fn isActive(this: *FakeTimers) bool {
    this.assertValid(.locked);
    defer this.assertValid(.locked);

    return this.#active;
}
fn activate(this: *FakeTimers, js_now: f64, globalObject: *jsc.JSGlobalObject) void {
    this.assertValid(.locked);
    defer this.assertValid(.locked);

    this.#active = true;
    current_time.set(globalObject, .{ .offset = &.epoch, .js = js_now });
}
fn deactivate(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {
    this.assertValid(.locked);
    defer this.assertValid(.locked);

    this.clear();
    current_time.clear(globalObject);
    this.#active = false;
}
fn clear(this: *FakeTimers) void {
    this.assertValid(.locked);
    defer this.assertValid(.locked);

    while (this.timers.deleteMin()) |timer| {
        timer.state = .CANCELLED;
        timer.in_heap = .none;
    }
}
fn executeNext(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) bool {
    this.assertValid(.unlocked);
    defer this.assertValid(.unlocked);
    const vm = globalObject.bunVM();
    const timers = &vm.timer;

    const next = blk: {
        timers.lock.lock();
        defer timers.lock.unlock();
        break :blk this.timers.deleteMin() orelse return false;
    };

    this.fire(globalObject, next);
    return true;
}
fn fire(this: *FakeTimers, globalObject: *jsc.JSGlobalObject, next: *bun.api.Timer.EventLoopTimer) void {
    this.assertValid(.unlocked);
    defer this.assertValid(.unlocked);
    const vm = globalObject.bunVM();

    if (bun.Environment.ci_assert) {
        const prev = current_time.getTimespecNow();
        bun.assert(prev != null);
        bun.assert(next.next.eql(&prev.?) or next.next.greater(&prev.?));
    }
    const now = next.next;
    current_time.set(globalObject, .{ .offset = &now });
    next.fire(&now, vm);
}
fn executeUntil(this: *FakeTimers, globalObject: *jsc.JSGlobalObject, until: bun.timespec) void {
    this.assertValid(.unlocked);
    defer this.assertValid(.unlocked);
    const vm = globalObject.bunVM();
    const timers = &vm.timer;

    while (true) {
        const next = blk: {
            timers.lock.lock();
            defer timers.lock.unlock();

            const peek = this.timers.peek() orelse break;
            if (peek.next.greater(&until)) break;
            bun.assert(this.timers.deleteMin() == peek);
            break :blk peek;
        };
        this.fire(globalObject, next);
    }
}
fn executeOnlyPendingTimers(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {
    this.assertValid(.unlocked);
    defer this.assertValid(.unlocked);
    const vm = globalObject.bunVM();
    const timers = &vm.timer;

    const target = blk: {
        timers.lock.lock();
        defer timers.lock.unlock();
        break :blk this.timers.findMax() orelse return;
    };
    const until = target.next;
    this.executeUntil(globalObject, until);
}
fn executeAllTimers(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {
    this.assertValid(.unlocked);
    defer this.assertValid(.unlocked);

    while (this.executeNext(globalObject)) {}
}

// ===
// JS Functions
// ===

fn errorUnlessFakeTimers(globalObject: *jsc.JSGlobalObject) bun.JSError!void {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;

    {
        timers.lock.lock();
        defer timers.lock.unlock();
        if (this.isActive()) return;
    }
    return globalObject.throw("Fake timers are not active. Call useFakeTimers() first.", .{});
}

fn useFakeTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;

    var js_now = bun.cpp.JSMock__getCurrentUnixTimeMs();

    // Check if options object was provided
    const args = callframe.argumentsAsArray(1);
    if (args.len > 0 and !args[0].isUndefined()) {
        const options_value = args[0];
        var config = try bindgen_generated.FakeTimersConfig.fromJS(globalObject, options_value);
        defer config.deinit();

        // Check if 'now' field is provided
        if (!config.now.isUndefined()) {
            // Handle both number and Date
            if (config.now.isNumber()) {
                js_now = config.now.asNumber();
            } else if (config.now.isDate()) {
                js_now = config.now.getUnixTimestamp();
            } else {
                return globalObject.throwInvalidArguments("'now' must be a number or Date", .{});
            }
        }
    }

    {
        timers.lock.lock();
        defer timers.lock.unlock();
        this.activate(js_now, globalObject);
    }

    return callframe.this();
}
fn useRealTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;

    {
        timers.lock.lock();
        defer timers.lock.unlock();
        this.deactivate(globalObject);
    }

    return callframe.this();
}
fn advanceTimersToNextTimer(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    _ = this.executeNext(globalObject);

    return callframe.this();
}
fn advanceTimersByTime(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    const arg = callframe.argumentsAsArray(1)[0];
    if (!arg.isNumber()) {
        return globalObject.throwInvalidArguments("advanceTimersToNextTimer() expects a number of milliseconds", .{});
    }
    const current = current_time.getTimespecNow() orelse return globalObject.throwInvalidArguments("Fake timers not initialized. Initialize with useFakeTimers() first.", .{});
    const arg_number = arg.asNumber();
    const max_advance = std.math.maxInt(u32);
    if (arg_number < 0 or arg_number > max_advance) {
        return globalObject.throwInvalidArguments("advanceTimersToNextTimer() ms is out of range. It must be >= 0 and <= {d}. Received {d:.0}", .{ max_advance, arg_number });
    }
    const target = current.addMsFloat(arg_number);

    this.executeUntil(globalObject, target);
    current_time.set(globalObject, .{ .offset = &target });

    return callframe.this();
}
fn runOnlyPendingTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    _ = this.executeOnlyPendingTimers(globalObject);

    return callframe.this();
}
fn runAllTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    _ = this.executeAllTimers(globalObject);

    return callframe.this();
}
fn getTimerCount(globalObject: *jsc.JSGlobalObject, _: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    const count = blk: {
        timers.lock.lock();
        defer timers.lock.unlock();
        break :blk this.timers.count();
    };

    return jsc.JSValue.jsNumber(count);
}
fn clearAllTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;
    try errorUnlessFakeTimers(globalObject);

    {
        timers.lock.lock();
        defer timers.lock.unlock();
        this.clear();
    }

    return callframe.this();
}
fn isFakeTimers(globalObject: *jsc.JSGlobalObject, _: *jsc.CallFrame) bun.JSError!jsc.JSValue {
    const vm = globalObject.bunVM();
    const timers = &vm.timer;
    const this = &timers.fake_timers;

    const is_active = blk: {
        timers.lock.lock();
        defer timers.lock.unlock();
        break :blk this.isActive();
    };

    return jsc.JSValue.jsBoolean(is_active);
}

const fake_timers_fns: []const struct { [:0]const u8, u32, (fn (*jsc.JSGlobalObject, *jsc.CallFrame) bun.JSError!jsc.JSValue) } = &.{
    .{ "useFakeTimers", 0, useFakeTimers },
    .{ "useRealTimers", 0, useRealTimers },
    .{ "advanceTimersToNextTimer", 0, advanceTimersToNextTimer },
    .{ "advanceTimersByTime", 1, advanceTimersByTime },
    .{ "runOnlyPendingTimers", 0, runOnlyPendingTimers },
    .{ "runAllTimers", 0, runAllTimers },
    .{ "getTimerCount", 0, getTimerCount },
    .{ "clearAllTimers", 0, clearAllTimers },
    .{ "isFakeTimers", 0, isFakeTimers },
};
pub const timerFnsCount = fake_timers_fns.len;
pub fn putTimersFns(globalObject: *jsc.JSGlobalObject, jest: jsc.JSValue, vi: jsc.JSValue) void {
    inline for (fake_timers_fns) |fake_timer_fn| {
        const str = bun.ZigString.static(fake_timer_fn[0]);
        const jsvalue = jsc.JSFunction.create(globalObject, fake_timer_fn[0], fake_timer_fn[2], fake_timer_fn[1], .{});
        vi.put(globalObject, str, jsvalue);
        jest.put(globalObject, str, jsvalue);
    }
}

const bindgen_generated = @import("bindgen_generated");
const std = @import("std");

const bun = @import("bun");
const jsc = bun.jsc;
const TimerHeap = bun.api.Timer.TimerHeap;
const FakeTimers = bun.jsc.Jest.bun_test.FakeTimers;`}})))()}var Rt,zt,Bt,Vt,Ht,Ut,Wt;function Gt(){return(Gt=e((()=>{Rt={owner:`oven-sh`,repo:`bun`,pr_number:25915,title:`fix(test): make fake timers work with testing-library/react`,description:'## Summary\n\nFixes #25869\n\nTwo fixes to enable `jest.useFakeTimers()` to work with `@testing-library/react` and `@testing-library/user-event`:\n\n- Set `setTimeout.clock = true` when fake timers are enabled. testing-library/react\'s `jestFakeTimersAreEnabled()` checks for this property to determine if `jest.advanceTimersByTime()` should be called when draining the microtask queue. Without this, testing-library never advances timers.\n\n- Make `advanceTimersByTime(0)` fire `setTimeout(fn, 0)` timers. `setTimeout(fn, 0)` is internally scheduled with a 1ms delay per HTML spec. Jest/testing-library expect `advanceTimersByTime(0)` to fire such "immediate" timers, but we were advancing by 0ms so they never fired.\n\n## Test plan\n\n- [x] All 30 existing fake timer tests pass\n- [x] New regression test validates both fixes\n- [x] Original user-event reproduction now works (test completes instead of hanging)\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',base_sha:`596e83c9182bd0de92c12d2aa853a20033f148a3`,head_sha:`4148614eef06e0e65c3ee2a003f59385ac3350b2`,merge_base_sha:`596e83c9182bd0de92c12d2aa853a20033f148a3`,head_ref:`claude/fix-fake-timers-testing-library`,base_ref:`main`,repo_context_id:null},zt=[{title:`Overview`,text:'This PR fixes `jest.useFakeTimers()` hanging when used with `@testing-library/react` and `@testing-library/user-event`.\n\n**Root cause**: testing-library checks if fake timers are enabled before deciding to call `jest.advanceTimersByTime()`. It does this by checking for a `clock` property on `setTimeout`:\n\n```javascript\n// testing-library/react\'s detection\nfunction jestFakeTimersAreEnabled() {\n  return Object.hasOwnProperty.call(\n    setTimeout, \n    \'clock\'\n  );\n}\n```\n\nBun wasn\'t setting this property, so testing-library never advanced timers, causing tests to hang.\n\n**Two fixes**:\n1. Set `setTimeout.clock = true` when fake timers are enabled <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="179-188" />\n2. Make `advanceTimersByTime(0)` fire `setTimeout(fn, 0)` timers (which internally have a 1ms delay per HTML spec) <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="272-276" />',changes:[]},{title:"1. Add `setTimeout.clock` marker for fake timer detection",text:`testing-library/react checks \`Object.hasOwnProperty.call(setTimeout, 'clock')\` to detect if fake timers are active. Without this marker, it never calls \`jest.advanceTimersByTime()\`.

New helper <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="179-188" />:
\`\`\`zig
fn setFakeTimerMarker(
  globalObject, 
  enabled: bool
) void {
  const setTimeout_fn = /* globalThis.setTimeout */;
  // setTimeout.clock = enabled
  setTimeout_fn.put(
    globalObject, 
    "clock", 
    JSValue.jsBoolean(enabled)
  );
}
\`\`\`

Called with \`true\` in \`useFakeTimers()\` <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="226" /> and \`false\` in \`useRealTimers()\` <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="242" />.`,changes:[{file_path:`src/bun.js/test/timers/FakeTimers.zig`,old_file_path:null,pure_rename_id:null,change_type:`modified`,display_info:{blocks_to_show:[{type:`hunk`,hunk:{snippet_id:`0000`,before_lines:[176,175],after_lines:[176,190],before_content:``,after_content:`/// Set or remove the "clock" property on setTimeout to indicate that fake timers are active.
/// This is used by testing-library/react's jestFakeTimersAreEnabled() function to detect
/// if jest.advanceTimersByTime() should be called when draining the microtask queue.
fn setFakeTimerMarker(globalObject: *jsc.JSGlobalObject, enabled: bool) void {
    const globalThis_value = globalObject.toJSValue();
    const setTimeout_fn = (globalThis_value.getOwnTruthy(globalObject, "setTimeout") catch return) orelse return;
    // Set setTimeout.clock to indicate fake timers status.
    // testing-library/react checks Object.hasOwnProperty.call(setTimeout, 'clock')
    // to detect if fake timers are enabled.
    // Note: We set the property to true when enabling and leave it (or set to undefined)
    // when disabling. The hasOwnProperty check will still return true after disabling,
    // but this is acceptable since test environments typically reset between tests.
    setTimeout_fn.put(globalObject, "clock", jsc.JSValue.jsBoolean(enabled));
}
`,important:!1}},{type:`line`,before_line:176,after_line:191,content:`fn useFakeTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {`},{type:`line`,before_line:203,after_line:218,content:`    {`},{type:`line`,before_line:204,after_line:219,content:`        timers.lock.lock();`},{type:`line`,before_line:205,after_line:220,content:`        defer timers.lock.unlock();`},{type:`line`,before_line:206,after_line:221,content:`        this.activate(js_now, globalObject);`},{type:`line`,before_line:207,after_line:222,content:`    }`},{type:`line`,before_line:208,after_line:223,content:``},{type:`hunk`,hunk:{snippet_id:`0001`,before_lines:[209,208],after_lines:[224,227],before_content:``,after_content:`    // Set setTimeout.clock = true to signal that fake timers are enabled.
    // This is used by testing-library/react to detect if jest.advanceTimersByTime should be called.
    setFakeTimerMarker(globalObject, true);
`,important:!1}},{type:`line`,before_line:209,after_line:228,content:`    return callframe.this();`},{type:`line`,before_line:210,after_line:229,content:`}`},{type:`line`,before_line:211,after_line:230,content:`fn useRealTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {`},{type:`line`,before_line:216,after_line:235,content:`    {`},{type:`line`,before_line:217,after_line:236,content:`        timers.lock.lock();`},{type:`line`,before_line:218,after_line:237,content:`        defer timers.lock.unlock();`},{type:`line`,before_line:219,after_line:238,content:`        this.deactivate(globalObject);`},{type:`line`,before_line:220,after_line:239,content:`    }`},{type:`line`,before_line:221,after_line:240,content:``},{type:`hunk`,hunk:{snippet_id:`0002`,before_lines:[222,221],after_lines:[241,243],before_content:``,after_content:`    // Remove the setTimeout.clock marker when switching back to real timers.
    setFakeTimerMarker(globalObject, false);
`,important:!1}},{type:`line`,before_line:222,after_line:244,content:`    return callframe.this();`},{type:`line`,before_line:223,after_line:245,content:`}`}],default_hidden:!1},edits:[{snippet_id:`0000`,file_path:`src/bun.js/test/timers/FakeTimers.zig`,change_type:`modified`,before_lines:[176,175],after_lines:[176,190],before_content:``,after_content:`/// Set or remove the "clock" property on setTimeout to indicate that fake timers are active.
/// This is used by testing-library/react's jestFakeTimersAreEnabled() function to detect
/// if jest.advanceTimersByTime() should be called when draining the microtask queue.
fn setFakeTimerMarker(globalObject: *jsc.JSGlobalObject, enabled: bool) void {
    const globalThis_value = globalObject.toJSValue();
    const setTimeout_fn = (globalThis_value.getOwnTruthy(globalObject, "setTimeout") catch return) orelse return;
    // Set setTimeout.clock to indicate fake timers status.
    // testing-library/react checks Object.hasOwnProperty.call(setTimeout, 'clock')
    // to detect if fake timers are enabled.
    // Note: We set the property to true when enabling and leave it (or set to undefined)
    // when disabling. The hasOwnProperty check will still return true after disabling,
    // but this is acceptable since test environments typically reset between tests.
    setTimeout_fn.put(globalObject, "clock", jsc.JSValue.jsBoolean(enabled));
}
`,important:!1,references:null},{snippet_id:`0001`,file_path:`src/bun.js/test/timers/FakeTimers.zig`,change_type:`modified`,before_lines:[209,208],after_lines:[224,227],before_content:``,after_content:`    // Set setTimeout.clock = true to signal that fake timers are enabled.
    // This is used by testing-library/react to detect if jest.advanceTimersByTime should be called.
    setFakeTimerMarker(globalObject, true);
`,important:!1,references:null},{snippet_id:`0002`,file_path:`src/bun.js/test/timers/FakeTimers.zig`,change_type:`modified`,before_lines:[222,221],after_lines:[241,243],before_content:``,after_content:`    // Remove the setTimeout.clock marker when switching back to real timers.
    setFakeTimerMarker(globalObject, false);
`,important:!1,references:null}]}]},{title:"2. Fix `advanceTimersByTime(0)` not firing immediate timers",text:`Per the HTML spec, \`setTimeout(fn, 0)\` is internally scheduled with a 1ms delay. This meant:

\`\`\`javascript
setTimeout(() => console.log("hi"), 0);
jest.advanceTimersByTime(0);
// "hi" never logged - timer is at 1ms!
\`\`\`

The fix treats \`advanceTimersByTime(0)\` as advancing by 1ms <cite file="src/bun.js/test/timers/FakeTimers.zig" side="R" lines="275-276" />:

\`\`\`zig
// Before:
const target = current.addMsFloat(arg_number);

// After:
const effective_advance = 
  if (arg_number == 0) 1 else arg_number;
const target = current.addMsFloat(effective_advance);
\`\`\``,changes:[{file_path:`src/bun.js/test/timers/FakeTimers.zig`,old_file_path:null,pure_rename_id:null,change_type:`modified`,display_info:{blocks_to_show:[{type:`line`,before_line:234,after_line:256,content:`fn advanceTimersByTime(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {`},{type:`line`,before_line:240,after_line:262,content:`    const arg = callframe.argumentsAsArray(1)[0];`},{type:`line`,before_line:244,after_line:266,content:`    const current = current_time.getTimespecNow() orelse return globalObject.throwInvalidArguments("Fake timers not initialized. Initialize with useFakeTimers() first.", .{});`},{type:`line`,before_line:245,after_line:267,content:`    const arg_number = arg.asNumber();`},{type:`hunk`,hunk:{snippet_id:`0003`,before_lines:[250,250],after_lines:[272,276],before_content:`    const target = current.addMsFloat(arg_number);`,after_content:`    // When advanceTimersByTime(0) is called, advance by 1ms to fire setTimeout(fn, 0) timers.
    // This is because setTimeout(fn, 0) is internally scheduled with a 1ms delay per HTML spec,
    // and Jest/testing-library expect advanceTimersByTime(0) to fire such "immediate" timers.
    const effective_advance = if (arg_number == 0) 1 else arg_number;
    const target = current.addMsFloat(effective_advance);`,important:!1}},{type:`line`,before_line:251,after_line:277,content:``},{type:`line`,before_line:252,after_line:278,content:`    this.executeUntil(globalObject, target);`},{type:`line`,before_line:253,after_line:279,content:`    current_time.set(globalObject, .{ .offset = &target });`},{type:`line`,before_line:254,after_line:280,content:``},{type:`line`,before_line:255,after_line:281,content:`    return callframe.this();`},{type:`line`,before_line:256,after_line:282,content:`}`}],default_hidden:!1},edits:[{snippet_id:`0003`,file_path:`src/bun.js/test/timers/FakeTimers.zig`,change_type:`modified`,before_lines:[250,250],after_lines:[272,276],before_content:`    const target = current.addMsFloat(arg_number);`,after_content:`    // When advanceTimersByTime(0) is called, advance by 1ms to fire setTimeout(fn, 0) timers.
    // This is because setTimeout(fn, 0) is internally scheduled with a 1ms delay per HTML spec,
    // and Jest/testing-library expect advanceTimersByTime(0) to fire such "immediate" timers.
    const effective_advance = if (arg_number == 0) 1 else arg_number;
    const target = current.addMsFloat(effective_advance);`,important:!1,references:null}]}]},{title:`3. Regression tests`,text:'Tests validate both fixes:\n- `setTimeout.clock` marker is set/unset correctly <cite file="test/regression/issue/25869.test.ts" side="R" lines="20-42" />\n- `advanceTimersByTime(0)` fires immediate timers <cite file="test/regression/issue/25869.test.ts" side="R" lines="44-58" />\n- The user-event wait pattern no longer hangs <cite file="test/regression/issue/25869.test.ts" side="R" lines="60-81" />',changes:[{file_path:`test/regression/issue/25869.test.ts`,old_file_path:null,pure_rename_id:null,change_type:`added`,display_info:{blocks_to_show:[{type:`hunk`,hunk:{snippet_id:`0004`,before_lines:null,after_lines:[1,81],before_content:null,after_content:`// https://github.com/oven-sh/bun/issues/25869
// useFakeTimers with testing-library/react hangs when using user-event
import { expect, jest, test } from "bun:test";

// Test that jestFakeTimersAreEnabled() detection works properly.
// testing-library/react checks for setTimeout.clock or setTimeout._isMockFunction
// to determine if fake timers are enabled.
function jestFakeTimersAreEnabled(): boolean {
  // @ts-expect-error - checking for Jest fake timers markers
  if (typeof jest !== "undefined" && jest !== null) {
    return (
      // @ts-expect-error - checking for mock function marker
      (globalThis.setTimeout as any)._isMockFunction === true ||
      Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")
    );
  }
  return false;
}

test("setTimeout.clock is not set before useFakeTimers", () => {
  expect(jestFakeTimersAreEnabled()).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")).toBe(false);
});

test("setTimeout.clock is set after useFakeTimers", () => {
  jest.useFakeTimers();
  try {
    expect(jestFakeTimersAreEnabled()).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("setTimeout.clock is set to false after useRealTimers", () => {
  jest.useFakeTimers();
  jest.useRealTimers();
  // Note: The clock property remains on setTimeout but is set to false.
  // This differs from Jest/Sinon which removes the property entirely.
  // The value being false is sufficient for most use cases.
  expect((globalThis.setTimeout as any).clock).toBe(false);
});

test("advanceTimersByTime(0) fires setTimeout(fn, 0) timers", async () => {
  jest.useFakeTimers();
  try {
    let called = false;
    setTimeout(() => {
      called = true;
    }, 0);

    expect(called).toBe(false);
    jest.advanceTimersByTime(0);
    expect(called).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("user-event style wait pattern does not hang", async () => {
  jest.useFakeTimers();
  try {
    // This is the pattern used by @testing-library/user-event in wait.js
    // It was hanging before the fix because:
    // 1. advanceTimersByTime(0) didn't fire setTimeout(fn, 0) timers
    // 2. jestFakeTimersAreEnabled() returned false, so advanceTimers wasn't called
    const delay = 0;

    const result = await Promise.all([
      new Promise<string>(resolve => globalThis.setTimeout(() => resolve("timeout"), delay)),
      Promise.resolve().then(() => {
        jest.advanceTimersByTime(delay);
        return "advanced";
      }),
    ]);

    expect(result).toEqual(["timeout", "advanced"]);
  } finally {
    jest.useRealTimers();
  }
});`,important:!1}}],default_hidden:!1},edits:[{snippet_id:`0004`,file_path:`test/regression/issue/25869.test.ts`,change_type:`added`,before_lines:null,after_lines:[1,81],before_content:null,after_content:`// https://github.com/oven-sh/bun/issues/25869
// useFakeTimers with testing-library/react hangs when using user-event
import { expect, jest, test } from "bun:test";

// Test that jestFakeTimersAreEnabled() detection works properly.
// testing-library/react checks for setTimeout.clock or setTimeout._isMockFunction
// to determine if fake timers are enabled.
function jestFakeTimersAreEnabled(): boolean {
  // @ts-expect-error - checking for Jest fake timers markers
  if (typeof jest !== "undefined" && jest !== null) {
    return (
      // @ts-expect-error - checking for mock function marker
      (globalThis.setTimeout as any)._isMockFunction === true ||
      Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")
    );
  }
  return false;
}

test("setTimeout.clock is not set before useFakeTimers", () => {
  expect(jestFakeTimersAreEnabled()).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")).toBe(false);
});

test("setTimeout.clock is set after useFakeTimers", () => {
  jest.useFakeTimers();
  try {
    expect(jestFakeTimersAreEnabled()).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(globalThis.setTimeout, "clock")).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("setTimeout.clock is set to false after useRealTimers", () => {
  jest.useFakeTimers();
  jest.useRealTimers();
  // Note: The clock property remains on setTimeout but is set to false.
  // This differs from Jest/Sinon which removes the property entirely.
  // The value being false is sufficient for most use cases.
  expect((globalThis.setTimeout as any).clock).toBe(false);
});

test("advanceTimersByTime(0) fires setTimeout(fn, 0) timers", async () => {
  jest.useFakeTimers();
  try {
    let called = false;
    setTimeout(() => {
      called = true;
    }, 0);

    expect(called).toBe(false);
    jest.advanceTimersByTime(0);
    expect(called).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test("user-event style wait pattern does not hang", async () => {
  jest.useFakeTimers();
  try {
    // This is the pattern used by @testing-library/user-event in wait.js
    // It was hanging before the fix because:
    // 1. advanceTimersByTime(0) didn't fire setTimeout(fn, 0) timers
    // 2. jestFakeTimersAreEnabled() returned false, so advanceTimers wasn't called
    const delay = 0;

    const result = await Promise.all([
      new Promise<string>(resolve => globalThis.setTimeout(() => resolve("timeout"), delay)),
      Promise.resolve().then(() => {
        jest.advanceTimersByTime(delay);
        return "advanced";
      }),
    ]);

    expect(result).toEqual(["timeout", "advanced"]);
  } finally {
    jest.useRealTimers();
  }
});`,important:!1,references:null}]}]}],Bt=JSON.parse(`{"src/bun.js/test/timers/FakeTimers.zig":"#active: bool = false,\\n/// The sorted fake timers. TimerHeap is not optimal here because we need these operations:\\n/// - peek/takeFirst (provided by TimerHeap)\\n/// - peekLast (cannot be implemented efficiently with TimerHeap)\\n/// - count (cannot be implemented efficiently with TimerHeap)\\ntimers: TimerHeap = .{ .context = {} },\\n\\npub var current_time: struct {\\n    const min_timespec = bun.timespec{ .sec = std.math.minInt(i64), .nsec = std.math.minInt(i64) };\\n    /// starts at 0. offset in milliseconds.\\n    offset_raw: bun.timespec = min_timespec,\\n    offset_lock: std.Thread.RwLock = .{},\\n    date_now_offset: f64 = 0,\\n    pub fn getTimespecNow(this: *@This()) ?bun.timespec {\\n        this.offset_lock.lockShared();\\n        defer this.offset_lock.unlockShared();\\n        const value = this.offset_raw;\\n        if (value.eql(&min_timespec)) return null;\\n        return value;\\n    }\\n    pub fn set(this: *@This(), globalObject: *jsc.JSGlobalObject, v: struct {\\n        offset: *const bun.timespec,\\n        js: ?f64 = null,\\n    }) void {\\n        const vm = globalObject.bunVM();\\n        {\\n            this.offset_lock.lock();\\n            defer this.offset_lock.unlock();\\n            this.offset_raw = v.offset.*;\\n        }\\n        const timespec_ms: f64 = @floatFromInt(v.offset.ms());\\n        if (v.js) |js| {\\n            this.date_now_offset = @floor(js) - timespec_ms;\\n        }\\n        bun.cpp.JSMock__setOverridenDateNow(globalObject, this.date_now_offset + timespec_ms);\\n\\n        vm.overridden_performance_now = @bitCast(v.offset.ns());\\n    }\\n    pub fn clear(this: *@This(), globalObject: *jsc.JSGlobalObject) void {\\n        const vm = globalObject.bunVM();\\n        {\\n            this.offset_lock.lock();\\n            defer this.offset_lock.unlock();\\n            this.offset_raw = min_timespec;\\n        }\\n        bun.cpp.JSMock__setOverridenDateNow(globalObject, -1);\\n        vm.overridden_performance_now = null;\\n    }\\n} = .{};\\n\\nfn assertValid(this: *FakeTimers, mode: enum { locked, unlocked }) void {\\n    if (!bun.Environment.ci_assert) return;\\n    const owner: *bun.api.Timer.All = @fieldParentPtr(\\"fake_timers\\", this);\\n    switch (mode) {\\n        .locked => bun.assert(owner.lock.tryLock() == false),\\n        .unlocked => {}, // can't assert unlocked because another thread could be holding the lock\\n    }\\n}\\n\\npub fn isActive(this: *FakeTimers) bool {\\n    this.assertValid(.locked);\\n    defer this.assertValid(.locked);\\n\\n    return this.#active;\\n}\\nfn activate(this: *FakeTimers, js_now: f64, globalObject: *jsc.JSGlobalObject) void {\\n    this.assertValid(.locked);\\n    defer this.assertValid(.locked);\\n\\n    this.#active = true;\\n    current_time.set(globalObject, .{ .offset = &.epoch, .js = js_now });\\n}\\nfn deactivate(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {\\n    this.assertValid(.locked);\\n    defer this.assertValid(.locked);\\n\\n    this.clear();\\n    current_time.clear(globalObject);\\n    this.#active = false;\\n}\\nfn clear(this: *FakeTimers) void {\\n    this.assertValid(.locked);\\n    defer this.assertValid(.locked);\\n\\n    while (this.timers.deleteMin()) |timer| {\\n        timer.state = .CANCELLED;\\n        timer.in_heap = .none;\\n    }\\n}\\nfn executeNext(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) bool {\\n    this.assertValid(.unlocked);\\n    defer this.assertValid(.unlocked);\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n\\n    const next = blk: {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        break :blk this.timers.deleteMin() orelse return false;\\n    };\\n\\n    this.fire(globalObject, next);\\n    return true;\\n}\\nfn fire(this: *FakeTimers, globalObject: *jsc.JSGlobalObject, next: *bun.api.Timer.EventLoopTimer) void {\\n    this.assertValid(.unlocked);\\n    defer this.assertValid(.unlocked);\\n    const vm = globalObject.bunVM();\\n\\n    if (bun.Environment.ci_assert) {\\n        const prev = current_time.getTimespecNow();\\n        bun.assert(prev != null);\\n        bun.assert(next.next.eql(&prev.?) or next.next.greater(&prev.?));\\n    }\\n    const now = next.next;\\n    current_time.set(globalObject, .{ .offset = &now });\\n    next.fire(&now, vm);\\n}\\nfn executeUntil(this: *FakeTimers, globalObject: *jsc.JSGlobalObject, until: bun.timespec) void {\\n    this.assertValid(.unlocked);\\n    defer this.assertValid(.unlocked);\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n\\n    while (true) {\\n        const next = blk: {\\n            timers.lock.lock();\\n            defer timers.lock.unlock();\\n\\n            const peek = this.timers.peek() orelse break;\\n            if (peek.next.greater(&until)) break;\\n            bun.assert(this.timers.deleteMin() == peek);\\n            break :blk peek;\\n        };\\n        this.fire(globalObject, next);\\n    }\\n}\\nfn executeOnlyPendingTimers(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {\\n    this.assertValid(.unlocked);\\n    defer this.assertValid(.unlocked);\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n\\n    const target = blk: {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        break :blk this.timers.findMax() orelse return;\\n    };\\n    const until = target.next;\\n    this.executeUntil(globalObject, until);\\n}\\nfn executeAllTimers(this: *FakeTimers, globalObject: *jsc.JSGlobalObject) void {\\n    this.assertValid(.unlocked);\\n    defer this.assertValid(.unlocked);\\n\\n    while (this.executeNext(globalObject)) {}\\n}\\n\\n// ===\\n// JS Functions\\n// ===\\n\\nfn errorUnlessFakeTimers(globalObject: *jsc.JSGlobalObject) bun.JSError!void {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n\\n    {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        if (this.isActive()) return;\\n    }\\n    return globalObject.throw(\\"Fake timers are not active. Call useFakeTimers() first.\\", .{});\\n}\\n\\nfn useFakeTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n\\n    var js_now = bun.cpp.JSMock__getCurrentUnixTimeMs();\\n\\n    // Check if options object was provided\\n    const args = callframe.argumentsAsArray(1);\\n    if (args.len > 0 and !args[0].isUndefined()) {\\n        const options_value = args[0];\\n        var config = try bindgen_generated.FakeTimersConfig.fromJS(globalObject, options_value);\\n        defer config.deinit();\\n\\n        // Check if 'now' field is provided\\n        if (!config.now.isUndefined()) {\\n            // Handle both number and Date\\n            if (config.now.isNumber()) {\\n                js_now = config.now.asNumber();\\n            } else if (config.now.isDate()) {\\n                js_now = config.now.getUnixTimestamp();\\n            } else {\\n                return globalObject.throwInvalidArguments(\\"'now' must be a number or Date\\", .{});\\n            }\\n        }\\n    }\\n\\n    {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        this.activate(js_now, globalObject);\\n    }\\n\\n    return callframe.this();\\n}\\nfn useRealTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n\\n    {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        this.deactivate(globalObject);\\n    }\\n\\n    return callframe.this();\\n}\\nfn advanceTimersToNextTimer(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    _ = this.executeNext(globalObject);\\n\\n    return callframe.this();\\n}\\nfn advanceTimersByTime(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    const arg = callframe.argumentsAsArray(1)[0];\\n    if (!arg.isNumber()) {\\n        return globalObject.throwInvalidArguments(\\"advanceTimersToNextTimer() expects a number of milliseconds\\", .{});\\n    }\\n    const current = current_time.getTimespecNow() orelse return globalObject.throwInvalidArguments(\\"Fake timers not initialized. Initialize with useFakeTimers() first.\\", .{});\\n    const arg_number = arg.asNumber();\\n    const max_advance = std.math.maxInt(u32);\\n    if (arg_number < 0 or arg_number > max_advance) {\\n        return globalObject.throwInvalidArguments(\\"advanceTimersToNextTimer() ms is out of range. It must be >= 0 and <= {d}. Received {d:.0}\\", .{ max_advance, arg_number });\\n    }\\n    const target = current.addMsFloat(arg_number);\\n\\n    this.executeUntil(globalObject, target);\\n    current_time.set(globalObject, .{ .offset = &target });\\n\\n    return callframe.this();\\n}\\nfn runOnlyPendingTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    _ = this.executeOnlyPendingTimers(globalObject);\\n\\n    return callframe.this();\\n}\\nfn runAllTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    _ = this.executeAllTimers(globalObject);\\n\\n    return callframe.this();\\n}\\nfn getTimerCount(globalObject: *jsc.JSGlobalObject, _: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    const count = blk: {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        break :blk this.timers.count();\\n    };\\n\\n    return jsc.JSValue.jsNumber(count);\\n}\\nfn clearAllTimers(globalObject: *jsc.JSGlobalObject, callframe: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n    try errorUnlessFakeTimers(globalObject);\\n\\n    {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        this.clear();\\n    }\\n\\n    return callframe.this();\\n}\\nfn isFakeTimers(globalObject: *jsc.JSGlobalObject, _: *jsc.CallFrame) bun.JSError!jsc.JSValue {\\n    const vm = globalObject.bunVM();\\n    const timers = &vm.timer;\\n    const this = &timers.fake_timers;\\n\\n    const is_active = blk: {\\n        timers.lock.lock();\\n        defer timers.lock.unlock();\\n        break :blk this.isActive();\\n    };\\n\\n    return jsc.JSValue.jsBoolean(is_active);\\n}\\n\\nconst fake_timers_fns: []const struct { [:0]const u8, u32, (fn (*jsc.JSGlobalObject, *jsc.CallFrame) bun.JSError!jsc.JSValue) } = &.{\\n    .{ \\"useFakeTimers\\", 0, useFakeTimers },\\n    .{ \\"useRealTimers\\", 0, useRealTimers },\\n    .{ \\"advanceTimersToNextTimer\\", 0, advanceTimersToNextTimer },\\n    .{ \\"advanceTimersByTime\\", 1, advanceTimersByTime },\\n    .{ \\"runOnlyPendingTimers\\", 0, runOnlyPendingTimers },\\n    .{ \\"runAllTimers\\", 0, runAllTimers },\\n    .{ \\"getTimerCount\\", 0, getTimerCount },\\n    .{ \\"clearAllTimers\\", 0, clearAllTimers },\\n    .{ \\"isFakeTimers\\", 0, isFakeTimers },\\n};\\npub const timerFnsCount = fake_timers_fns.len;\\npub fn putTimersFns(globalObject: *jsc.JSGlobalObject, jest: jsc.JSValue, vi: jsc.JSValue) void {\\n    inline for (fake_timers_fns) |fake_timer_fn| {\\n        const str = bun.ZigString.static(fake_timer_fn[0]);\\n        const jsvalue = jsc.JSFunction.create(globalObject, fake_timer_fn[0], fake_timer_fn[2], fake_timer_fn[1], .{});\\n        vi.put(globalObject, str, jsvalue);\\n        jest.put(globalObject, str, jsvalue);\\n    }\\n}\\n\\nconst bindgen_generated = @import(\\"bindgen_generated\\");\\nconst std = @import(\\"std\\");\\n\\nconst bun = @import(\\"bun\\");\\nconst jsc = bun.jsc;\\nconst TimerHeap = bun.api.Timer.TimerHeap;\\nconst FakeTimers = bun.jsc.Jest.bun_test.FakeTimers;","test/regression/issue/25869.test.ts":""}`),Vt=`https://playground-eight-mu.vercel.app/obj/99cbf9bb25d5c1b9a5e69c9d5c0ada2c?model=pr_review_model`,Ht={bugs:[{id:`BUG_pr-review-job-4256e4236c6f4b73be1708ed582d993d_0001`,title:`setFakeTimerMarker sets clock to false instead of deleting it, causing jestFakeTimersAreEnabled() to return true after useRealTimers()`,description:"The `setFakeTimerMarker` function sets `setTimeout.clock = false` when disabling fake timers (line 188). However, testing-library/react's `jestFakeTimersAreEnabled()` detection uses `Object.prototype.hasOwnProperty.call(setTimeout, 'clock')` which checks for property **existence**, not its value.\n\nAfter calling `useRealTimers()`, the `clock` property still exists on `setTimeout` (it's just set to `false`), so `hasOwnProperty` returns `true`. This causes `jestFakeTimersAreEnabled()` to incorrectly return `true` even when fake timers are disabled.\n\nThe test file itself demonstrates this issue at lines 8-18:\n```typescript\nfunction jestFakeTimersAreEnabled(): boolean {\n  return (\n    (globalThis.setTimeout as any)._isMockFunction === true ||\n    Object.prototype.hasOwnProperty.call(globalThis.setTimeout, \"clock\")\n  );\n}\n```\n\nAfter `useRealTimers()` is called, testing-library will still think fake timers are enabled and will incorrectly call `jest.advanceTimersByTime()` when draining the microtask queue. The property should be deleted instead of set to `false`.\n\n**Impact**: Testing-library will behave incorrectly after toggling fake timers off, potentially causing tests to hang or behave unexpectedly when fake timers are disabled after being enabled.",file_path:`src/bun.js/test/timers/FakeTimers.zig`,start_line:188,end_line:188,side:`RIGHT`,severity:`severe`,recommendation:"Delete the `clock` property when disabling fake timers instead of setting it to `false`. Use the appropriate JSC API to delete the property, or set it to `undefined` and use `delete` semantics if available."}],analyses:[{id:`ANALYSIS_pr-review-job-4256e4236c6f4b73be1708ed582d993d_0001`,title:`advanceTimersByTime(0) now advances time by 1ms - intentional but potentially surprising`,analysis:"The change at `FakeTimers.zig:272-276` makes `advanceTimersByTime(0)` advance the clock by 1ms instead of 0ms. This is intentional for Jest compatibility since `setTimeout(fn, 0)` is internally scheduled with 1ms delay (see `Timer.zig:383-395`). However, this means `Date.now()` and `performance.now()` will report time 1ms ahead after calling `advanceTimersByTime(0)`. User code that does `const start = Date.now(); jest.advanceTimersByTime(0); expect(Date.now()).toBe(start)` would now fail. The existing test suite at `fake-timers.test.ts` doesn't test this case, so no regression is detected.",file_path:`src/bun.js/test/timers/FakeTimers.zig`,start_line:272,end_line:276,side:`RIGHT`,needs_investigation:!1},{id:`ANALYSIS_pr-review-job-4256e4236c6f4b73be1708ed582d993d_0002`,title:`Test order dependency - first test assumes clean global state`,analysis:"The test at `25869.test.ts:20-23` expects `hasOwnProperty.call(globalThis.setTimeout, 'clock')` to be `false`. This test must run before any test that calls `useFakeTimers()`, because once the `clock` property is set, it persists even after `useRealTimers()`. If Bun's test runner reorders tests or runs them in parallel in the same context, this test could fail. The test file structure relies on sequential execution starting from a clean state.",file_path:`test/regression/issue/25869.test.ts`,start_line:20,end_line:23,side:`RIGHT`,needs_investigation:!0},{id:`ANALYSIS_pr-review-job-4256e4236c6f4b73be1708ed582d993d_0003`,title:`setFakeTimerMarker silently ignores errors`,analysis:"The `setFakeTimerMarker` function at `FakeTimers.zig:179-189` uses `catch return` and `orelse return` to silently ignore errors when getting or setting the `setTimeout.clock` property. If `setTimeout` is a Proxy with throwing handlers, or if the global object is in an unusual state, the marker won't be set but no error is surfaced. The main operation (`activate`/`deactivate`) has already completed at `FakeTimers.zig:218-222` before this is called, so fake timers would be enabled but testing-library detection would fail. This is a minor edge case but could lead to confusing behavior.",file_path:`src/bun.js/test/timers/FakeTimers.zig`,start_line:179,end_line:189,side:`RIGHT`,needs_investigation:!1},{id:`ANALYSIS_pr-review-job-4256e4236c6f4b73be1708ed582d993d_0004`,title:`Comment at line 185-187 is inconsistent with implementation`,analysis:"The comment states 'We set the property to true when enabling and leave it (or set to undefined) when disabling' but the actual implementation at line 188 always calls `jsBoolean(enabled)`, which sets it to `false` when disabling, not `undefined`. The test at `25869.test.ts:41` confirms it expects `false`, not `undefined`. This is a documentation inconsistency rather than a bug, but the comment should be updated to match the actual behavior.",file_path:`src/bun.js/test/timers/FakeTimers.zig`,start_line:185,end_line:187,side:`RIGHT`,needs_investigation:!1}],model:`lifeguard_pr_review_group`,generated_at:`2026-01-21T03:45:36.111917`,playground_url:`https://playground-eight-mu.vercel.app/obj/7138e41684b149834f3564e9fddaede7`},Ut=`complete`,Wt={pr_metadata:Rt,sections:zt,file_contents_at_base:Bt,playground_url:Vt,lifeguard_result:Ht,lifeguard_status:Ut,ref_defs:null}})))()}function Kt(){let e=ue(),n=r(ce,!1);return(r,i)=>{let a=_e(r),o=a.type===`success`&&!n&&a.prPath.startsWith(`bitbucket.org/`)?{type:`unsupported_host`}:a;if(o.type===`success`){let{owner:n,repo:r,prNumber:a}=pe(o.prPath);t(`Review:Landing:SubmitURL`,{owner:n,repo:r,prNumber:parseInt(a,10)}),i(null),e({to:o.reviewPath})}else o.type===`unsupported_host`?i(`Support for repositories not on github.com is coming soon!`):i(`Please enter a valid GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)`)}}function B(){return(B=e((()=>{i(),be(),n(),se(),le(),me()})))()}function qt(e){let t=e.changes[0];if(!t||t.file_path!==J)return e;let n=(t.edits[0]?.after_content??``).split(`
`),r=n.slice(19).join(`
`),i=[rn,n.length],a=t.edits[0]?.snippet_id??`0004`;return{...e,changes:[{...t,display_info:{blocks_to_show:[{type:`hunk`,hunk:{snippet_id:a,before_lines:null,after_lines:i,before_content:null,after_content:r,important:!1}}],default_hidden:!1},edits:[{snippet_id:a,file_path:J,change_type:`added`,before_lines:null,after_lines:i,before_content:null,after_content:r,important:!1}]}]}}function Jt(){let{t:e}=u(`review`);Me(`Review | Security now in every code review`),(0,H.useEffect)(()=>{let e={description:`Review automatically finds vulnerabilities, bugs, and moved code in every PR. Try it on any GitHub repo.`,"og:title":`Review | Security now in every code review`,"og:description":`Review automatically finds vulnerabilities, bugs, and moved code in every PR. Try it on any GitHub repo.`,"twitter:title":`Review | Security now in every code review`,"twitter:description":`Review automatically finds vulnerabilities, bugs, and moved code in every PR. Try it on any GitHub repo.`},t=[];for(let[n,r]of Object.entries(e)){let e=n.startsWith(`og:`)||n.startsWith(`twitter:`)?`property`:`name`,i=document.querySelector(`meta[${e}="${n}"]`),a=i?.getAttribute(`content`)??null;if(i){let e=i;t.push(()=>{a!==null&&e.setAttribute(`content`,a)})}else{let r=document.createElement(`meta`);r.setAttribute(e,n),document.head.appendChild(r),t.push(()=>r.remove()),i=r}i.setAttribute(`content`,r)}return()=>t.forEach(e=>e())},[]);let{isMobile:n}=re(),r=(0,H.useRef)(null),i=(0,H.useRef)(null),a=Ge(),o=.8,s=e=>{let t=Math.min(an,e-16);return Math.min(on,e)/t},c=s(window.innerWidth),l=Ue(c),d=Pt(l,{stiffness:180,damping:26,restDelta:.001,duration:.15}),f=(0,H.useRef)(!1),p=(0,H.useRef)(c),h=(0,H.useRef)(!1),[_,ie]=(0,H.useState)(!1);return(0,H.useEffect)(()=>{let e=new URLSearchParams(ne().search),n=e.get(`utm_source`),r=e.get(`utm_medium`),i=e.get(`utm_campaign`),a=document.referrer,o=`direct`;n?o=`utm`:a&&!a.includes(ee())&&(o=`referral`),t(`Review:Landing:View`,{source:o,referrer:a||void 0,utmSource:n||void 0,utmMedium:r||void 0,utmCampaign:i||void 0})},[]),Ae({onReport:e=>t(`Review:Landing:TimeSpent`,{durationMs:e.durationMs})}),(0,H.useEffect)(()=>{let e=r.current;if(!e)return;let n=()=>{e.scrollTop>0&&(f.current=!0),!h.current&&e.scrollTop>400&&(h.current=!0,t(`Review:Landing:ScrollToFeatures`,{}))};return e.addEventListener(`scroll`,n,{passive:!0}),()=>e.removeEventListener(`scroll`,n)},[]),(0,H.useEffect)(()=>{if(a||n){l.set(1),d.set(1);return}let e=i.current;if(!e)return;let t=Array.from({length:101},(e,t)=>t/100),c=new IntersectionObserver(([e])=>{let t=e.rootBounds?.height??window.innerHeight,n=e.rootBounds?.width??window.innerWidth,r=s(n),i=Math.min(1,e.intersectionRect.height/Math.max(1,t));ie(e.boundingClientRect.bottom<t*.6);let a=Math.min(1,i/o);if(!f.current){l.set(r);return}let c=r+(1-r)*a;(e.boundingClientRect.top>=0||c>p.current)&&(p.current=c,l.set(c))},{threshold:t,root:r.current});return c.observe(e),()=>c.disconnect()},[d,l,o,n,1,a]),(0,U.jsx)(ve.Provider,{value:X,children:(0,U.jsx)(tt.Provider,{value:cn,children:(0,U.jsx)(ht,{children:(0,U.jsx)(qe,{children:(0,U.jsx)(bt,{children:(0,U.jsx)(Qe,{children:(0,U.jsx)(ut,{children:(0,U.jsxs)(`div`,{className:`h-full w-full overflow-y-auto overflow-x-hidden px-6 xl:px-2`,ref:r,children:[(0,U.jsxs)(`div`,{className:`mx-auto flex w-full max-w-[1300px] flex-1 flex-col items-start gap-[60px] md:gap-[90px]`,children:[(0,U.jsxs)(`a`,{href:`https://devin.ai/blog/security-in-devin-review`,className:`mt-[40px] inline-flex items-center gap-2 self-start rounded-full border border-border-primary px-4 py-2 text-13 font-medium text-text-secondary hover:text-text-primary md:mt-[60px]`,children:[(0,U.jsx)(te,{className:`size-4 shrink-0 text-green`}),e(`landing.justLaunched`),(0,U.jsx)(m,{className:`size-3.5 shrink-0`})]}),(0,U.jsxs)(`div`,{className:`flex w-full max-w-[689px] flex-col items-start gap-[48px]`,children:[(0,U.jsxs)(`div`,{className:`flex flex-col gap-[16px]`,children:[(0,U.jsxs)(`h1`,{className:`text-[48px] font-medium leading-none tracking-[-1%] text-text-primary md:text-[60px]`,children:[(0,U.jsx)(`span`,{className:`ml-[-0.12em] inline-flex gap-0`,children:[`Devin`,`Review`].map(e=>(0,U.jsxs)(`span`,{className:g(`relative inline-block px-[0.12em]`,e===`Devin`?`text-green`:`text-red`),children:[e,(0,U.jsx)(`span`,{className:`pointer-events-none absolute inset-0 overflow-hidden`,children:(0,U.jsx)(`span`,{className:`absolute -inset-1/2 size-[200%]`,style:{background:`repeating-linear-gradient(
                              -55deg,
                              color-mix(in srgb, currentColor 20%, transparent) 0px,
                              color-mix(in srgb, currentColor 20%, transparent) 1.5px,
                              transparent 1.5px,
                              transparent 5px
                            )`}})}),` `]},e))}),` `,e(`landing.tagline`)]}),(0,U.jsx)(`p`,{className:`text-17 leading-[1.35] text-text-secondary md:text-[24px]`,children:e(`landing.subtitle`)})]}),(0,U.jsx)(Qt,{})]}),(0,U.jsx)(`div`,{className:`h-px w-full bg-border-primary`}),n&&(0,U.jsx)(Yt,{})]}),(0,U.jsx)(`div`,{className:`flex flex-col gap-[60px] md:gap-[90px]`,children:!n&&(0,U.jsxs)(U.Fragment,{children:[(0,U.jsx)(Zt,{exampleScale:d,exampleRef:i,pageRef:r,hideChatAnnotation:_}),(0,U.jsx)(`div`,{className:`mx-auto h-px w-full max-w-[1240px] bg-border-primary`}),(0,U.jsx)(Xt,{}),(0,U.jsx)(`div`,{className:`mx-auto h-px w-full max-w-[1240px] bg-border-primary`}),(0,U.jsxs)(`div`,{className:g(`mx-auto flex max-w-[1240px] flex-col gap-[28px]`),children:[(0,U.jsx)(`h2`,{className:`text-balance text-[28px] font-medium text-text-primary`,children:e(`landing.copyMoveDetection`)}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:e(`landing.copyMoveDesc`)}),(0,U.jsx)(en,{fileContentsAtBase:z})]})]})}),(0,U.jsxs)(`div`,{className:`mx-auto flex max-w-[689px] flex-col gap-[24px] px-[20px] pb-[30vh] pt-[20vh] text-center text-text-primary`,children:[(0,U.jsx)(`span`,{className:`text-[32px] font-medium leading-none md:text-[52px]`,children:(0,U.jsx)(De,{t:e,i18nKey:`landing.tryNow`,components:{devinReview:(0,U.jsx)(`span`,{className:`text-green`})}})}),(0,U.jsx)(Qt,{centered:!0})]})]})})})})})})})})}function Yt(){let{t:e}=u(`review`);return(0,U.jsxs)(`div`,{className:`grid grid-cols-2 gap-[90px]`,children:[(0,U.jsx)(`div`,{className:`col-span-2`,children:(0,U.jsx)(Xt,{})}),(0,U.jsx)(V,{title:e(`landing.organizedDiffs`),description:e(`landing.organizedDiffsDesc`),img:F,className:`col-span-2`}),(0,U.jsxs)(`div`,{className:`col-span-2 grid grid-cols-1 grid-rows-[auto_auto_1fr] gap-x-[20px] gap-y-[90px] md:grid-cols-2`,children:[(0,U.jsx)(V,{title:e(`landing.bugDetection`),description:e(`landing.bugDetectionDesc`),img:L,useSubgrid:!0}),(0,U.jsx)(V,{title:e(`landing.askDevin`),description:e(`landing.askDevinDesc`),img:R,useSubgrid:!0})]}),(0,U.jsx)(V,{title:e(`landing.copyMoveDetection`),description:e(`landing.copyMoveDesc`),className:`col-span-2`,content:(0,U.jsx)(en,{fileContentsAtBase:z})})]})}function V({title:e,description:t,img:n,className:r,useSubgrid:i,content:a}){return i?(0,U.jsxs)(`div`,{className:g(`row-span-3 grid grid-rows-subgrid gap-y-[8px]`,r),children:[(0,U.jsx)(`h2`,{className:`text-balance text-[28px] font-medium text-text-primary`,children:e}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:t}),(0,U.jsx)(`img`,{src:n,alt:e,className:`w-full rounded-[6px]`})]}):(0,U.jsxs)(`div`,{className:g(`flex flex-col gap-[28px]`,r),children:[(0,U.jsxs)(`div`,{className:`flex flex-col gap-[8px]`,children:[(0,U.jsx)(`h2`,{className:`text-balance text-[28px] font-medium text-text-primary`,children:e}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:t})]}),a??(0,U.jsx)(`img`,{src:n,alt:e,className:`w-full rounded-[6px]`})]})}function Xt(){let{t:e}=u(`review`),t=Z[0];return(0,U.jsxs)(`div`,{className:`mx-auto flex max-w-[1240px] flex-col gap-[28px]`,children:[(0,U.jsx)(`h2`,{className:`text-balance text-[28px] font-medium text-text-primary`,children:e(`landing.securitySectionTitle`)}),(0,U.jsxs)(`div`,{className:`flex flex-col gap-[28px] md:flex-row md:items-center md:gap-[60px]`,children:[(0,U.jsx)(`div`,{className:g(`flex-1`,`[&_[aria-label='Comment_actions']]:hidden`,`[&_[aria-label='Mark_resolved']]:!cursor-default`,`[&_[aria-label='Mark_unresolved']]:!cursor-default`),onClickCapture:e=>{let t=e.target;(t.closest(`[aria-label="Mark resolved"]`)||t.closest(`[aria-label="Mark unresolved"]`))&&(e.preventDefault(),e.stopPropagation(),e.nativeEvent.stopImmediatePropagation())},children:(0,U.jsx)(lt,{commentId:`landing-example-security`,finding:t,toggleGithubResolve:()=>{},expanded:!0,onExpandedChange:()=>{}})}),(0,U.jsxs)(`div`,{className:`flex flex-1 flex-col gap-[28px]`,children:[(0,U.jsxs)(`div`,{className:`flex flex-col gap-[8px]`,children:[(0,U.jsx)(`h3`,{className:`text-balance text-17 font-medium text-text-primary`,children:e(`landing.securitySectionCoverage`)}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:e(`landing.securitySectionCoverageDesc`)})]}),(0,U.jsxs)(`div`,{className:`flex flex-col gap-[8px]`,children:[(0,U.jsx)(`h3`,{className:`text-balance text-17 font-medium text-text-primary`,children:e(`landing.securitySectionTriaging`)}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:e(`landing.securitySectionTriagingDesc`)})]}),(0,U.jsxs)(`div`,{className:`flex flex-col gap-[8px]`,children:[(0,U.jsx)(`h3`,{className:`text-balance text-17 font-medium text-text-primary`,children:e(`landing.securitySectionFixes`)}),(0,U.jsx)(`p`,{className:`text-pretty text-15 text-text-secondary`,children:e(`landing.securitySectionFixesDesc`)})]})]})]})]})}function Zt({exampleScale:e,exampleRef:t,pageRef:n,hideChatAnnotation:r}){let{t:i}=u(`review`),[a,o]=(0,H.useState)(e.get());Mt(e,`change`,e=>{o(e)});let s=$e({owner:X.owner,repo:X.repo,prNumber:X.prNumber,prPath:X.prPath,prData:W});return(0,U.jsx)(`div`,{ref:t,"data-x":a,className:`mx-auto mt-20 w-[2200px] max-w-full pt-4`,children:(0,U.jsxs)(x.div,{className:`origin-[top_center]`,style:{scale:e},children:[(0,U.jsx)($t,{pageRef:n}),(0,U.jsx)(v,{children:e.get()===1&&(0,U.jsxs)(U.Fragment,{children:[(0,U.jsx)(Ze,{noAutoExpand:!0,chat:s}),(0,U.jsx)(v,{children:!r&&(0,U.jsx)(x.div,{initial:{opacity:0},animate:{opacity:1},exit:{opacity:0},transition:{duration:.4,ease:`easeOut`},children:(0,U.jsx)(j,{glow:!0,text:i(`landing.chatAnnotation`),direction:`up-left`,className:`absolute bottom-0 right-0 z-30 pb-8 pl-4 pr-10 pt-2`})})})]})})]})})}function Qt({centered:e=!1}){let{t:n}=u(`review`),[r,i]=(0,H.useState)(``),[a,o]=(0,H.useState)(null),s=(0,H.useRef)(null),l=(0,H.useId)(),d=Kt();return(0,U.jsxs)(`div`,{className:`flex w-full flex-col gap-[16px]`,children:[(0,U.jsxs)(`form`,{onSubmit:e=>{e.preventDefault(),d(r,o)},className:`flex flex-col gap-3`,children:[(0,U.jsx)(`div`,{className:g(`flex items-center gap-2`,e&&`justify-center`),children:(0,U.jsx)(`label`,{htmlFor:l,className:`text-15 font-medium text-text-secondary`,children:(0,U.jsx)(De,{t:n,i18nKey:`landing.tryOnAnyPr`,components:{emphasis:(0,U.jsx)(`span`,{className:`text-text-primary`})}})})}),(0,U.jsxs)(Te,{className:`border-border-tertiary h-[52px] rounded-2xl border-2`,children:[(0,U.jsx)(we,{id:l,ref:s,placeholder:`github.com/owner/repo/pull/123`,value:r,className:`px-[16px] py-[12px] text-15`,onChange:e=>{i(e.target.value),o(null)}}),(0,U.jsx)(Ce,{align:`inline-end`,className:`pr-2.5`,children:(0,U.jsx)(xe,{type:`submit`,variant:`ghost`,disabled:!r.trim(),"aria-label":n(`digest.submitPrUrl`),children:(0,U.jsx)(m,{className:`!size-5`})})})]}),a&&(0,U.jsx)(`p`,{className:`text-14 text-red`,children:a})]}),(0,U.jsx)(`div`,{className:g(`flex flex-wrap gap-[12px]`,e&&`justify-center`),children:tn.map(e=>(0,U.jsxs)(Oe,{variant:`secondary`,nativeButton:!1,render:(0,U.jsx)(c,{to:`/review/$`,params:{_splat:`${e.owner}/${e.repo}/pull/${e.pr}`},onClick:()=>{t(`Review:Landing:ExampleClick`,{owner:e.owner,repo:e.repo,prNumber:e.pr})}}),size:`md`,className:`border border-tint-primary font-normal`,shape:`rounded`,children:[e.owner,`/`,e.repo,`#`,e.pr]},e.label))})]})}function $t(e){let{t}=u(`review`),n=ot(),r=he(e=>e.deactivateAll),i=at(e=>e.setSidebarLeft);(0,H.useEffect)(()=>{i(0)},[i]);let{allChangesInFileMap:a,commentsByFile:o,commentRenderers:s,fileContentsAtHead:c,scrollToSection:l,scrollToFile:d}=Et({owner:``,repo:``,prNumber:void 0,sections:Y,fileContentsAtBase:z,lifeguardResult:Q,mergeBaseSha:`mergeBaseSha`,commentLocation:`inline`}),ee=Dt(e=>e.isOpen),f=Dt(e=>e.setOpenPanel);return de(oe.DigestToggleAgent,e=>{e.preventDefault(),f(!ee)}),(0,U.jsxs)(`div`,{className:`relative flex w-full gap-10 pt-20`,children:[(0,U.jsx)(v,{children:n&&(0,U.jsx)(x.div,{initial:{opacity:0},animate:{opacity:.8},exit:{opacity:0},transition:{duration:.1,ease:`easeInOut`},className:`absolute inset-0 z-10 bg-bg-page`,onClick:r,"aria-label":t(`comments.closeComment`)})}),(0,U.jsx)(`div`,{className:`relative z-20 flex flex-1 flex-col gap-14 border-border-secondary`,children:(0,U.jsxs)(vt,{items:Y,hasOverview:!1,children:[(0,U.jsx)(j,{glow:!0,text:t(`landing.organizedDiffs`),direction:`down-right`,className:`absolute -top-24 left-0`}),Y.map((e,t)=>(0,U.jsx)(xt,{...ln,section:e,idx:t,fileContentsAtHead:c,allChangesInFileMap:a,commentsByFile:o,commentRenderers:s,isHomeExample:!0},e.title))]})}),(0,U.jsx)(j,{glow:!0,text:t(`landing.bugDetectionPlural`),direction:`down-left`,className:`absolute -top-4 right-8`}),(0,U.jsx)(`div`,{id:`pr-sidebar`,className:`sticky right-0 top-0 h-[calc(100vh-150px)] max-h-[calc(100vh-150px)] w-96 shrink-0 self-start overflow-y-auto scrollbar-hide [overflow-behavior:contain]`,children:(0,U.jsxs)(`div`,{className:`relative flex flex-col gap-3`,children:[(0,U.jsx)(`div`,{className:`p-2`,children:(0,U.jsx)(ft,{bugs:Q.bugs,analyses:Q.analyses,securityFindings:Z,interactive:!1})}),(0,U.jsx)(`h2`,{className:`flex flex-col px-5 pb-1 pt-5 text-15 font-medium text-text-primary`,children:t(`landing.changesInPr`)}),Y.map((e,t)=>(0,U.jsx)(At,{section:e,sectionIndex:t,isExpanded:!1,onToggleExpanded:()=>{},scrollToSection:l,scrollToFile:d,fileOccurrenceCounts:new Map,sidebarFileOccurrenceIndices:new Map,defaultExpanded:!1,isLast:t===Y.length-1},e.title))]})})]})}function en({fileContentsAtBase:e}){let{allChangesInFileMap:t,commentsByFile:n,commentRenderers:r,fileContentsAtHead:i}=Et({owner:``,repo:``,prNumber:void 0,sections:[$],fileContentsAtBase:e,lifeguardResult:Q,mergeBaseSha:`mergeBaseSha`,commentLocation:`inline`}),a=(0,H.useRef)(null),[o,s]=(0,H.useState)(null),{isMobile:c}=re();return(0,H.useEffect)(()=>{let e=null,t=()=>{e&&cancelAnimationFrame(e),e=requestAnimationFrame(()=>{if(!a.current)return;let e=a.current,t=e.getBoundingClientRect(),n=e.querySelector(`.line-content[data-diff-side="left"][data-before-line="85"]`),r=e.querySelector(`.line-content[data-diff-side="right"][data-after-line="208"]`);if(n&&r){let e=n.getBoundingClientRect(),i=r.getBoundingClientRect(),a={startX:e.right-t.left,startY:e.top+e.height/2-t.top,endX:i.left+i.width/2-t.left,endY:i.top-t.top,containerWidth:t.width};s(e=>e&&e.startX===a.startX&&e.startY===a.startY&&e.endX===a.endX&&e.endY===a.endY&&e.containerWidth===a.containerWidth?e:a)}else s(null)})},n=setTimeout(t,100),r=new ResizeObserver(t);return a.current&&r.observe(a.current),window.addEventListener(`resize`,t),()=>{clearTimeout(n),e&&cancelAnimationFrame(e),r.disconnect(),window.removeEventListener(`resize`,t)}},[]),c?(0,U.jsx)(`div`,{className:`relative w-full overflow-hidden rounded-[6px] bg-bg-elevated-transparent p-4`,children:(0,U.jsxs)(`div`,{className:`flex flex-col gap-3`,children:[(0,U.jsxs)(`div`,{className:`removed-box rounded-[6px] border bg-bg-wash`,children:[(0,U.jsx)(`div`,{className:`border-b px-3 pb-1`,children:(0,U.jsx)(`span`,{className:`font-mono text-10 text-text-secondary`,children:`conversions.rs`})}),(0,U.jsxs)(`pre`,{className:`font-mono text-10`,children:[(0,U.jsxs)(`div`,{className:`px-3 py-0.5 text-[#8b949e]`,children:[(0,U.jsx)(`span`,{className:`text-[#ff7b72]`,children:`impl`}),` ResponseConverter`,` `,`{`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(248,81,73)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`  `,(0,U.jsx)(`span`,{className:`text-[#ff7b72]`,children:`fn`}),` `,(0,U.jsx)(`span`,{className:`text-[#d2a8ff]`,children:`convert`}),`() `,`{`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(248,81,73)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`    `,(0,U.jsx)(`span`,{className:`text-[#79c0ff]`,children:`let`}),` result = ...`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(248,81,73)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`  `,`}`]}),(0,U.jsx)(`div`,{className:`px-3 py-0.5 text-[#8b949e]`,children:`}`})]})]}),(0,U.jsx)(`div`,{className:`flex justify-center py-1`,children:(0,U.jsxs)(`svg`,{width:`24`,height:`32`,viewBox:`0 0 24 32`,"aria-hidden":`true`,focusable:`false`,children:[(0,U.jsx)(`path`,{d:`M 12 0 V 22`,fill:`none`,stroke:`rgb(192 132 252)`,strokeWidth:`2`,strokeDasharray:`4 2`}),(0,U.jsx)(`polygon`,{points:`12,28 6,18 18,18`,fill:`rgb(192 132 252)`})]})}),(0,U.jsxs)(`div`,{className:`added-box rounded-[6px] border bg-bg-wash`,children:[(0,U.jsx)(`div`,{className:`border-b px-3 pb-1`,children:(0,U.jsx)(`span`,{className:`font-mono text-10 text-text-secondary`,children:`utils.rs`})}),(0,U.jsxs)(`pre`,{className:`font-mono text-10`,children:[(0,U.jsxs)(`div`,{className:`px-3 py-0.5 text-[#8b949e]`,children:[(0,U.jsx)(`span`,{className:`text-[#ff7b72]`,children:`mod`}),` helpers `,`{`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(63,185,80)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`  `,(0,U.jsx)(`span`,{className:`text-[#ff7b72]`,children:`fn`}),` `,(0,U.jsx)(`span`,{className:`text-[#d2a8ff]`,children:`convert`}),`() `,`{`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(63,185,80)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`    `,(0,U.jsx)(`span`,{className:`text-[#79c0ff]`,children:`let`}),` result = ...`]}),(0,U.jsxs)(`div`,{className:`bg-[color-mix(in_srgb,rgb(63,185,80)_15%,transparent)] px-3 py-0.5 text-[#e6edf3]`,children:[`  `,`}`]}),(0,U.jsx)(`div`,{className:`px-3 py-0.5 text-[#8b949e]`,children:`}`})]})]})]})}):(0,U.jsxs)(`div`,{ref:a,className:`relative w-full`,children:[(0,U.jsx)(`div`,{className:`w-full overflow-hidden`,children:(0,U.jsx)(it.Provider,{value:sn,children:(0,U.jsx)(vt,{items:[$],hasOverview:!1,children:(0,U.jsx)(mt,{sectionIndex:0,section:$,prUrl:``,fileContentsAtBase:e,fileContentsAtHead:i,allChangesInFileMap:t,commentsByFile:n,commentRenderers:r,commentLocation:`inline`,lifeguardBugs:[],owner:`sgl-project`,repo:`sglang`,isHomeExample:!0})})})}),o&&(0,U.jsxs)(`svg`,{className:`pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible`,style:{zIndex:10},"aria-hidden":`true`,focusable:`false`,children:[(0,U.jsx)(`path`,{d:(()=>{if(!o)return``;let{startX:e,startY:t,endX:n,endY:r}=o;return`M ${e} ${t}
            H ${n-12}
            Q ${n} ${t} ${n} ${t+12}
            V ${r-20}`})(),fill:`none`,stroke:`rgb(192 132 252)`,strokeWidth:`3`,strokeDasharray:`6 4`}),(0,U.jsx)(`polygon`,{points:`${o.endX},${o.endY} ${o.endX-10},${o.endY-20} ${o.endX+10},${o.endY-20}`,fill:`rgb(192 132 252)`})]})]})}var H,U,tn,W,G,K,q,nn,J,rn,Y,an,on,X,sn,cn,ln,Z,Q,$;function un(){return(un=e((()=>{ie(),je(),rt(),P(),St(),ct(),dt(),Tt(),ye(),ge(),st(),Ot(),h(),ae(),fe(),n(),_(),ke(),Se(),s(),p(),f(),Pe(),S(),We(),D(),Ke(),A(),H=a(),Ee(),l(),I(),Ft(),It(),d(),Ne(),wt(),gt(),_t(),Ct(),kt(),Xe(),Lt(),Gt(),Ye(),B(),pt(),nt(),Je(),et(),U=o(),tn=yt.map(e=>({...e,label:`https://github.com/${e.owner}/${e.repo}/pull/${e.pr}`})),W=Wt,G=`// src/index.js
//
// Account service: user profile + credential management endpoints.
const express = require("express");
const bcrypt = require("bcryptjs");
const { verifyToken, secureFnc } = require("./jwt-helper");
const { getUsers, setUsers, listUsers, deleteUser } = require("./db/users");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// Decode the caller's token on every request. Note: verifyToken issues a
// guest token when no x-access-token header is supplied (jwt-helper.js:46-65),
// so req.user is always populated, even for anonymous callers.
app.use((req, res, next) => {
  const token = req.headers["x-access-token"];
  req.user = verifyToken(token);
  next();
});

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
// List every user. Admins only.
app.get("/api/users", secureFnc, (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "forbidden" });
  }
  res.json({ users: listUsers() });
});

// Fetch a single user's public profile.
app.get("/api/users/:username", secureFnc, (req, res) => {
  const user = getUsers(req.params.username);
  if (!user) {
    return res.status(404).json({ error: "not found" });
  }
  res.json({
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });
});

// Update the authenticated user's own profile.
app.put("/api/users/:username/profile", secureFnc, async (req, res) => {
  if (req.user.username !== req.params.username) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { displayName, avatarUrl } = req.body;
  await setUsers(req.params.username, { displayName, avatarUrl });
  res.json({ ok: true });
});

// Return the currently authenticated principal.
app.get("/api/me", secureFnc, (req, res) => {
  if (req.user.isGuest) {
    return res.status(401).json({ error: "not signed in" });
  }
  res.json({ username: req.user.username, isAdmin: req.user.isAdmin });
});

// Delete a user. Admins only.
app.delete("/api/users/:username", secureFnc, async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "forbidden" });
  }
  await deleteUser(req.params.username);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
// Verify a user's current password (used by the settings page before
// revealing the change-password form).
app.post("/api/users/verify", secureFnc, async (req, res) => {
  const { username, password } = req.body;
  const user = getUsers(username);
  if (!user) {
    return res.status(404).json({ error: "not found" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  res.json({ ok });
});

// ---------------------------------------------------------------------------
// Change a user's password.
//
// Accepts a username + new password and writes the new credential hash.
// secureFnc guarantees a token is present but does not assert WHO the caller
// is, so this currently trusts req.body.username verbatim.
// ---------------------------------------------------------------------------

app.post("/api/users/password", secureFnc, async (req, res) => {
  const { username, password } = req.body;

  // Overwrite the stored credential hash for the given username.
  await setUsers(username, {
    passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
  });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("account service listening on port " + PORT);
});`.split(`
`),K=(e,t)=>({type:`line`,before_line:e,after_line:t,content:G[t-1]??``}),q=G.slice(111,120).join(`
`),nn={title:`Add account password-change endpoint`,text:`Adds a password-change route to the account service so users can update their credentials.`,changes:[{file_path:`index.js`,old_file_path:null,pure_rename_id:null,change_type:`modified`,display_info:{blocks_to_show:[K(106,106),K(107,107),K(108,108),K(109,109),K(110,110),K(111,111),{type:`hunk`,hunk:{snippet_id:`idx-0000`,before_lines:[112,111],after_lines:[112,120],before_content:``,after_content:q,important:!1}},K(112,121),K(113,122),K(114,123),K(115,124)],default_hidden:!1},edits:[{snippet_id:`idx-0000`,file_path:`index.js`,change_type:`modified`,before_lines:[112,111],after_lines:[112,120],before_content:``,after_content:q,important:!1}]}]},J=`test/regression/issue/25869.test.ts`,rn=20,Y=[...W.sections.slice(1).map(qt),nn],an=2200,on=1300,X={owner:`oven-sh`,repo:`bun`,prNumber:`25915`,prPath:`github.com/oven-sh/bun/pull/25915`,host:`github.com`,provider:`github`},sn={mode:`split`,setViewMode:()=>{},splitViewDisabled:!1},cn={cannotInteractWithGitHub:!0,canInstallGithubApp:!0,interactionBlockReason:null,reviewSurfaces:null},ln={hasOverview:!1,fileContentsAtBase:z,lifeguardBugs:[],commentLocation:`floating`,owner:`sgl-project`,repo:`sglang`,mergeBaseSha:void 0,headSha:void 0,fileOccurrenceCounts:new Map,fileOccurrenceIndices:new Map},Z=[{id:`example-vulnerability`,severity:`critical`,title:`Password-change endpoint lacks ownership or admin authorization checks`,description:"The new `POST /api/users/password` handler accepts any `username` and `password` after `secureFnc`, but never verifies that the authenticated request user is the same account (or an admin) before calling `setUsers`. In this codebase `verifyToken` also creates a guest token when no `x-access-token` is supplied (`jwt-helper.js:46-65`), so an unauthenticated/guest request can reach this handler and reset any known user's password, resulting in account takeover.",file_path:`index.js`,start_line:112,end_line:119,side:`RIGHT`,snippet_id:null,reasoning:``,recommendation:"Require a valid authenticated non-guest user for this route, verify `req.userId === req.body.username` for self-service changes (or require admin permission for resets), and verify the current password before writing the new password. Reject guest/unauthenticated requests and avoid disclosing whether arbitrary usernames exist if possible.",category:`Auth Bypass`,cwe_id:`CWE-862`}],Q={...W.lifeguard_result,security_findings:Z},$={title:`Example File`,text:``,changes:[{file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,old_file_path:null,pure_rename_id:null,change_type:`modified`,display_info:{blocks_to_show:[{type:`line`,before_line:68,after_line:72,content:`                    if let Some(text) = content.text.clone() {`},{type:`line`,before_line:69,after_line:73,content:`                        let role = content.role.clone().unwrap_or_default();`},{type:`line`,before_line:70,after_line:74,content:`                        // Convert role to ChatMessage`},{type:`hunk`,hunk:{snippet_id:`0032`,before_lines:[71,99],after_lines:[75,75],before_content:`                        match role.as_str() {
                            "user" => {
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                            "assistant" => {
                                messages.push(ChatMessage::Assistant {
                                    content: Some(text),
                                    name: None,
                                    tool_calls: None,
                                    reasoning_content: None,
                                });
                            }
                            "system" => {
                                messages.push(ChatMessage::System {
                                    content: text,
                                    name: None,
                                });
                            }
                            _ => {
                                // Unknown role, treat as user message
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                        }`,after_content:`                        messages.push(role_to_chat_message(role.as_str(), text));`,important:!1}},{type:`line`,before_line:100,after_line:76,content:`                    }`},{type:`line`,before_line:101,after_line:77,content:`                }`},{type:`line`,before_line:102,after_line:78,content:`            }`},{type:`line`,before_line:247,after_line:205,content:`    Ok(chat_req)`},{type:`line`,before_line:248,after_line:206,content:`}`},{type:`line`,before_line:249,after_line:207,content:``},{type:`hunk`,hunk:{snippet_id:`0033`,before_lines:[250,249],after_lines:[208,234],before_content:``,after_content:`/// Convert role and text to ChatMessage
fn role_to_chat_message(role: &str, text: String) -> ChatMessage {
    match role {
        "user" => ChatMessage::User {
            content: UserMessageContent::Text(text),
            name: None,
        },
        "assistant" => ChatMessage::Assistant {
            content: Some(text),
            name: None,
            tool_calls: None,
            reasoning_content: None,
        },
        "system" => ChatMessage::System {
            content: text,
            name: None,
        },
        _ => {
            // Unknown role, treat as user message
            ChatMessage::User {
                content: UserMessageContent::Text(text),
                name: None,
            }
        }
    }
}
`,important:!1}},{type:`line`,before_line:250,after_line:235,content:``},{type:`line`,before_line:251,after_line:236,content:`/// Convert ChatCompletionResponse to ResponsesResponse`},{type:`line`,before_line:252,after_line:237,content:`pub fn chat_to_responses(`}],default_hidden:!1},edits:[{snippet_id:`0026`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[10,16],after_lines:[10,18],before_content:`use crate::protocols::{
    chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage, UserMessageContent},
    common::{FunctionCallResponse, StreamOptions, ToolCall, UsageInfo},
    responses::{
        ResponseContentPart, ResponseInput, ResponseInputOutputItem, ResponseOutputItem,
        ResponseReasoningContent::ReasoningText, ResponseStatus, ResponsesRequest,
        ResponsesResponse, ResponsesUsage, StringOrContentParts,`,after_content:`use crate::{
    protocols::{
        chat::{ChatCompletionRequest, ChatCompletionResponse, ChatMessage, UserMessageContent},
        common::{FunctionCallResponse, StreamOptions, ToolCall, ToolChoice, UsageInfo},
        responses::{
            ResponseContentPart, ResponseInput, ResponseInputOutputItem, ResponseOutputItem,
            ResponseReasoningContent::ReasoningText, ResponseStatus, ResponsesRequest,
            ResponsesResponse, ResponsesUsage, StringOrContentParts,
        },`,important:!1},{snippet_id:`0027`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[18,17],after_lines:[20,20],before_content:``,after_content:`    routers::grpc::common::responses::utils::extract_tools_from_response_tools,`,important:!1},{snippet_id:`0028`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[26,26],after_lines:[29,30],before_content:`/// - Tool-related fields are passed through`,after_content:"/// - `tools` → function tools extracted from ResponseTools\n/// - `tool_choice` → passed through from request",important:!1},{snippet_id:`0029`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[71,99],after_lines:[75,75],before_content:`                        match role.as_str() {
                            "user" => {
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                            "assistant" => {
                                messages.push(ChatMessage::Assistant {
                                    content: Some(text),
                                    name: None,
                                    tool_calls: None,
                                    reasoning_content: None,
                                });
                            }
                            "system" => {
                                messages.push(ChatMessage::System {
                                    content: text,
                                    name: None,
                                });
                            }
                            _ => {
                                // Unknown role, treat as user message
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                        }`,after_content:`                        messages.push(role_to_chat_message(role.as_str(), text));`,important:!1},{snippet_id:`0030`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[105,133],after_lines:[81,81],before_content:`                        match role.as_str() {
                            "user" => {
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                            "assistant" => {
                                messages.push(ChatMessage::Assistant {
                                    content: Some(text),
                                    name: None,
                                    tool_calls: None,
                                    reasoning_content: None,
                                });
                            }
                            "system" => {
                                messages.push(ChatMessage::System {
                                    content: text,
                                    name: None,
                                });
                            }
                            _ => {
                                // Unknown role, treat as user message
                                messages.push(ChatMessage::User {
                                    content: UserMessageContent::Text(text),
                                    name: None,
                                });
                            }
                        }`,after_content:`                        messages.push(role_to_chat_message(role.as_str(), text));`,important:!1},{snippet_id:`0031`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[206,206],after_lines:[154,165],before_content:`    // 3. Build ChatCompletionRequest`,after_content:`    // 3. Extract function tools from ResponseTools
    // Only function tools are extracted here (include_mcp: false).
    // MCP tools are merged later by the tool loop (see tool_loop.rs:prepare_chat_tools_and_choice)
    // before the chat pipeline, where tool_choice constraints are applied to ALL tools combined.
    let function_tools = extract_tools_from_response_tools(req.tools.as_deref(), false);
    let tools = if function_tools.is_empty() {
        None
    } else {
        Some(function_tools)
    };

    // 4. Build ChatCompletionRequest`,important:!1},{snippet_id:`0032`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[230,232],after_lines:[189,190],before_content:`        // Note: tools and tool_choice will be handled separately for MCP transformation
        tools: None,       // Will be set by caller if needed
        tool_choice: None, // Will be set by caller if needed`,after_content:`        tools,
        tool_choice: req.tool_choice.clone(),`,important:!1},{snippet_id:`0033`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[250,249],after_lines:[208,234],before_content:``,after_content:`/// Convert role and text to ChatMessage
fn role_to_chat_message(role: &str, text: String) -> ChatMessage {
    match role {
        "user" => ChatMessage::User {
            content: UserMessageContent::Text(text),
            name: None,
        },
        "assistant" => ChatMessage::Assistant {
            content: Some(text),
            name: None,
            tool_calls: None,
            reasoning_content: None,
        },
        "system" => ChatMessage::System {
            content: text,
            name: None,
        },
        _ => {
            // Unknown role, treat as user message
            ChatMessage::User {
                content: UserMessageContent::Text(text),
                name: None,
            }
        }
    }
}
`,important:!1,references:[{old_range:{path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,start_line:71,end_line:99},new_range:{path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,start_line:208,end_line:233},type:`move`,explanation:'The repeated role-to-ChatMessage conversion logic that appeared twice in the old code (lines 71-99 and 105-133) was extracted into a new helper function `role_to_chat_message`. The match arms for "user", "assistant", "system", and the default case are preserved in the new function.\n'}]},{snippet_id:`0034`,file_path:`sgl-router/src/routers/grpc/regular/responses/conversions.rs`,change_type:`modified`,before_lines:[357,357],after_lines:[342,342],before_content:`        tool_choice: "auto".to_string(), // TODO: Map from original request`,after_content:`        tool_choice: ToolChoice::serialize_to_string(&original_req.tool_choice),`,important:!1}]}]}})))()}export{Kt as i,un as n,B as r,Jt as t};