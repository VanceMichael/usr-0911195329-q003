// HTTP 接口。createServer(service) 便于测试注入；文件直接运行时加载 JSONL 并监听。
import http from "node:http";
import { EventStore } from "./event-store.js";
import { Service } from "./service.js";
import { DomainError, normalizeRole } from "./domain.js";

export const healthPayload = () => ({ service: "fuel-impact", status: "ok" });

const STATUS_BY_CODE = {
  invalid_request: 400,
  effective_range_conflict: 409,
  snapshot_sealed: 409,
  snapshot_not_found: 404,
  contract_not_found: 404,
  no_effective_quote: 422,
  currency_mismatch: 422,
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new DomainError("invalid_request", "请求体过大（上限 1MiB）");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new DomainError("invalid_request", "请求体不是合法 JSON");
  }
}

function queryParams(url) {
  const out = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

export function createServer(service) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const role = normalizeRole(req.headers["x-role"]);
    const p = url.pathname;
    try {
      // 健康检查
      if (req.method === "GET" && p === "/health") return send(res, 200, healthPayload());

      // 快照版本
      if (p === "/v1/snapshots" && req.method === "POST") {
        const { snapshot } = await service.createSnapshot(await readJson(req));
        return send(res, 201, { snapshot });
      }
      if (p === "/v1/snapshots" && req.method === "GET") {
        return send(res, 200, { snapshots: service.listSnapshots() });
      }
      if (p === "/v1/snapshots/seal" && req.method === "POST") {
        const { snapshot } = await service.sealSnapshot(await readJson(req));
        return send(res, 200, { snapshot });
      }

      // 报价
      if (p === "/v1/quotes" && req.method === "POST") {
        const { quote } = await service.registerQuote(await readJson(req));
        return send(res, 201, { quote });
      }
      if (p === "/v1/quotes" && req.method === "GET") {
        const q = queryParams(url);
        return send(res, 200, { quotes: service.listQuotes(q.snapshotId) });
      }

      // 合同（读取按 x-role 裁剪敏感字段）
      if (p === "/v1/contracts" && req.method === "POST") {
        // 仅 admin/planner 可登记合同
        if (role !== "admin" && role !== "planner") {
          throw new DomainError("forbidden", "仅 admin/planner 可登记合同", { role });
        }
        const { contract } = await service.registerContract(await readJson(req));
        return send(res, 201, { contract: service.getContract(contract.id, role) });
      }
      if (p === "/v1/contracts" && req.method === "GET") {
        return send(res, 200, { contracts: service.listContracts(role) });
      }
      let m;
      if ((m = p.match(/^\/v1\/contracts\/([^/]+)$/)) && req.method === "GET") {
        const contract = service.getContract(m[1], role);
        if (!contract) throw new DomainError("contract_not_found", "合同不存在", { contractId: m[1] });
        return send(res, 200, { contract });
      }

      // 测算
      if (p === "/v1/calculations" && req.method === "POST") {
        const out = await service.issueCalculation(await readJson(req));
        return send(res, out.replayed ? 200 : 201, {
          calculation: service.getCalculation(out.calculation.id, role),
          replayed: out.replayed,
        });
      }
      if ((m = p.match(/^\/v1\/calculations\/([^/]+)$/)) && req.method === "GET") {
        const calculation = service.getCalculation(m[1], role);
        if (!calculation) throw new DomainError("calculation_not_found", "测算不存在", { calculationId: m[1] });
        return send(res, 200, { calculation });
      }

      // 车队差异：GET /v1/fleets/:fleetId/diff?from&to&baseSnapshotId&compareSnapshotId
      if ((m = p.match(/^\/v1\/fleets\/([^/]+)\/diff$/)) && req.method === "GET") {
        const q = queryParams(url);
        const result = service.queryFleet({ fleetId: m[1], ...q }, role);
        return send(res, 200, result);
      }

      send(res, 404, { error: { code: "not_found", message: `无此路由: ${req.method} ${p}` } });
    } catch (err) {
      if (err instanceof DomainError) {
        const status = STATUS_BY_CODE[err.code] ?? (err.code === "forbidden" ? 403 : 400);
        return send(res, status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      send(res, 500, { error: { code: "internal_error", message: "服务内部错误" } });
      // 服务端日志保留原始错误
      console.error(err);
    }
  });
}

async function main() {
  const filePath = process.env.EVENT_LOG_PATH || "data/events.jsonl";
  const store = new EventStore(filePath);
  await store.load();
  const service = new Service(store);
  const server = createServer(service);
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
    console.log(`fuel-impact listening on ${process.env.PORT ?? 8080}, event log: ${filePath}`);
  });
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
