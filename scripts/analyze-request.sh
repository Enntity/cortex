#!/bin/bash
# analyze-request.sh — Pretty-print structured run.log events
# Usage:
#   ./scripts/analyze-request.sh                  # All recent requests (last 500 event lines)
#   ./scripts/analyze-request.sh <requestId>      # Single request timeline
#   ./scripts/analyze-request.sh --last           # Last request only
#   ./scripts/analyze-request.sh --summary        # One-line summary per request

set -euo pipefail
LOGFILE="${CORTEX_LOG:-run.log}"

# Strip ANSI codes and winston prefixes, extract JSON
extract_json() {
    sed 's/\x1b\[[0-9;]*m//g' | sed 's/.*info: *//; s/.*error: *//; s/.*debug: *//' | grep '"evt":'
}

# Format a single JSON event line into a human-readable string
format_event() {
    python3 -c "
import sys, json

COLORS = {
    'request.start': '\033[1;36m',  # bold cyan
    'request.end':   '\033[1;36m',
    'request.error': '\033[1;31m',  # bold red
    'model.call':    '\033[33m',    # yellow
    'model.result':  '\033[32m',    # green
    'tool.exec':     '\033[35m',    # magenta
    'tool.round':    '\033[34m',    # blue
    'plan.created':  '\033[1;33m',  # bold yellow
    'plan.replan':   '\033[1;33m',
    'plan.step':     '\033[33m',
    'plan.skipped':  '\033[31m',    # red
    'compression':   '\033[90m',    # gray
    'memory.record': '\033[90m',
}
RESET = '\033[0m'

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
        tools = d.get('entityToolNames', [])
        tc = d.get('entityToolCount', 0)
        tlm_str = f'  executor={tlm}' if tlm else ''
        print(f'{color}{ts}  START        model={model}{tlm_str}  effort={effort}  tools={tc}{RESET}')
        if tools:
            print(f'               tools: {tools}')

    elif evt == 'request.end':
        dur = d.get('durationMs', 0) / 1000
        rounds = d.get('toolRounds', 0)
        budget = d.get('budgetUsed', 0)
        print(f'{color}{ts}  END          {dur:.1f}s  rounds={rounds}  budget={budget}{RESET}')
        print()

    elif evt == 'request.error':
        phase = d.get('phase', '?')
        err = d.get('error', '?')[:120]
        print(f'{color}{ts}  ERROR        phase={phase}  {err}{RESET}')

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
        failed = d.get('failed', 0)
        used = d.get('budgetUsed', 0)
        total = d.get('budgetTotal', 0)
        fail_str = f'  FAILED={failed}' if failed else ''
        print(f'{color}{ts}    ROUND      round={rnd}  tools={tc}{fail_str}  budget={used}/{total}{RESET}')

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

    elif evt == 'compression':
        before = d.get('beforeTokens', '?')
        after = d.get('afterTokens', '?')
        pct = d.get('pctOfLimit', '?')
        print(f'{color}{ts}  COMPRESS     {before} -> {after} tokens  ({pct}% of limit){RESET}')

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
        requests[rid] = {'tools':0,'rounds':0,'plans':0,'replans':0,'dur':0,'model':'?','synth':0,'gate_retries':0}
    r = requests[rid]
    if evt == 'request.start':
        r['model'] = d.get('model','?')
        r['ts'] = d.get('ts','')[11:23]
        r['executor'] = d.get('toolLoopModel','')
    elif evt == 'request.end':
        r['dur'] = d.get('durationMs',0)/1000
        r['rounds'] = d.get('toolRounds',0)
        r['budget'] = d.get('budgetUsed',0)
    elif evt == 'tool.exec':
        r['tools'] += 1
    elif evt == 'plan.created':
        r['plans'] += 1
    elif evt == 'plan.replan':
        r['replans'] += 1
    elif evt == 'model.call' and d.get('purpose') == 'synthesis':
        r['synth'] += 1
    elif evt == 'model.call' and d.get('purpose') == 'gate_retry':
        r['gate_retries'] += 1

for rid, r in requests.items():
    ts = r.get('ts','?')
    ex = f\"  exec={r['executor']}\" if r.get('executor') else ''
    gate = f\"  gate_retries={r['gate_retries']}\" if r['gate_retries'] else ''
    print(f\"{ts}  {rid[:8]}  {r['dur']:6.1f}s  model={r['model']}{ex}  rounds={r['rounds']}  tools={r['tools']}  synth={r['synth']}  plans={r['plans']}  replans={r['replans']}{gate}  budget={r.get('budget',0)}\")
"
}

if [ "${1:-}" = "--summary" ]; then
    cat "$LOGFILE" | extract_json | format_summary
elif [ "${1:-}" = "--last" ]; then
    LAST_RID=$(cat "$LOGFILE" | extract_json | tail -1 | python3 -c "import sys,json; print(json.loads(sys.stdin.read().strip()).get('rid',''))" 2>/dev/null)
    if [ -n "$LAST_RID" ]; then
        grep "$LAST_RID" "$LOGFILE" | extract_json | format_event
    else
        echo "No requests found in $LOGFILE"
    fi
elif [ -n "${1:-}" ]; then
    grep "$1" "$LOGFILE" | extract_json | format_event
else
    cat "$LOGFILE" | extract_json | tail -500 | format_event
fi
