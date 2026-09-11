import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const {
  createState,
  createSnapshot,
  registerQuote,
  registerContract,
  issueCalculation,
  sealSnapshot,
  queryFleet,
  redactContract,
  redactCalculation,
  DomainError,
} = await import("../src/domain.js");
const { EventStore } = await import("../src/event-store.js");
const { Service } = await import("../src/service.js");

// 固定时钟，便于断言 issuedAt / 跨午夜
let now = "2026-09-10T00:00:00.000Z";
const clock = () => now;
const tick = (iso) => {
  now = iso;
};

function bootStore(file) {
  const store = new EventStore(file, { clock });
  return store.load().then(() => [store, new Service(store)]);
}

test("跨午夜窗口：半开区间相邻报价在边界日切换，重叠被拒绝且原因可解释", async () => {
  const state = createState();
  createSnapshot(state, {}, { at: now });
  const meta = { at: now };

  // [09-01, 09-10) 与 [09-10, 09-20) 在午夜 09-10 00:00 相接
  registerQuote(
    state,
    { route: "BJ-SH", fuelType: "diesel", source: "中石化挂牌", price: 7.2, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-10" },
    meta,
  );
  registerQuote(
    state,
    { route: "BJ-SH", fuelType: "diesel", source: "中石油站价", price: 7.6, effectiveFrom: "2026-09-10", effectiveTo: "2026-09-20" },
    meta,
  );
  // 开放区间紧随其后也允许
  registerQuote(
    state,
    { route: "BJ-SH", fuelType: "diesel", source: "市场调研", price: 7.9, effectiveFrom: "2026-09-20" },
    meta,
  );

  const c = registerContract(state, { fleetId: "F1", route: "BJ-SH", mileageKm: 1200, unitFuelConsumption: 30 }, meta).contract;

  // 边界前一天用旧价
  const before = issueCalculation(state, { snapshotId: state.snapshotOrder[0], contractId: c.id, date: "2026-09-09", idempotencyKey: "k-before" }, meta).calculation;
  assert.equal(before.result.fuelPrice, 7.2);
  assert.equal(before.result.fuelCost, Math.round(360 * 7.2 * 100) / 100);

  // 跨午夜当天 09-10 立即切到新价（半开 [from,to)）
  const onBoundary = issueCalculation(state, { snapshotId: c ? state.snapshotOrder[0] : null, contractId: c.id, date: "2026-09-10", idempotencyKey: "k-boundary" }, meta).calculation;
  assert.equal(onBoundary.result.fuelPrice, 7.6);
  assert.equal(onBoundary.input.quote.source, "中石油站价");

  // 开放区间
  const after = issueCalculation(state, { snapshotId: state.snapshotOrder[0], contractId: c.id, date: "2026-12-31", idempotencyKey: "k-after" }, meta).calculation;
  assert.equal(after.result.fuelPrice, 7.9);

  // 重叠区间必须被拒绝，原因里给出冲突来源与区间
  assert.throws(
    () =>
      registerQuote(
        state,
        { route: "BJ-SH", fuelType: "diesel", source: "黄牛", price: 6.0, effectiveFrom: "2026-09-09", effectiveTo: "2026-09-11" },
        meta,
      ),
    (err) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "effective_range_conflict");
      assert.equal(err.details.conflicts.length, 2);
      assert.deepEqual(
        err.details.conflicts.map((x) => x.source).sort(),
        ["中石化挂牌", "中石油站价"],
      );
      assert.equal(err.details.requested.effectiveFrom, "2026-09-09");
      return true;
    },
  );

  // 不同油品互不冲突
  assert.doesNotThrow(() =>
    registerQuote(
      state,
      { route: "BJ-SH", fuelType: "lng", source: "气价指数", price: 5.1, effectiveFrom: "2026-09-01", effectiveTo: "2026-09-11" },
      meta,
    ),
  );

  // 无生效报价 -> 可解释拒绝
  assert.throws(
    () => issueCalculation(state, { snapshotId: state.snapshotOrder[0], contractId: c.id, date: "2026-08-31", idempotencyKey: "k-gap" }, meta),
    (e) => e.code === "no_effective_quote",
  );
});

test("重复测算幂等：同 idempotencyKey 返回首次结果，即使请求参数被篡改", () => {
  const state = createState();
  const meta = { at: now };
  createSnapshot(state, {}, meta);
  registerQuote(state, { route: "R", source: "s1", price: 7.0, effectiveFrom: "2026-09-01" }, meta);
  const c = registerContract(state, { fleetId: "F", route: "R", mileageKm: 100, unitFuelConsumption: 25 }, meta).contract;
  const sid = state.snapshotOrder[0];

  const first = issueCalculation(state, { snapshotId: sid, contractId: c.id, date: "2026-09-05", idempotencyKey: "idem-1" }, meta);
  assert.equal(first.replayed, false);
  const firstCost = first.calculation.result.fuelCost;

  // 同 key、换日期/换快照意图：回放原记录
  const again = issueCalculation(state, { snapshotId: sid, contractId: c.id, date: "2026-09-06", idempotencyKey: "idem-1" }, meta);
  assert.equal(again.replayed, true);
  assert.equal(again.calculation.id, first.calculation.id);
  assert.equal(again.calculation.date, "2026-09-05");
  assert.equal(again.calculation.result.fuelCost, firstCost);
});

test("历史结果冻结：新版本调价后，已出具测算的金额与单价不变", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fuel-")), "events.jsonl");
  const [store, svc] = await bootStore(file);

  const sid1 = (await svc.createSnapshot({})).snapshot.id;
  await svc.registerQuote({ route: "R", source: "旧来源", price: 7.0, effectiveFrom: "2026-09-01" });
  const c = (await svc.registerContract({ fleetId: "F", route: "R", mileageKm: 100, unitFuelConsumption: 30 })).contract;

  tick("2026-09-10T08:00:00.000Z");
  const calc = (await svc.issueCalculation({ snapshotId: sid1, contractId: c.id, date: "2026-09-05", idempotencyKey: "freeze-1" })).calculation;
  assert.equal(calc.result.fuelCost, 210); // 30L * 7.0

  // 调价窗口：开出新版本（v1 自动封存），登记新价 8.1
  tick("2026-09-15T00:00:00.000Z");
  const sid2 = (await svc.createSnapshot({})).snapshot.id;
  assert.notEqual(sid2, sid1);
  assert.equal(svc.getSnapshot(sid1).status, "sealed");
  assert.equal(svc.getSnapshot(sid2).status, "draft");
  await svc.registerQuote({ snapshotId: sid2, route: "R", source: "新来源", price: 8.1, effectiveFrom: "2026-09-01" });

  // 封存版本拒绝再登记报价
  assert.rejects(
    () => svc.registerQuote({ snapshotId: sid1, route: "R", source: "x", price: 9, effectiveFrom: "2026-09-01" }),
    (e) => e.code === "snapshot_sealed",
  );

  // 同 key 回放：金额依然是 210，而不是 243
  const replay = (await svc.issueCalculation({ snapshotId: sid2, contractId: c.id, date: "2026-09-05", idempotencyKey: "freeze-1" })).calculation;
  assert.equal(replay.result.fuelCost, 210);
  assert.equal(replay.result.fuelPrice, 7.0);
  assert.equal(replay.snapshotId, sid1);
  assert.equal(replay.input.quote.source, "旧来源");

  // 按 id 取历史记录也保持冻结
  const fetched = svc.getCalculation(calc.id, "admin");
  assert.equal(fetched.result.fuelCost, 210);
  assert.equal(fetched.status, "final");

  // 用新版本重新测算（新 key）得到新价
  const calc2 = (await svc.issueCalculation({ snapshotId: sid2, contractId: c.id, date: "2026-09-05", idempotencyKey: "freeze-2" })).calculation;
  assert.equal(calc2.result.fuelCost, Math.round(30 * 8.1 * 100) / 100);
});

test("JSONL 重启恢复：新进程重放日志后版本/合同/冻结测算全部一致", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-"));
  const file = path.join(dir, "events.jsonl");

  let issuedId, issuedCost, contractId;
  {
    const [store, svc] = await bootStore(file);
    const sid = (await svc.createSnapshot({})).snapshot.id;
    await svc.registerQuote({ route: "R", source: "s", price: 7.3, effectiveFrom: "2026-09-01" });
    contractId = (await svc.registerContract({ fleetId: "F", route: "R", mileageKm: 200, unitFuelConsumption: 20 })).contract.id;
    tick("2026-09-11T01:23:45.000Z");
    const out = await svc.issueCalculation({ snapshotId: sid, contractId, date: "2026-09-03", idempotencyKey: "persist-1" });
    issuedId = out.calculation.id;
    issuedCost = out.calculation.result.fuelCost;
  }

  // 模拟重启：全新 EventStore 从同一文件加载
  const [store2, svc2] = await bootStore(file);
  assert.equal(svc2.listSnapshots().length, 1);
  assert.equal(svc2.listQuotes().length, 1);
  assert.equal(svc2.listContracts("admin").length, 1);
  const got = svc2.getCalculation(issuedId, "admin");
  assert.equal(got.result.fuelCost, issuedCost);
  assert.equal(got.issuedAt, "2026-09-11T01:23:45.000Z");

  // 幂等映射也恢复：同 key 不产生第二条
  const sid = svc2.listSnapshots()[0].id;
  const replay = await svc2.issueCalculation({ snapshotId: sid, contractId, date: "2026-09-03", idempotencyKey: "persist-1" });
  assert.equal(replay.replayed, true);
  assert.equal(store2.state.calculations.size, 1);

  // 末行崩溃截断：半条 JSON 被丢弃，服务仍可加载并继续追加
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.trimEnd().split("\n");
  fs.writeFileSync(file, lines.join("\n") + '\n{"type":"calculation_issued", seq:');
  const [store3] = await bootStore(file);
  assert.equal(store3.state.calculations.size, 1);
});

test("按车队与日期范围查询并输出两个快照版本的差异", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fuel-")), "e.jsonl");
  const [, svc] = await bootStore(file);

  const sid1 = (await svc.createSnapshot({})).snapshot.id;
  await svc.registerQuote({ route: "R", source: "a", price: 7.0, effectiveFrom: "2026-09-01" });
  const c = (await svc.registerContract({ fleetId: "FLEET-A", route: "R", mileageKm: 100, unitFuelConsumption: 30 })).contract;
  await svc.issueCalculation({ snapshotId: sid1, contractId: c.id, date: "2026-09-02", idempotencyKey: "d1" });
  await svc.issueCalculation({ snapshotId: sid1, contractId: c.id, date: "2026-09-03", idempotencyKey: "d2" });

  const sid2 = (await svc.createSnapshot({})).snapshot.id;
  await svc.registerQuote({ snapshotId: sid2, route: "R", source: "b", price: 8.0, effectiveFrom: "2026-09-01" });
  await svc.issueCalculation({ snapshotId: sid2, contractId: c.id, date: "2026-09-02", idempotencyKey: "d3" });
  await svc.issueCalculation({ snapshotId: sid2, contractId: c.id, date: "2026-09-03", idempotencyKey: "d4" });

  // 只看 09-03
  const res = svc.queryFleet({ fleetId: "FLEET-A", from: "2026-09-03", to: "2026-09-03", baseSnapshotId: sid1, compareSnapshotId: sid2 }, "admin");
  assert.equal(res.count, 2);
  assert.equal(res.diff.baseTotalFuelCost, 210);
  assert.equal(res.diff.compareTotalFuelCost, 240);
  assert.equal(res.diff.deltaFuelCost, 30);
  assert.equal(res.diff.perDate[0].deltaFuelCost, 30);

  // 日期范围外为空
  const empty = svc.queryFleet({ fleetId: "FLEET-A", from: "2027-01-01", to: "2027-02-01" }, "admin");
  assert.equal(empty.count, 0);

  // 别的车队查不到
  assert.equal(svc.queryFleet({ fleetId: "GONE" }, "admin").count, 0);
});

test("敏感合同字段按角色裁剪", () => {
  const state = createState();
  const meta = { at: now };
  createSnapshot(state, {}, meta);
  const c = registerContract(state, { fleetId: "F", route: "R", mileageKm: 100, unitFuelConsumption: 30, currency: "CNY", annualVolume: 5000 }, meta).contract;

  const admin = redactContract(c, "admin");
  assert.equal(admin.unitFuelConsumption, 30);
  assert.equal(admin.annualVolume, 5000);
  assert.equal(admin.currency, "CNY");

  for (const role of ["auditor", "viewer", null]) {
    const view = redactContract(c, role);
    assert.equal(view.unitFuelConsumption, "***", role ?? "null");
    assert.equal(view.annualVolume, "***");
    assert.equal(view.currency, "***");
    assert.equal(view.mileageKm, 100); // 非敏感字段保留
    assert.ok(view._redacted.includes("unitFuelConsumption"));
  }

  // 测算记录里冻结的合同段同样裁剪，金额结果保留
  registerQuote(state, { route: "R", source: "s", price: 7, effectiveFrom: "2026-09-01" }, meta);
  const calc = issueCalculation(state, { snapshotId: state.snapshotOrder[0], contractId: c.id, date: "2026-09-02", idempotencyKey: "role-1" }, meta).calculation;
  const viewerCalc = redactCalculation(calc, "viewer");
  assert.equal(viewerCalc.input.contract.unitFuelConsumption, "***");
  assert.equal(viewerCalc.result.fuelCost, 210);
});

test("币种不一致被拒绝；测算必须指定快照版本", () => {
  const state = createState();
  const meta = { at: now };
  createSnapshot(state, {}, meta);
  registerQuote(state, { route: "R", source: "s", price: 1, currency: "USD", effectiveFrom: "2026-09-01" }, meta);
  const c = registerContract(state, { fleetId: "F", route: "R", currency: "CNY", mileageKm: 100, unitFuelConsumption: 30 }, meta).contract;
  assert.throws(
    () => issueCalculation(state, { snapshotId: state.snapshotOrder[0], contractId: c.id, date: "2026-09-02", idempotencyKey: "x1" }, meta),
    (e) => e.code === "currency_mismatch",
  );
  assert.throws(
    () => issueCalculation(state, { contractId: c.id, date: "2026-09-02", idempotencyKey: "x2" }, meta),
    (e) => e.code === "invalid_request" && /snapshotId/.test(e.message),
  );
});
