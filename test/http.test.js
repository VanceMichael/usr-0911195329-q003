import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const { createServer, healthPayload } = await import("../src/server.js");
const { EventStore } = await import("../src/event-store.js");
const { Service } = await import("../src/service.js");

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-http-"));
  const store = new EventStore(path.join(dir, "events.jsonl"), { clock: () => "2026-09-11T09:00:00.000Z" });
  await store.load();
  const server = createServer(new Service(store));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function req(base, method, url, body, role = "planner") {
  const init = { method, headers: { "content-type": "application/json", "x-role": role } };
  if (body !== undefined && method !== "GET" && method !== "HEAD") init.body = JSON.stringify(body);
  const res = await fetch(base + url, init);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test("health 与端到端 HTTP 流程：登记/冲突拒绝/测算/幂等/差异/角色裁剪", async () => {
  const { base, stop } = await startServer();
  try {
    assert.equal(healthPayload().status, "ok");
    const h = await fetch(base + "/health");
    assert.equal(h.status, 200);
    assert.equal((await h.json()).status, "ok");

    // v1 快照 + 两段跨午夜相接报价
    const { json: s1 } = await req(base, "POST", "/v1/snapshots", {});
    const sid1 = s1.snapshot.id;
    assert.equal((await req(base, "POST", "/v1/quotes", {
      snapshotId: sid1, route: "BJ-SH", source: "中石化", price: 7.2,
      effectiveFrom: "2026-09-01", effectiveTo: "2026-09-10",
    })).status, 201);
    assert.equal((await req(base, "POST", "/v1/quotes", {
      snapshotId: sid1, route: "BJ-SH", source: "中石油", price: 7.6,
      effectiveFrom: "2026-09-10",
    })).status, 201);

    // 重叠 -> 409 + 可解释原因
    const conflict = await req(base, "POST", "/v1/quotes", {
      snapshotId: sid1, route: "BJ-SH", source: "第三方", price: 6.9,
      effectiveFrom: "2026-09-05", effectiveTo: "2026-09-12",
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "effective_range_conflict");
    assert.equal(conflict.json.error.details.conflicts.length, 2);

    // 合同
    const c = await req(base, "POST", "/v1/contracts", {
      fleetId: "F1", route: "BJ-SH", vehicleType: "重卡", mileageKm: 1200,
      unitFuelConsumption: 30, currency: "CNY", annualVolume: 8000,
    });
    assert.equal(c.status, 201);
    const contractId = c.json.contract.id;

    // viewer 不能登记合同 -> 403
    assert.equal((await req(base, "POST", "/v1/contracts", { fleetId: "X", route: "Y", mileageKm: 1, unitFuelConsumption: 1 }, "viewer")).status, 403);

    // 测算必须指定快照
    const noSnap = await req(base, "POST", "/v1/calculations", { contractId, date: "2026-09-05", idempotencyKey: "k0" });
    assert.equal(noSnap.status, 400);

    // 首次测算
    const calc1 = await req(base, "POST", "/v1/calculations", { snapshotId: sid1, contractId, date: "2026-09-05", idempotencyKey: "k1" });
    assert.equal(calc1.status, 201);
    assert.equal(calc1.json.replayed, false);
    const calcId = calc1.json.calculation.id;
    assert.equal(calc1.json.calculation.result.fuelCost, 2592); // 360L * 7.2

    // 重复测算幂等：同 key 返回 200 + replayed
    const calc1again = await req(base, "POST", "/v1/calculations", { snapshotId: sid1, contractId, date: "2026-09-08", idempotencyKey: "k1" });
    assert.equal(calc1again.status, 200);
    assert.equal(calc1again.json.replayed, true);
    assert.equal(calc1again.json.calculation.id, calcId);
    assert.equal(calc1again.json.calculation.date, "2026-09-05");
    assert.equal(calc1again.json.calculation.result.fuelCost, 2592);

    // 跨午夜当天取新价
    const calc2 = await req(base, "POST", "/v1/calculations", { snapshotId: sid1, contractId, date: "2026-09-10", idempotencyKey: "k2" });
    assert.equal(calc2.json.calculation.result.fuelPrice, 7.6);

    // 调价：开出 v2（v1 自动封存），新价
    const { json: s2 } = await req(base, "POST", "/v1/snapshots", {});
    const sid2 = s2.snapshot.id;
    const sealed = await req(base, "GET", "/v1/snapshots", {});
    assert.equal(sealed.json.snapshots.find((x) => x.id === sid1).status, "sealed");
    await req(base, "POST", "/v1/quotes", { snapshotId: sid2, route: "BJ-SH", source: "新价", price: 8.1, effectiveFrom: "2026-09-01" });

    // 历史结果冻结：读旧测算仍是 2592
    const old = await req(base, "GET", `/v1/calculations/${calcId}`, {});
    assert.equal(old.json.calculation.result.fuelCost, 2592);
    assert.equal(old.json.calculation.input.quote.price, 7.2);

    // v2 下重新测算
    await req(base, "POST", "/v1/calculations", { snapshotId: sid2, contractId, date: "2026-09-05", idempotencyKey: "k3" });

    // 车队差异
    const diff = await req(base, "GET", `/v1/fleets/F1/diff?from=2026-09-01&to=2026-09-30&baseSnapshotId=${sid1}&compareSnapshotId=${sid2}`, undefined, "admin");
    assert.equal(diff.status, 200);
    assert.equal(diff.json.diff.baseTotalFuelCost, 2592 + 2736); // k1 + k2（k1 回放不重复）
    assert.equal(diff.json.diff.compareTotalFuelCost, 2916); // 360 * 8.1
    assert.equal(diff.json.diff.deltaFuelCost, 2916 - (2592 + 2736));

    // 角色裁剪：viewer 看合同敏感字段为掩码
    const viewer = await req(base, "GET", `/v1/contracts/${contractId}`, undefined, "viewer");
    assert.equal(viewer.json.contract.unitFuelConsumption, "***");
    assert.equal(viewer.json.contract.annualVolume, "***");
    assert.equal(viewer.json.contract.mileageKm, 1200);

    // planner 可见明文
    const planner = await req(base, "GET", `/v1/contracts/${contractId}`, undefined, "planner");
    assert.equal(planner.json.contract.unitFuelConsumption, 30);

    // 404
    assert.equal((await fetch(base + "/v1/nope")).status, 404);
  } finally {
    await stop();
  }
});
