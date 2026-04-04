#!/bin/bash
# analyze-request.sh — Pretty-print structured run.log events
# Usage:
#   ./scripts/analyze-request.sh                  # All recent requests (last 500 event lines)
#   ./scripts/analyze-request.sh <requestId>      # Single request timeline
#   ./scripts/analyze-request.sh --last           # Last started request
#   ./scripts/analyze-request.sh --last-complete  # Last completed request
#   ./scripts/analyze-request.sh --summary        # One-line summary per request

set -euo pipefail
LOGFILE="${CORTEX_LOG:-run.log}"

# Strip ANSI codes and winston prefixes, extract JSON
extract_json() {
    sed 's/\x1b\[[0-9;]*m//g' | sed 's/.*info: *//; s/.*error: *//; s/.*debug: *//' | grep '"evt":'
}

# Strip ANSI codes and winston prefixes, extract request progress JSON payloads
extract_progress_json() {
    sed 's/\x1b\[[0-9;]*m//g' | sed 's/.*debug: *//' | grep 'Publishing request progress to local subscribers:' | sed 's/.*Publishing request progress to local subscribers: //'
}

# Format a single JSON event line into a human-readable string
format_event() {
    python3 -c "
import sys, json

COLORS = {
    'request.start':  '\033[1;36m',  # bold cyan
    'request.end':    '\033[1;36m',
    'request.error':  '\033[1;31m',  # bold red
    'route.classifier_selected': '\033[1;34m',
    'route.selected': '\033[1;34m',
    'runtime.stage': '\033[90m',
    'runtime.stage.error': '\033[1;31m',
    'model.call':     '\033[33m',    # yellow
    'model.result':   '\033[32m',    # green
    'tool.exec':      '\033[35m',    # magenta
    'tool.round':     '\033[34m',    # blue
    'delegate.start': '\033[1;35m',  # bold magenta
    'delegate.end':   '\033[1;35m',
    'delegate.error': '\033[1;31m',  # bold red
    'plan.created':   '\033[1;33m',  # bold yellow (legacy)
    'plan.replan':    '\033[1;33m',
    'plan.step':      '\033[33m',
    'plan.skipped':   '\033[31m',    # red
    'plan.fanout.start': '\033[1;35m',
    'plan.fanout.complete': '\033[1;35m',
    'plan.fanout.worker_error': '\033[1;31m',
    'plan.worker_idle': '\033[31m',
    'plan.replan_blocked': '\033[1;31m',
    'compression':    '\033[90m',    # gray
    'memory.record':  '\033[90m',
}
RESET = '\033[0m'

def compact_budget(state, include_zero=False):
    if not isinstance(state, dict):
        return ''
    fields = [
        ('toolBudgetUsed', 'tools'),
        ('researchRounds', 'research'),
        ('searchCalls', 'search'),
        ('fetchCalls', 'fetch'),
        ('childRuns', 'child'),
        ('evidenceItems', 'evidence'),
    ]
    parts = []
    for key, label in fields:
        if key not in state:
            continue
        val = state.get(key)
        if include_zero or val not in (None, 0, ''):
            parts.append(f'{label}={val}')
    return '  budget[' + ' '.join(parts) + ']' if parts else ''

def preview_list(items, limit=3, width=88):
    if not isinstance(items, list) or not items:
        return []
    out = []
    for item in items[:limit]:
        text = str(item).replace('\\n', ' ').strip()
        if len(text) > width:
            text = text[:width - 3] + '...'
        out.append(text)
    return out

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except:
        continue

    evt = d.get('evt', '?')
    ts = d.get('ts', '')[11:23]  # HH:MM:SS.mmm
    color = COLORS.get(evt, '')

    if evt == 'request.start':
        model = d.get('model', '?')
        tlm = d.get('toolLoopModel', '')
        effort = d.get('reasoningEffort', '')
        peff = d.get('planningReasoningEffort', '')
        seff = d.get('synthesisReasoningEffort', '')
        conv = d.get('conversationMode', '')
        child_cap = d.get('authorityEnvelope', {}).get('maxChildRuns', '')
        tools = d.get('entityToolNames', [])
        tc = d.get('entityToolCount', 0)
        tlm_str = f'  processor={tlm}' if tlm else ''
        peff_str = f'  planning={peff}' if peff else ''
        seff_str = f'  synth={seff}' if seff else ''
        conv_str = f'  mode={conv}' if conv else ''
        child_str = f'  child_cap={child_cap}' if child_cap != '' else ''
        print(f'{color}{ts}  START        model={model}{tlm_str}  effort={effort}{peff_str}{seff_str}{conv_str}{child_str}  tools={tc}{RESET}')
        if tools:
            print(f'               tools: {tools}')

    elif evt == 'request.end':
        dur = d.get('durationMs', 0) / 1000
        rounds = d.get('toolRounds', 0)
        budget = d.get('budgetUsed', 0)
        execution = d.get('execution', {})
        runtime_budget = d.get('runtimeBudget', {})
        route = execution.get('routeMode', '')
        answer = execution.get('answerMode', '')
        route_str = f'  route={route}' if route else ''
        answer_str = f'  answer={answer}' if answer else ''
        print(f'{color}{ts}  END          {dur:.1f}s  rounds={rounds}  budget={budget}{route_str}{answer_str}{RESET}')
        budget_str = compact_budget(runtime_budget)
        if budget_str:
            print(f'               runtime:{budget_str}')
        print()

    elif evt == 'request.error':
        phase = d.get('phase', '?')
        err = d.get('error', '?')[:120]
        print(f'{color}{ts}  ERROR        phase={phase}  {err}{RESET}')

    elif evt == 'route.classifier_selected':
        mode = d.get('mode', '?')
        reason = d.get('reason', '?')
        conf = d.get('confidence', '?')
        category = d.get('toolCategory', '?')
        conv = d.get('conversationMode', '?')
        action = d.get('modeAction', '?')
        peff = d.get('planningEffort', '?')
        seff = d.get('synthesisEffort', '?')
        print(f'{color}{ts}  ROUTE-LLM    mode={mode}  reason={reason}  conf={conf}  category={category}  conv={conv}  action={action}  plan={peff}  synth={seff}{RESET}')

    elif evt == 'route.selected':
        mode = d.get('mode', '?')
        reason = d.get('reason', '?')
        source = d.get('routeSource', '?')
        conv = d.get('conversationMode', '?')
        peff = d.get('planningReasoningEffort', '')
        seff = d.get('synthesisReasoningEffort', '')
        peff_str = f'  plan={peff}' if peff else ''
        seff_str = f'  synth={seff}' if seff else ''
        print(f'{color}{ts}  ROUTE        mode={mode}  reason={reason}  source={source}  conv={conv}{peff_str}{seff_str}{RESET}')

    elif evt == 'runtime.stage':
        stage = d.get('stage', '?')
        model = d.get('model', '?')
        stop = d.get('stopReason', None)
        stop_str = f'  stop={stop}' if stop else ''
        print(f'{color}{ts}  STAGE        {stage}  model={model}{stop_str}{compact_budget(d.get(\"budgetState\", {}))}{RESET}')

    elif evt == 'runtime.stage.error':
        stage = d.get('stage', '?')
        err = d.get('error', '?')[:120]
        print(f'{color}{ts}  STAGE-ERROR  stage={stage}  {err}{RESET}')

    elif evt == 'callback.entry':
        depth = d.get('depth', '?')
        incoming = d.get('incomingToolCalls', [])
        plan = d.get('hasPlan', False)
        budget = d.get('budgetUsed', 0)
        plan_str = ' [has-plan]' if plan else ' [no-plan]'
        depth_warn = ' *** NESTED ***' if isinstance(depth, int) and depth > 1 else ''
        if incoming:
            names = [tc.get('name','?') for tc in incoming]
            print(f'{color}{ts}  CALLBACK     depth={depth}{plan_str}  budget={budget}  incoming={names}{depth_warn}{RESET}')
        else:
            print(f'{color}{ts}  CALLBACK     depth={depth}{plan_str}  budget={budget}  incoming=none{depth_warn}{RESET}')

    elif evt == 'model.call':
        model = d.get('model', '?')
        purpose = d.get('purpose', '?')
        stream = d.get('stream', False)
        effort = d.get('reasoningEffort', '')
        rnd = d.get('round', '')
        tool_names = d.get('toolNames', [])
        tc = d.get('toolChoice', '')
        replan = d.get('replanCount', '')
        msgs = d.get('messageCount', '')
        depth = d.get('callbackDepth', '')
        rnd_str = f'  round={rnd}' if rnd != '' else ''
        replan_str = f'  replan#{replan}' if replan != '' and replan != 0 else ''
        stream_str = ' stream' if stream else ''
        tc_str = f'  choice={tc}' if tc and tc != 'auto' else ''
        tn = f'  tools={tool_names}' if tool_names else '  tools=none'
        msgs_str = f'  msgs={msgs}' if msgs != '' else ''
        depth_str = f'  depth={depth}' if depth != '' else ''
        print(f'{color}{ts}  CALL         {model}  purpose={purpose}{stream_str}  effort={effort}{rnd_str}{replan_str}{tc_str}{tn}{msgs_str}{depth_str}{RESET}')

    elif evt == 'model.result':
        model = d.get('model', '?')
        purpose = d.get('purpose', '?')
        returned = d.get('returnedToolCalls')
        cb = d.get('streamingCallback', False)
        plan = d.get('hasPlan', False)
        chars = d.get('contentChars', '')
        dur = d.get('durationMs', '')
        depth = d.get('callbackDepth', '')
        cb_str = ' [streaming-cb]' if cb else ''
        plan_str = ' [has-plan]' if plan else ' [no-plan]'
        chars_str = f'  chars={chars}' if chars else ''
        dur_str = f'  {dur}ms' if dur != '' else ''
        depth_str = f'  depth={depth}' if depth != '' else ''
        if returned:
            args_parts = []
            for tc in returned:
                a = tc.get('args')
                if a:
                    if isinstance(a, dict):
                        brief = ', '.join(f'{k}={v}' for k,v in list(a.items())[:2])
                    else:
                        brief = str(a)[:60]
                    args_parts.append(f'{tc[\"name\"]}({brief})')
                else:
                    args_parts.append(tc.get('name','?'))
            print(f'{color}{ts}  RESULT       {model}  purpose={purpose}{dur_str}{cb_str}{plan_str}{depth_str}  returned=[{\"  \".join(args_parts)}]{RESET}')
        else:
            print(f'{color}{ts}  RESULT       {model}  purpose={purpose}{dur_str}{cb_str}{plan_str}{depth_str}  returned=none (text only){chars_str}{RESET}')

    elif evt == 'tool.exec':
        tool = d.get('tool', '?')
        rnd = d.get('round', '?')
        ms = d.get('durationMs', 0)
        ok = d.get('success', False)
        chars = d.get('resultChars', 0)
        dup = d.get('duplicate', False)
        err = d.get('error', '')
        args = d.get('toolArgs')
        status = 'OK' if ok else f'FAIL:{err[:50]}'
        dup_str = ' [dup]' if dup else ''
        args_str = ''
        if args:
            if isinstance(args, dict):
                args_str = '  ' + ', '.join(f'{k}={str(v)[:60]}' for k,v in list(args.items())[:3])
            else:
                args_str = f'  {str(args)[:80]}'
        print(f'{color}{ts}    TOOL       {tool}  round={rnd}  {ms}ms  {status}  {chars}ch{dup_str}{args_str}{RESET}')

    elif evt == 'tool.round':
        rnd = d.get('round', '?')
        tc = d.get('toolCount', 0)
        executed = d.get('executedToolCount', '')
        failed = d.get('failed', 0)
        invalid = d.get('invalidCount', 0)
        used = d.get('budgetUsed', 0)
        total = d.get('budgetTotal', 0)
        exhausted = d.get('budgetExhausted', False)
        exec_str = f'  executed={executed}' if executed != '' else ''
        fail_str = f'  FAILED={failed}' if failed else ''
        invalid_str = f'  invalid={invalid}' if invalid else ''
        exhausted_str = '  BUDGET-EXHAUSTED' if exhausted else ''
        print(f'{color}{ts}    ROUND      round={rnd}  tools={tc}{exec_str}{fail_str}{invalid_str}  budget={used}/{total}{exhausted_str}{RESET}')

    elif evt == 'plan.created':
        goal = d.get('goal', '?')[:80]
        steps = d.get('steps', 0)
        print(f'{color}{ts}  PLAN         \"{goal}\"  steps={steps}{RESET}')

    elif evt == 'plan.replan':
        rc = d.get('replanCount', '?')
        goal = d.get('goal', '?')[:80]
        steps = d.get('steps', 0)
        print(f'{color}{ts}  REPLAN #{rc}    \"{goal}\"  steps={steps}{RESET}')

    elif evt == 'plan.step':
        rnd = d.get('round', '?')
        steps = d.get('steps', '?')
        print(f'{color}{ts}  PLAN-STEP    round={rnd}  totalSteps={steps}{RESET}')

    elif evt == 'plan.skipped':
        reason = d.get('reason', '?')
        print(f'{color}{ts}  PLAN-SKIP    reason={reason}{RESET}')

    elif evt == 'plan.fanout.start':
        rnd = d.get('round', '?')
        child_runs = d.get('childRuns', '?')
        model = d.get('model', '?')
        task_count = d.get('taskCount', 0)
        print(f'{color}{ts}  FANOUT       round={rnd}  tasks={task_count}  child_runs={child_runs}  model={model}{RESET}')
        for task in preview_list(d.get('taskList', [])):
            print(f'               - {task}')

    elif evt == 'plan.fanout.complete':
        rnd = d.get('round', '?')
        child_runs = d.get('childRuns', '?')
        proposed = d.get('proposedToolCalls', 0)
        merged = d.get('mergedToolCalls', 0)
        idle = d.get('idleWorkers', 0)
        failed = d.get('failedWorkers', 0)
        print(f'{color}{ts}  FANOUT-END   round={rnd}  child_runs={child_runs}  proposed={proposed}  merged={merged}  idle={idle}  failed={failed}{RESET}')

    elif evt == 'plan.fanout.worker_error':
        task = d.get('task', '?')[:80]
        err = d.get('error', '?')[:120]
        print(f'{color}{ts}  FANOUT-ERR   task=\"{task}\"  {err}{RESET}')

    elif evt == 'plan.worker_idle':
        rnd = d.get('round', '?')
        fanout = d.get('fanout', False)
        idle = d.get('idleWorkers', 0)
        failed = d.get('failedWorkers', 0)
        print(f'{color}{ts}  WORKER-IDLE  round={rnd}  fanout={fanout}  idle={idle}  failed={failed}{RESET}')

    elif evt == 'plan.replan_blocked':
        reason = d.get('reason', '?')
        depth = d.get('callbackDepth', '?')
        executed = d.get('currentCycleExecutedToolCount', '?')
        proposed = d.get('proposedPlan', {})
        goal = str(proposed.get('goal', '?'))[:80]
        steps = proposed.get('steps', [])
        step_count = len(steps) if isinstance(steps, list) else '?'
        print(f'{color}{ts}  REPLAN-BLOCK reason={reason}  depth={depth}  executed={executed}  steps={step_count}  goal=\"{goal}\"{RESET}')

    elif evt == 'compression':
        before = d.get('beforeTokens', '?')
        after = d.get('afterTokens', '?')
        pct = d.get('pctOfLimit', '?')
        print(f'{color}{ts}  COMPRESS     {before} -> {after} tokens  ({pct}% of limit){RESET}')

    elif evt == 'delegate.start':
        model = d.get('model', '?')
        task = d.get('task', '?')[:80]
        cap = d.get('budgetCap', 0)
        tc = d.get('toolCount', 0)
        print(f'{color}{ts}  DELEGATE     model={model}  budget_cap={cap}  tools={tc}  \"{task}\"{RESET}')

    elif evt == 'delegate.end':
        rounds = d.get('rounds', 0)
        budget = d.get('budgetUsed', 0)
        chars = d.get('resultChars', 0)
        reason = d.get('reason', '')
        reason_str = f'  reason={reason}' if reason else ''
        print(f'{color}{ts}  DELEGATE-END rounds={rounds}  budget={budget}  result={chars}ch{reason_str}{RESET}')

    elif evt == 'delegate.error':
        err = d.get('error', '?')[:120]
        print(f'{color}{ts}  DELEGATE-ERR {err}{RESET}')

    elif evt == 'memory.record':
        mtype = d.get('type', '?')
        uc = d.get('userChars', 0)
        ac = d.get('assistantChars', 0)
        print(f'{color}{ts}  MEMORY       type={mtype}  user={uc}ch  assistant={ac}ch{RESET}')

    else:
        print(f'{ts}  {evt}  {json.dumps({k:v for k,v in d.items() if k not in (\"ts\",\"rid\",\"evt\")})}')"
}

# Summary mode: one line per request
format_summary() {
    python3 -c "
import sys, json

requests = {}
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
    except: continue
    rid = d.get('rid','?')
    evt = d.get('evt','')
    if rid not in requests:
        requests[rid] = {
            'tools': 0,
            'rounds': 0,
            'delegates': 0,
            'dur': 0,
            'model': '?',
            'synth': 0,
            'finalize': 0,
            'fanout_rounds': 0,
            'child_calls': 0,
            'merged_tools': 0,
            'idle_workers': 0,
            'max_depth': 0,
            'route_mode': '?',
            'route_reason': '?',
            'answer': '?',
            'budget': 0,
            'ts': '?',
            'status': 'routed',
            'last_stage': '?',
            'blocked_reason': '',
            'started': False,
            'ended': False,
        }
    r = requests[rid]
    ts = d.get('ts','')[11:23]
    if ts and r['ts'] == '?':
        r['ts'] = ts
    if evt == 'request.start':
        r['started'] = True
        r['status'] = 'active'
        r['model'] = d.get('model','?')
        r['ts'] = ts or r['ts']
    elif evt == 'request.end':
        r['ended'] = True
        r['status'] = 'done'
        r['dur'] = d.get('durationMs',0)/1000
        r['rounds'] = d.get('toolRounds',0)
        r['budget'] = d.get('budgetUsed',0)
        execution = d.get('execution', {})
        if execution.get('routeMode'):
            r['route_mode'] = execution.get('routeMode')
        if execution.get('answerMode'):
            r['answer'] = execution.get('answerMode')
    elif evt == 'tool.exec':
        r['tools'] += 1
    elif evt == 'delegate.start':
        r['delegates'] += 1
    elif evt == 'model.call':
        purpose = d.get('purpose')
        if purpose == 'synthesis':
            r['synth'] += 1
        elif purpose == 'synthesis_finalize':
            r['finalize'] += 1
        elif purpose == 'child_fanout':
            r['child_calls'] += 1
    elif evt in ('route.selected', 'route.classifier_selected'):
        if d.get('mode'):
            r['route_mode'] = d.get('mode')
        if d.get('reason'):
            r['route_reason'] = d.get('reason')
    elif evt == 'runtime.stage':
        stage = d.get('stage', '?')
        r['last_stage'] = stage
        if not r['ended'] and r['started']:
            r['status'] = f'active:{stage}'
    elif evt == 'callback.entry':
        depth = d.get('depth', 0)
        if isinstance(depth, int):
            r['max_depth'] = max(r['max_depth'], depth)
    elif evt == 'plan.fanout.start':
        r['fanout_rounds'] += 1
    elif evt == 'plan.fanout.complete':
        r['merged_tools'] += d.get('mergedToolCalls', 0) or 0
        r['idle_workers'] += d.get('idleWorkers', 0) or 0
    elif evt == 'plan.replan_blocked':
        r['blocked_reason'] = d.get('reason', '') or r['blocked_reason']

for rid, r in requests.items():
    ts = r.get('ts','?')
    route = r.get('route_mode', '?')
    reason = r.get('route_reason', '?')
    if reason not in ('', '?'):
        route = f'{route}/{reason}'
    blocked = f\" blocked={r['blocked_reason']}\" if r['blocked_reason'] else ''
    answer = f\" answer={r['answer']}\" if r['answer'] not in ('', '?') else ''
    if r['ended']:
        print(
            f\"{ts}  {rid[:8]}  {r['dur']:6.1f}s  route={route}{answer}  rounds={r['rounds']}  tools={r['tools']}  \"
            f\"synth={r['synth']}  fin={r['finalize']}  fanout={r['fanout_rounds']}  child={r['child_calls']}  \"
            f\"merged={r['merged_tools']}  depth={r['max_depth']}{blocked}  budget={r.get('budget',0)}\"
        )
    else:
        stage = r.get('last_stage', '?')
        print(
            f\"{ts}  {rid[:8]}  {r['status']:<14}  route={route}  stage={stage}  model={r['model']}  \"
            f\"tools={r['tools']}  synth={r['synth']}  fanout={r['fanout_rounds']}  depth={r['max_depth']}{blocked}\"
        )
"
}

format_progress() {
    python3 -c "
import sys, json, os
from datetime import datetime, timezone

start_ts = os.environ.get('START_TS', '')
start_epoch = None
if start_ts:
    try:
        start_epoch = datetime.fromisoformat(start_ts.replace('Z', '+00:00')).timestamp()
    except Exception:
        start_epoch = None

def shorten(text, width=96):
    text = str(text).replace('\\n', ' ').strip()
    if len(text) > width:
        return text[:width - 3] + '...'
    return text

def rel_from_created(created):
    if start_epoch is None or created in (None, ''):
        return ''
    try:
        return f'+{float(created) - start_epoch:0.1f}s'
    except Exception:
        return ''

def prefix(created):
    rel = rel_from_created(created)
    return f'{rel:>12}' if rel else ' ' * 12

def compact_budget(state):
    if not isinstance(state, dict):
        return ''
    fields = [
        ('toolBudgetUsed', 'tools'),
        ('researchRounds', 'research'),
        ('searchCalls', 'search'),
        ('fetchCalls', 'fetch'),
        ('childRuns', 'child'),
        ('evidenceItems', 'evidence'),
    ]
    parts = []
    for key, label in fields:
        val = state.get(key)
        if val not in (None, ''):
            parts.append(f'{label}={val}')
    return '  budget[' + ' '.join(parts) + ']' if parts else ''

progress_events = 0
tool_delta_events = 0
text_chunks = 0
tool_msg_start = 0
tool_msg_finish = 0
first_text_seen = False
meta_printed = False
final_seen = False

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        payload = json.loads(line)
    except Exception:
        continue

    progress_events += 1
    info_obj = {}
    raw_info = payload.get('info')
    if isinstance(raw_info, str) and raw_info:
        try:
            info_obj = json.loads(raw_info)
        except Exception:
            info_obj = {}
    elif isinstance(raw_info, dict):
        info_obj = raw_info

    if not meta_printed and isinstance(info_obj.get('entityRuntime'), dict):
        runtime = info_obj['entityRuntime']
        route = runtime.get('routeMode', '?')
        reason = runtime.get('routeReason', '?')
        mode = runtime.get('conversationMode', '?')
        print(f'              STREAM-META route={route}/{reason}  mode={mode}{compact_budget(runtime.get(\"budgetState\", {}))}')
        meta_printed = True

    tool_message = info_obj.get('toolMessage')
    if isinstance(tool_message, dict):
        ttype = tool_message.get('type', '?')
        tool_name = tool_message.get('toolName', '?')
        if ttype == 'start':
            tool_msg_start += 1
            user_message = shorten(tool_message.get('userMessage', ''), 80)
            print(f'              TOOL-MSG    start {tool_name}  {user_message}')
        elif ttype == 'finish':
            tool_msg_finish += 1
            success = tool_message.get('success')
            status = 'ok' if success else 'fail'
            print(f'              TOOL-MSG    finish {tool_name}  {status}')

    data_obj = None
    raw_data = payload.get('data')
    if isinstance(raw_data, str) and raw_data.startswith('{'):
        try:
            data_obj = json.loads(raw_data)
        except Exception:
            data_obj = None

    if isinstance(data_obj, dict):
        choices = data_obj.get('choices') or []
        first_choice = choices[0] if choices else {}
        delta = first_choice.get('delta') or {}
        finish_reason = first_choice.get('finish_reason')
        created = data_obj.get('created')

        tool_calls = delta.get('tool_calls') or []
        if tool_calls:
            tool_delta_events += 1
            names = []
            for call in tool_calls:
                function_obj = call.get('function') or {}
                names.append(function_obj.get('name') or call.get('name') or '?')
            finish_str = f'  finish={finish_reason}' if finish_reason else ''
            print(f'{prefix(created)}  TOOL-DELTA  names={names}{finish_str}')

        content = delta.get('content')
        if isinstance(content, str) and content:
            text_chunks += 1
            if not first_text_seen:
                print(f'{prefix(created)}  TEXT-START  {shorten(content)}')
                first_text_seen = True
            elif finish_reason == 'stop':
                print(f'{prefix(created)}  TEXT-END    {shorten(content)}')

    if payload.get('progress') == 1 and not final_seen:
        final_seen = True
        runtime = info_obj.get('entityRuntime') if isinstance(info_obj.get('entityRuntime'), dict) else {}
        tool_history = info_obj.get('toolHistory')
        tool_history_count = len(tool_history) if isinstance(tool_history, list) else 0
        route = runtime.get('routeMode', '?')
        reason = runtime.get('routeReason', '?')
        print(f'              STREAM-END  route={route}/{reason}  tool_history={tool_history_count}{compact_budget(runtime.get(\"budgetState\", {}))}')

if progress_events:
    print(f'              STREAM-SUM  events={progress_events}  tool_deltas={tool_delta_events}  tool_msgs={tool_msg_start}/{tool_msg_finish}  text_chunks={text_chunks}')
"
}

show_request() {
    local rid="$1"
    local start_ts=""
    local progress_lines=""

    grep "$rid" "$LOGFILE" | extract_json | format_event

    start_ts=$(grep "$rid" "$LOGFILE" | extract_json | python3 -c "import sys,json
for raw in sys.stdin:
    d=json.loads(raw)
    if d.get('evt') == 'request.start':
        print(d.get('ts',''))
        break
" 2>/dev/null || true)

    progress_lines="$(grep "$rid" "$LOGFILE" | extract_progress_json || true)"
    if [ -n "$progress_lines" ]; then
        echo
        echo "Progress:"
        START_TS="$start_ts"
        export START_TS
        printf '%s\n' "$progress_lines" | format_progress
        unset START_TS
    fi
}

if [ "${1:-}" = "--summary" ]; then
    cat "$LOGFILE" | extract_json | format_summary
elif [ "${1:-}" = "--last-complete" ]; then
    LAST_RID=$(cat "$LOGFILE" | extract_json | python3 -c "import sys,json; last=''; 
for raw in sys.stdin:
    d=json.loads(raw)
    if d.get('evt') == 'request.end':
        last=d.get('rid','')
print(last)" 2>/dev/null)
    if [ -n "$LAST_RID" ]; then
        show_request "$LAST_RID"
    else
        echo "No completed requests found in $LOGFILE"
    fi
elif [ "${1:-}" = "--last" ]; then
    LAST_RID=$(cat "$LOGFILE" | extract_json | python3 -c "import sys,json; any_rid=''; started=''; 
for raw in sys.stdin:
    d=json.loads(raw)
    rid=d.get('rid','')
    evt=d.get('evt','')
    if rid:
        any_rid=rid
    if evt == 'request.start':
        started=rid
print(started or any_rid)" 2>/dev/null)
    if [ -n "$LAST_RID" ]; then
        show_request "$LAST_RID"
    else
        echo "No requests found in $LOGFILE"
    fi
elif [ -n "${1:-}" ]; then
    show_request "$1"
else
    cat "$LOGFILE" | extract_json | tail -500 | format_event
fi
