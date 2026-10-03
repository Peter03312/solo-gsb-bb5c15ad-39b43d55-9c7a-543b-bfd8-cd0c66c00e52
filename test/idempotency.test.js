'use strict';
/**
 * 请求编号幂等（现场断网重送去重）端到端测试。
 *
 * 运行：node test/idempotency.test.js   （需要 Node ≥ 22.13，使用内置 node:sqlite）
 *
 * 自动以独立子进程启动服务（临时数据库、独立端口、关闭演示数据），
 * 顺序跑完全部场景后关闭服务并清理临时文件；任一断言失败以非零码退出。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3460;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `cue-idempotency-test-${process.pid}.db`);

/* ---------------- 小框架 ---------------- */

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${extra !== undefined ? ` —— 实际：${JSON.stringify(extra)}` : ''}`);
  }
}
function section(title) {
  console.log(`\n■ ${title}`);
}

async function call(method, apiPath, body, headers) {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (p, b, h) => call('POST', p, b, h);
const get = (p) => call('GET', p);

/* ---------------- 公共服务 ---------------- */

let serverProc = null;

async function waitReady() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/shows`);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('服务启动超时');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH, SEED_DEMO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}

function stopServer() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch (_) { /* ignore */ }
  }
}

/* ---------------- 业务准备 ---------------- */

let SHOW_ID = 0;
let V1 = 0; // 版本 1（L1 / S1 / B2 需复核 / P1 需预备）
let V2 = 0; // 版本 2（同内容 + S3，作为接续目标）

async function setupShow() {
  const show = await post('/api/shows', { name: '幂等测试剧目' });
  SHOW_ID = show.data.show.id;

  const v1 = await post(`/api/shows/${SHOW_ID}/versions`, { note: 'v1' });
  V1 = v1.data.version.id;
  const cues = [
    { label: 'L1', type: 'light', description: '开场灯渐亮', deps: [] },
    { label: 'S1', type: 'sound', description: '开场音乐起', deps: ['L1'] },
    { label: 'B2', type: 'set', description: '船台推出（需复核）', deps: ['L1'], needs_review: true },
    { label: 'P1', type: 'light', description: '追光（需预备）', deps: ['L1'], needs_prep: true },
  ];
  await call('PUT', `/api/versions/${V1}/cues`, { cues });
  const pub1 = await post(`/api/versions/${V1}/publish`, {});
  if (pub1.status !== 200) throw new Error(`v1 发布失败：${JSON.stringify(pub1.data)}`);

  const v2 = await post(`/api/shows/${SHOW_ID}/versions`, { note: 'v2' });
  V2 = v2.data.version.id;
  await call('PUT', `/api/versions/${V2}/cues`, {
    cues: [...cues, { label: 'S3', type: 'sound', description: '雨声渐入（新增）', deps: ['S1'] }],
  });
  const pub2 = await post(`/api/versions/${V2}/publish`, {});
  if (pub2.status !== 200) throw new Error(`v2 发布失败：${JSON.stringify(pub2.data)}`);
}

async function newPerf() {
  const r = await post(`/api/shows/${SHOW_ID}/performances`, { version_id: V1, operator: '测试' });
  return r.data.performance.id;
}

async function cueIds(perfId) {
  const r = await get(`/api/performances/${perfId}`);
  const map = {};
  for (const c of r.data.cues) map[c.label] = c.id;
  return map;
}

async function eventsOf(perfId) {
  const r = await get(`/api/performances/${perfId}`);
  return r.data.events;
}

/* ---------------- 场景 ---------------- */

async function t1_fireReplay() {
  section('T1 触发幂等：同编号同输入重送返回首次结果，不产生新流水；未附编号行为不变');
  const perf = await newPerf();
  const c = await cueIds(perf);

  const first = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T1-K1' });
  ok(first.status === 200 && first.data.event && first.data.event.action === 'fired', '首次触发成功', first);
  ok(first.data.idempotent_replay === undefined, '首次响应不带重放标记（返回字段兼容）', first.data);
  const eventId = first.data.event.id;

  const replay = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T1-K1' });
  ok(replay.status === 200 && replay.data.event && replay.data.event.id === eventId, '重送返回首次成功的同一流水', replay);
  ok(replay.data.idempotent_replay === true && replay.data.request_id === 'T1-K1', '重放响应带 idempotent_replay 标记与请求编号', replay.data);

  const events = await eventsOf(perf);
  ok(events.length === 1, '重送不产生新流水（仍 1 条）', events.length);

  const noKey = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三' });
  ok(noKey.status === 200 && noKey.data.event && noKey.data.idempotent_replay === undefined, '未附编号的触发保持原有行为', noKey);
  const dup = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三' });
  ok(dup.status === 409, '未附编号的重复触发仍按既有规则 409', dup.status);
}

async function t2_conflict() {
  section('T2 编号复用冲突：同编号不同操作或输入 → 409 且不改数据');
  const perf = await newPerf();
  const c = await cueIds(perf);

  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T2-K' });

  const diffInput = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '李四', request_id: 'T2-K' });
  ok(diffInput.status === 409 && diffInput.data.request_id_conflict === true, '同编号不同输入 → 409 冲突', diffInput);
  ok(typeof diffInput.data.error === 'string' && diffInput.data.error.includes('T2-K'), '冲突消息含请求编号', diffInput.data);

  const diffOp = await post(`/api/performances/${perf}/cues/${c.L1}/skip`, { operator: '张三', reason: 'x', request_id: 'T2-K' });
  ok(diffOp.status === 409 && diffOp.data.request_id_conflict === true, '同编号不同操作（跳过） → 409 冲突', diffOp);

  const diffCue = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T2-K' });
  ok(diffCue.status === 409 && diffCue.data.request_id_conflict === true, '同编号不同提示 → 409 冲突', diffCue);

  const events = await eventsOf(perf);
  ok(events.length === 1, '冲突请求不改动任何数据（仍 1 条流水）', events.length);
}

async function t3_failureNotOccupied() {
  section('T3 校验失败不占号：失败后重试按最新现场状态判定');
  const perf = await newPerf();
  const c = await cueIds(perf);

  const blocked = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T3-K' });
  ok(blocked.status === 422 && Array.isArray(blocked.data.unmet), '前置未满足 → 422（不占号）', blocked);

  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T3-K2' });

  const retry = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T3-K' });
  ok(retry.status === 200 && retry.data.event && retry.data.event.action === 'fired', '前置补齐后同编号重试成功', retry);

  const replay = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T3-K' });
  ok(replay.status === 200 && replay.data.idempotent_replay === true && replay.data.event.id === retry.data.event.id, '此后重送返回首次成功结果', replay);

  const events = await eventsOf(perf);
  ok(events.length === 2, '流水仅 2 条（L1、S1 各一次）', events.length);
}

async function t4_skipRetract() {
  section('T4 跳过 / 撤回幂等');
  const perf = await newPerf();
  const c = await cueIds(perf);

  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T4-K1' });
  const skip = await post(`/api/performances/${perf}/cues/${c.S1}/skip`, { operator: '李四', reason: '设备故障', request_id: 'T4-K2' });
  ok(skip.status === 200 && skip.data.event.action === 'skipped', '跳过成功', skip);
  const skipReplay = await post(`/api/performances/${perf}/cues/${c.S1}/skip`, { operator: '李四', reason: '设备故障', request_id: 'T4-K2' });
  ok(skipReplay.status === 200 && skipReplay.data.idempotent_replay === true && skipReplay.data.event.id === skip.data.event.id, '跳过重送返回首次结果', skipReplay);

  const retract = await post(`/api/performances/${perf}/cues/${c.L1}/retract`, { operator: '王五', reason: '误触发', request_id: 'T4-K3' });
  ok(retract.status === 200 && retract.data.event.action === 'retracted', '撤回成功', retract);
  const retractReplay = await post(`/api/performances/${perf}/cues/${c.L1}/retract`, { operator: '王五', reason: '误触发', request_id: 'T4-K3' });
  ok(retractReplay.status === 200 && retractReplay.data.idempotent_replay === true && retractReplay.data.event.id === retract.data.event.id, '撤回重送返回首次结果', retractReplay);

  const events = await eventsOf(perf);
  ok(events.length === 3, '流水共 3 条（触发 / 跳过 / 撤回），重送未新增', events.length);

  const refire = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T4-K4' });
  ok(refire.status === 200, '撤回后换新编号可再次触发', refire);
}

async function t5_review() {
  section('T5 复核申请与处置（确认 / 撤销 / 驳回）幂等');
  const perf = await newPerf();
  const c = await cueIds(perf);
  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T5-K0' });

  const req = await post(`/api/performances/${perf}/cues/${c.B2}/fire`, { operator: '张三', request_id: 'T5-K1' });
  ok(req.status === 200 && req.data.request && req.data.request.status === 'pending', '需复核提示触发转为登记申请', req);
  const reqId = req.data.request.id;
  const reqReplay = await post(`/api/performances/${perf}/cues/${c.B2}/fire`, { operator: '张三', request_id: 'T5-K1' });
  ok(reqReplay.status === 200 && reqReplay.data.idempotent_replay === true && reqReplay.data.request.id === reqId, '申请重送返回同一申请（不重复登记）', reqReplay);

  const confirm = await post(`/api/performances/${perf}/review-requests/${reqId}/confirm`, { operator: '李四', request_id: 'T5-K2' });
  ok(confirm.status === 200 && confirm.data.event && confirm.data.event.action === 'fired', '另一操作人确认触发成功', confirm);
  const confirmReplay = await post(`/api/performances/${perf}/review-requests/${reqId}/confirm`, { operator: '李四', request_id: 'T5-K2' });
  ok(confirmReplay.status === 200 && confirmReplay.data.idempotent_replay === true && confirmReplay.data.event.id === confirm.data.event.id, '确认重送返回首次结果（不重复触发）', confirmReplay);

  let state = await get(`/api/performances/${perf}`);
  ok(state.data.review_requests.length === 1 && state.data.events.length === 2, '申请与流水均不重复', { req: state.data.review_requests.length, ev: state.data.events.length });

  // 撤销
  const perf2 = await newPerf();
  const c2 = await cueIds(perf2);
  const req2 = await post(`/api/performances/${perf2}/cues/${c2.B2}/review-requests`, { operator: '张三', request_id: 'T5-K3' });
  const cancel = await post(`/api/performances/${perf2}/review-requests/${req2.data.request.id}/cancel`, { operator: '张三', request_id: 'T5-K4' });
  ok(cancel.status === 200 && cancel.data.request.status === 'cancelled', '撤销申请成功', cancel);
  const cancelReplay = await post(`/api/performances/${perf2}/review-requests/${req2.data.request.id}/cancel`, { operator: '张三', request_id: 'T5-K4' });
  ok(cancelReplay.status === 200 && cancelReplay.data.idempotent_replay === true, '撤销重送返回首次结果', cancelReplay);

  // 驳回
  const perf3 = await newPerf();
  const c3 = await cueIds(perf3);
  const req3 = await post(`/api/performances/${perf3}/cues/${c3.B2}/review-requests`, { operator: '张三', request_id: 'T5-K5' });
  const reject = await post(`/api/performances/${perf3}/review-requests/${req3.data.request.id}/reject`, { operator: '李四', reason: '时机不对', request_id: 'T5-K6' });
  ok(reject.status === 200 && reject.data.request.status === 'rejected', '驳回申请成功', reject);
  const rejectReplay = await post(`/api/performances/${perf3}/review-requests/${req3.data.request.id}/reject`, { operator: '李四', reason: '时机不对', request_id: 'T5-K6' });
  ok(rejectReplay.status === 200 && rejectReplay.data.idempotent_replay === true, '驳回重送返回首次结果', rejectReplay);
}

async function t6_prep() {
  section('T6 预备口令（发出 / 确认）幂等');
  const perf = await newPerf();
  const c = await cueIds(perf);
  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T6-K0' });

  const issue = await post(`/api/performances/${perf}/cues/${c.P1}/prep-commands`, { issued_by: '王监', request_id: 'T6-K1' });
  ok(issue.status === 200 && issue.data.command && issue.data.command.status === 'pending', '发出预备口令成功', issue);
  const cmdId = issue.data.command.id;
  const issueReplay = await post(`/api/performances/${perf}/cues/${c.P1}/prep-commands`, { issued_by: '王监', request_id: 'T6-K1' });
  ok(issueReplay.status === 200 && issueReplay.data.idempotent_replay === true && issueReplay.data.command.id === cmdId, '发令重送返回同一口令（不重复发令、不作废旧令）', issueReplay);

  const confirm = await post(`/api/performances/${perf}/prep-commands/${cmdId}/confirm`, { operator: '李四', request_id: 'T6-K2' });
  ok(confirm.status === 200 && confirm.data.command.status === 'ready', '另一操作人确认就绪成功', confirm);
  const confirmReplay = await post(`/api/performances/${perf}/prep-commands/${cmdId}/confirm`, { operator: '李四', request_id: 'T6-K2' });
  ok(confirmReplay.status === 200 && confirmReplay.data.idempotent_replay === true && confirmReplay.data.command.status === 'ready', '确认重送返回首次结果', confirmReplay);

  const state = await get(`/api/performances/${perf}`);
  ok(state.data.prep_commands.length === 1, '口令仅 1 条（重送未新增）', state.data.prep_commands.length);

  const fire = await post(`/api/performances/${perf}/cues/${c.P1}/fire`, { operator: '张三', request_id: 'T6-K3' });
  ok(fire.status === 200 && fire.data.event.action === 'fired', '就绪后触发成功（消耗口令）', fire);
}

async function t7_fault() {
  section('T7 故障登记 / 解除幂等；故障期 422 不占号');
  const perf = await newPerf();
  const c = await cueIds(perf);

  const reg = await post(`/api/performances/${perf}/cues/${c.S1}/faults`, { operator: '王监', reason: '功放烧毁', request_id: 'T7-K1' });
  ok(reg.status === 200 && reg.data.fault && reg.data.fault.status === 'active', '登记故障成功', reg);
  const faultId = reg.data.fault.id;
  const regReplay = await post(`/api/performances/${perf}/cues/${c.S1}/faults`, { operator: '王监', reason: '功放烧毁', request_id: 'T7-K1' });
  ok(regReplay.status === 200 && regReplay.data.idempotent_replay === true && regReplay.data.fault.id === faultId, '登记重送返回同一故障记录（不重复登记）', regReplay);

  const blocked = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T7-K2' });
  ok(blocked.status === 422 && Array.isArray(blocked.data.blocked_by_faults), '故障期触发 → 422（不占号）', blocked);

  const resolve = await post(`/api/performances/${perf}/faults/${faultId}/resolve`, { operator: '王监', reason: '已更换功放', request_id: 'T7-K3' });
  ok(resolve.status === 200 && resolve.data.fault.status === 'resolved', '解除故障成功', resolve);
  const resolveReplay = await post(`/api/performances/${perf}/faults/${faultId}/resolve`, { operator: '王监', reason: '已更换功放', request_id: 'T7-K3' });
  ok(resolveReplay.status === 200 && resolveReplay.data.idempotent_replay === true, '解除重送返回首次结果', resolveReplay);

  const state = await get(`/api/performances/${perf}`);
  ok(state.data.faults.length === 1, '故障记录仅 1 条（重送未新增）', state.data.faults.length);

  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T7-K4' });
  const retry = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T7-K2' });
  ok(retry.status === 200 && retry.data.event.action === 'fired', '故障解除且前置补齐后，同编号重试成功', retry);
}

async function t8_batch() {
  section('T8 成组提交幂等');
  const perf = await newPerf();

  const payload = {
    operator: '王监',
    items: [
      { label: 'L1', action: 'fire' },
      { label: 'S1', action: 'skip', reason: '设备故障跳过' },
    ],
    request_id: 'T8-K1',
  };
  const submit = await post(`/api/performances/${perf}/batch`, payload);
  ok(submit.status === 200 && submit.data.submitted === true && submit.data.success_count === 2, '成组提交成功', submit);
  const ids = submit.data.results.map((r) => r.event && r.event.id);

  const replay = await post(`/api/performances/${perf}/batch`, payload);
  ok(replay.status === 200 && replay.data.idempotent_replay === true, '成组重送返回首次结果', replay.status);
  const ids2 = replay.data.results.map((r) => r.event && r.event.id);
  ok(JSON.stringify(ids2) === JSON.stringify(ids), '重送结果的流水 id 与首次完全一致', ids2);

  const events = await eventsOf(perf);
  ok(events.length === 2, '整组仅 2 条流水（重送未新增）', events.length);

  const conflict = await post(`/api/performances/${perf}/batch`, { ...payload, items: [{ label: 'L1', action: 'fire' }] });
  ok(conflict.status === 409 && conflict.data.request_id_conflict === true, '同编号不同清单 → 409 冲突', conflict);
}

async function t9_handover() {
  section('T9 交接（提交 / 签收）幂等');
  const perf = await newPerf();

  const submit = await post(`/api/performances/${perf}/handover`, { handed_by: '张三', received_by: '李四', note: '换班', request_id: 'T9-K1' });
  ok(submit.status === 200 && submit.data.handover && submit.data.handover.status === 'pending', '提交交接单成功', submit);
  const handoverId = submit.data.handover.id;
  const submitReplay = await post(`/api/performances/${perf}/handover`, { handed_by: '张三', received_by: '李四', note: '换班', request_id: 'T9-K1' });
  ok(submitReplay.status === 200 && submitReplay.data.idempotent_replay === true && submitReplay.data.handover.id === handoverId, '提交重送返回同一交接单（不重复生成、不替换快照）', submitReplay);

  const sign = await post(`/api/performances/${perf}/handover/sign`, { operator: '李四', request_id: 'T9-K2' });
  ok(sign.status === 200 && sign.data.handover.status === 'signed', '签收成功', sign);
  const signReplay = await post(`/api/performances/${perf}/handover/sign`, { operator: '李四', request_id: 'T9-K2' });
  ok(signReplay.status === 200 && signReplay.data.idempotent_replay === true && signReplay.data.handover.status === 'signed', '签收重送返回首次结果（不报重复签收）', signReplay);

  const state = await get(`/api/performances/${perf}`);
  ok(state.data.handover_history.length === 1, '交接单仅 1 张（重送未新增）', state.data.handover_history.length);
}

async function t10_continue() {
  section('T10 接续幂等；原演出只读后同编号重送仍返回首次结果');
  const perf = await newPerf();
  const c = await cueIds(perf);
  const fire = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T10-fire-L1' });
  const fireEventId = fire.data.event.id;

  const cont = await post(`/api/performances/${perf}/continue`, { version_id: V2, operator: '王监', name: '接续场', request_id: 'T10-K1' });
  ok(cont.status === 200 && cont.data.performance && cont.data.performance.status === 'active', '生成接续演出成功', cont);
  const newPerfId = cont.data.performance.id;

  const contReplay = await post(`/api/performances/${perf}/continue`, { version_id: V2, operator: '王监', name: '接续场', request_id: 'T10-K1' });
  ok(contReplay.status === 200 && contReplay.data.idempotent_replay === true && contReplay.data.performance.id === newPerfId, '接续重送返回同一接续演出（不重复生成）', contReplay);

  const show = await get(`/api/shows/${SHOW_ID}`);
  const count = show.data.performances.filter((p) => p.continued_from_performance_id === perf).length;
  ok(count === 1, '接续演出仅 1 场（重送未新增）', count);

  const src = await get(`/api/performances/${perf}`);
  ok(src.data.performance.status === 'readonly', '原演出已转只读', src.data.performance.status);

  const fireReplay = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T10-fire-L1' });
  ok(fireReplay.status === 200 && fireReplay.data.idempotent_replay === true && fireReplay.data.event.id === fireEventId, '原演出只读后，同编号同输入重送仍返回首次成功结果（不 409）', fireReplay);

  const newKey = await post(`/api/performances/${perf}/cues/${c.S1}/fire`, { operator: '张三', request_id: 'T10-K9' });
  ok(newKey.status === 409 && newKey.data.readonly === true, '只读演出上的新编号写操作仍按既有规则拒绝', newKey);
}

async function t11_closeout() {
  section('T11 封场幂等；封场后同编号重送仍返回首次结果');
  const perf = await newPerf();
  const c = await cueIds(perf);

  await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T11-K1' });
  await post(`/api/performances/${perf}/cues/${c.S1}/skip`, { operator: '李四', reason: '设备故障', request_id: 'T11-K2' });
  const req = await post(`/api/performances/${perf}/cues/${c.B2}/fire`, { operator: '张三', request_id: 'T11-K3' });
  await post(`/api/performances/${perf}/review-requests/${req.data.request.id}/confirm`, { operator: '李四', request_id: 'T11-K4' });
  const prep = await post(`/api/performances/${perf}/cues/${c.P1}/prep-commands`, { issued_by: '王监', request_id: 'T11-K5' });
  await post(`/api/performances/${perf}/prep-commands/${prep.data.command.id}/confirm`, { operator: '李四', request_id: 'T11-K6' });
  await post(`/api/performances/${perf}/cues/${c.P1}/fire`, { operator: '张三', request_id: 'T11-K7' });

  const close = await post(`/api/performances/${perf}/closeout`, { closed_by: '王监', note: '全场结束', request_id: 'T11-K8' });
  ok(close.status === 200 && close.data.closing && close.data.performance.status === 'closed', '封场成功并生成报告', close.status);
  const closingId = close.data.closing.id;

  const closeReplay = await post(`/api/performances/${perf}/closeout`, { closed_by: '王监', note: '全场结束', request_id: 'T11-K8' });
  ok(closeReplay.status === 200 && closeReplay.data.idempotent_replay === true && closeReplay.data.closing.id === closingId, '封场重送返回首次报告（不重复封场、不 409）', closeReplay);

  const fireReplay = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T11-K1' });
  ok(fireReplay.status === 200 && fireReplay.data.idempotent_replay === true, '封场后同编号重送仍返回首次结果', fireReplay);

  const newKey = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T11-K99' });
  ok(newKey.status === 409 && newKey.data.closed === true, '封场后新编号写操作仍按既有规则 409', newKey);

  const report = await get(`/api/performances/${perf}/closeout`);
  ok(report.status === 200 && report.data.closing.id === closingId, '封场报告可回看且仅 1 份', report.status);
}

async function t12_concurrent() {
  section('T12 并发重送：同一编号并发提交只能执行一次');
  const perf = await newPerf();
  const c = await cueIds(perf);

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'T12-K1' })
    )
  );
  ok(results.every((r) => r.status === 200), '并发重送全部返回 200', results.map((r) => r.status));
  const firsts = results.filter((r) => !r.data.idempotent_replay);
  ok(firsts.length === 1, '恰好 1 次为首次执行，其余为重放', firsts.length);
  const ids = new Set(results.map((r) => r.data.event && r.data.event.id));
  ok(ids.size === 1, '全部返回同一条流水', [...ids]);
  const events = await eventsOf(perf);
  ok(events.length === 1, '并发重送只提交一次（流水仅 1 条）', events.length);
}

async function t13_misc() {
  section('T13 编号格式 / 请求头 / 兼容性');
  const perf = await newPerf();
  const c = await cueIds(perf);

  const empty = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: '' });
  ok(empty.status === 400, '空编号 → 400（不占号）', empty.status);
  const tooLong = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三', request_id: 'x'.repeat(101) });
  ok(tooLong.status === 400, '超长编号 → 400', tooLong.status);

  const header1 = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三' }, { 'Idempotency-Key': 'T13-H1' });
  ok(header1.status === 200, 'Idempotency-Key 请求头首次成功', header1.status);
  const header2 = await post(`/api/performances/${perf}/cues/${c.L1}/fire`, { operator: '张三' }, { 'Idempotency-Key': 'T13-H1' });
  ok(header2.status === 200 && header2.data.idempotent_replay === true, '请求头编号重送去重', header2.status);

  const notFound = await post('/api/performances/999999/cues/1/fire', { operator: '张三', request_id: 'T13-K404' });
  ok(notFound.status === 404, '演出不存在 → 404（不占号）', notFound.status);

  const ignored = await post('/api/shows', { name: '不受影响的场次', request_id: 'T13-IGNORED' });
  ok(ignored.status === 200 && ignored.data.show && ignored.data.idempotent_replay === undefined, '非演出写操作忽略编号、行为不变', ignored.status);

  const getWithKey = await call('GET', `/api/performances/${perf}`, undefined, { 'Idempotency-Key': 'T13-GET' });
  ok(getWithKey.status === 200 && getWithKey.data.performance, '只读接口不受编号影响', getWithKey.status);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch (_) { /* ignore */ }
  }
  startServer();
  await waitReady();
  console.log(`服务已启动：${BASE}（临时库 ${DB_PATH}）`);

  await setupShow();
  await t1_fireReplay();
  await t2_conflict();
  await t3_failureNotOccupied();
  await t4_skipRetract();
  await t5_review();
  await t6_prep();
  await t7_fault();
  await t8_batch();
  await t9_handover();
  await t10_continue();
  await t11_closeout();
  await t12_concurrent();
  await t13_misc();

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  stopServer();
  process.exit(failed ? 1 : 0);
}

process.on('SIGINT', () => { stopServer(); process.exit(130); });

main().catch((err) => {
  console.error('测试执行异常：', err);
  stopServer();
  process.exit(1);
});
