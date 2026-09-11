// 纯领域逻辑：版本化价格快照、报价区间冲突检测、合同、燃油成本测算、车队差异、角色裁剪。
// 不接触磁盘与 HTTP，所有状态由事件重放得到（见 event-store.js）。

export const ROLES = ["admin", "planner", "auditor", "viewer"];

// 敏感字段（仅 admin/planner 可见明文）；auditor/viewer 看到掩码
const SENSITIVE_CONTRACT_FIELDS = ["unitFuelConsumption", "currency", "annualVolume"];
const FULL_FIELDS_ROLES = new Set(["admin", "planner"]);

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function assertDate(value, field) {
  if (!isNonEmptyString(value) || !ISO_DATE.test(value)) {
    throw new DomainError("invalid_request", `${field} 必须是 YYYY-MM-DD 日期`, { field });
  }
  // 拒绝 2026-02-30 之类的伪日期
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new DomainError("invalid_request", `${field} 不是有效日期`, { field, value });
  }
  return value;
}

function positiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DomainError("invalid_request", `${field} 必须是正数`, { field });
  }
  return value;
}

// 区间统一为半开 [from, to)；to 为 null 表示开放区间。
function overlap(aFrom, aTo, bFrom, bTo) {
  if (aFrom >= (bTo ?? "9999-12-31")) return false;
  if (bFrom >= (aTo ?? "9999-12-31")) return false;
  return true;
}

function round6(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function createState() {
  return {
    snapshots: new Map(), // id -> {id, baseSnapshotId, status, createdAt, sealedAt, quoteIds}
    snapshotOrder: [],
    quotes: new Map(), // id -> quote
    contracts: new Map(), // id -> contract
    calculations: new Map(), // id -> calculation record（冻结）
    idempotency: new Map(), // key -> calcId
    sequence: 0,
  };
}

function latestSnapshot(state) {
  for (let i = state.snapshotOrder.length - 1; i >= 0; i--) {
    const snap = state.snapshots.get(state.snapshotOrder[i]);
    if (snap.status === "draft") return snap;
  }
  return null;
}

function nextId(state, prefix) {
  state.sequence += 1;
  return `${prefix}_${String(state.sequence).padStart(6, "0")}`;
}

// ---------- 事件应用（重放与实时共用，禁止在此做校验外的分支） ----------

export function applyEvent(state, event) {
  switch (event.type) {
    case "snapshot_created": {
      // 新版本一旦开出，前一草稿版本自动封存：调价只能在新版本上进行，历史版本不可变。
      if (state.snapshotOrder.length > 0) {
        const prev = state.snapshots.get(state.snapshotOrder[state.snapshotOrder.length - 1]);
        if (prev && prev.status === "draft") {
          prev.status = "sealed";
          prev.sealedAt = event.at;
        }
      }
      state.snapshots.set(event.snapshotId, {
        id: event.snapshotId,
        baseSnapshotId: event.baseSnapshotId,
        status: "draft",
        createdAt: event.at,
        sealedAt: null,
        quoteIds: [],
      });
      state.snapshotOrder.push(event.snapshotId);
      state.sequence = Math.max(state.sequence, event.seq);
      break;
    }
    case "snapshot_sealed": {
      const snap = state.snapshots.get(event.snapshotId);
      if (snap) {
        snap.status = "sealed";
        snap.sealedAt = event.at;
      }
      break;
    }
    case "quote_registered": {
      const q = { ...event.quote };
      state.quotes.set(q.id, q);
      const snap = state.snapshots.get(q.snapshotId);
      if (snap) snap.quoteIds.push(q.id);
      state.sequence = Math.max(state.sequence, event.seq);
      break;
    }
    case "contract_registered": {
      state.contracts.set(event.contract.id, { ...event.contract });
      state.sequence = Math.max(state.sequence, event.seq);
      break;
    }
    case "calculation_issued": {
      state.calculations.set(event.calculation.id, { ...event.calculation });
      state.idempotency.set(event.calculation.idempotencyKey, event.calculation.id);
      state.sequence = Math.max(state.sequence, event.seq);
      break;
    }
    default:
      // 未知事件跳过，保证向前兼容
      break;
  }
  return state;
}

// ---------- 命令 ----------

export function createSnapshot(state, cmd = {}, eventMeta = {}) {
  const base = latestSnapshot(state);
  const baseId = base ? base.id : null;
  const event = {
    type: "snapshot_created",
    seq: state.sequence + 1,
    at: eventMeta.at,
    snapshotId: nextId(state, "snap"),
    baseSnapshotId: baseId,
  };
  applyEvent(state, event);
  return { event, snapshot: state.snapshots.get(event.snapshotId) };
}

// 封存后不可再登记报价，已出具测算继续可查。
export function sealSnapshot(state, cmd, eventMeta = {}) {
  const id = cmd?.snapshotId;
  const snap = id ? state.snapshots.get(id) : latestSnapshot(state);
  if (!snap) throw new DomainError("snapshot_not_found", "快照不存在", { snapshotId: id });
  if (snap.status === "sealed") {
    throw new DomainError("snapshot_sealed", "快照已封存", { snapshotId: snap.id });
  }
  const event = { type: "snapshot_sealed", seq: state.sequence + 1, at: eventMeta.at, snapshotId: snap.id };
  applyEvent(state, event);
  return { event, snapshot: state.snapshots.get(snap.id) };
}

export function registerQuote(state, cmd, eventMeta = {}) {
  const snapshotId = cmd?.snapshotId ?? latestSnapshot(state)?.id;
  const snap = snapshotId ? state.snapshots.get(snapshotId) : null;
  if (!snap) throw new DomainError("snapshot_not_found", "快照不存在，请先创建快照", { snapshotId });
  if (snap.status === "sealed") {
    throw new DomainError("snapshot_sealed", "快照已封存，不能再登记报价", { snapshotId: snap.id });
  }

  const route = cmd.route;
  if (!isNonEmptyString(route)) throw new DomainError("invalid_request", "route 必填");
  const fuelType = cmd.fuelType ?? "diesel";
  if (!isNonEmptyString(fuelType)) throw new DomainError("invalid_request", "fuelType 不能为空");
  const source = cmd.source;
  if (!isNonEmptyString(source)) throw new DomainError("invalid_request", "source 报价来源必填");
  const price = positiveNumber(cmd.price, "price");
  const currency = isNonEmptyString(cmd.currency) ? cmd.currency.trim() : "CNY";
  const from = assertDate(cmd.effectiveFrom, "effectiveFrom");
  let to = cmd.effectiveTo ?? null;
  if (to !== null) {
    to = assertDate(to, "effectiveTo");
    if (to <= from) {
      throw new DomainError("invalid_request", "effectiveTo 必须晚于 effectiveFrom（区间为半开 [from,to)）", {
        effectiveFrom: from,
        effectiveTo: to,
      });
    }
  }

  // 同快照、同线路、同油品下区间不得重叠；相邻区间 [a,b)+[b,c) 允许（跨午夜窗口）。
  const conflicts = [];
  for (const qid of snap.quoteIds) {
    const q = state.quotes.get(qid);
    if (q.route !== route || q.fuelType !== fuelType) continue;
    if (overlap(from, to, q.effectiveFrom, q.effectiveTo)) {
      conflicts.push({
        quoteId: q.id,
        source: q.source,
        effectiveFrom: q.effectiveFrom,
        effectiveTo: q.effectiveTo,
      });
    }
  }
  if (conflicts.length > 0) {
    throw new DomainError(
      "effective_range_conflict",
      `线路 ${route} 的报价生效区间与已登记报价重叠（同一快照、同一油品只允许相邻区间）`,
      { snapshotId: snap.id, route, fuelType, requested: { effectiveFrom: from, effectiveTo: to }, conflicts },
    );
  }

  const quote = {
    id: nextId(state, "quote"),
    snapshotId: snap.id,
    route,
    fuelType,
    price: round6(price),
    currency,
    unit: cmd.unit ?? "L",
    source: source.trim(),
    sourceRef: isNonEmptyString(cmd.sourceRef) ? cmd.sourceRef.trim() : null,
    effectiveFrom: from,
    effectiveTo: to,
    registeredAt: eventMeta.at,
  };
  const event = { type: "quote_registered", seq: state.sequence + 1, at: eventMeta.at, quote };
  applyEvent(state, event);
  return { event, quote };
}

export function registerContract(state, cmd, eventMeta = {}) {
  if (!isNonEmptyString(cmd?.fleetId)) throw new DomainError("invalid_request", "fleetId 必填");
  if (!isNonEmptyString(cmd.route)) throw new DomainError("invalid_request", "route 必填");
  const vehicleType = isNonEmptyString(cmd.vehicleType) ? cmd.vehicleType.trim() : "default";
  const mileageKm = positiveNumber(cmd.mileageKm, "mileageKm"); // 单程/结算周期里程
  const unitFuelConsumption = positiveNumber(cmd.unitFuelConsumption, "unitFuelConsumption"); // L/100km
  const currency = isNonEmptyString(cmd.currency) ? cmd.currency.trim() : "CNY";
  const fuelType = isNonEmptyString(cmd.fuelType) ? cmd.fuelType.trim() : "diesel";
  const annualVolume =
    cmd.annualVolume === undefined || cmd.annualVolume === null
      ? null
      : positiveNumber(cmd.annualVolume, "annualVolume");

  const contract = {
    id: nextId(state, "contract"),
    fleetId: cmd.fleetId.trim(),
    route: cmd.route.trim(),
    vehicleType,
    fuelType,
    mileageKm: round6(mileageKm),
    unitFuelConsumption: round6(unitFuelConsumption),
    currency,
    annualVolume,
    createdAt: eventMeta.at,
  };
  const event = { type: "contract_registered", seq: state.sequence + 1, at: eventMeta.at, contract };
  applyEvent(state, event);
  return { event, contract };
}

// 在指定日期取生效报价：from <= date < to（半开），to 为 null 视为长期有效。
export function effectiveQuoteAt(state, snapshotId, route, fuelType, date) {
  const snap = state.snapshots.get(snapshotId);
  if (!snap) throw new DomainError("snapshot_not_found", "快照不存在", { snapshotId });
  let found = null;
  for (const qid of snap.quoteIds) {
    const q = state.quotes.get(qid);
    if (q.route !== route || q.fuelType !== fuelType) continue;
    if (q.effectiveFrom <= date && (q.effectiveTo === null || date < q.effectiveTo)) {
      found = q;
      break;
    }
  }
  if (!found) {
    throw new DomainError("no_effective_quote", `快照 ${snapshotId} 中线路 ${route} 在 ${date} 无生效报价`, {
      snapshotId,
      route,
      fuelType,
      date,
    });
  }
  return found;
}

// 出具测算：结果连同所依据的合同与报价整体冻结；同 idempotencyKey 直接回放（幂等）。
export function issueCalculation(state, cmd, eventMeta = {}) {
  const idem = isNonEmptyString(cmd?.idempotencyKey) ? cmd.idempotencyKey.trim() : null;
  if (!idem) throw new DomainError("invalid_request", "idempotencyKey 必填，用于重复测算幂等");
  const existingId = state.idempotency.get(idem);
  if (existingId) {
    return { event: null, calculation: state.calculations.get(existingId), replayed: true };
  }

  const snapshotId = cmd.snapshotId;
  if (!isNonEmptyString(snapshotId)) throw new DomainError("invalid_request", "snapshotId 必填，测算必须指定快照版本");
  const snap = state.snapshots.get(snapshotId);
  if (!snap) throw new DomainError("snapshot_not_found", "快照不存在", { snapshotId });

  const contract = state.contracts.get(cmd.contractId);
  if (!contract) throw new DomainError("contract_not_found", "合同不存在", { contractId: cmd.contractId });

  const date = assertDate(cmd.date ?? eventMeta.at?.slice(0, 10), "date");

  // 重复测算即使请求体被改坏也返回首次结果；首次计算才校验币种一致性
  const quote = effectiveQuoteAt(state, snapshotId, contract.route, contract.fuelType, date);
  if (quote.currency !== contract.currency) {
    throw new DomainError("currency_mismatch", "报价币种与合同结算币种不一致", {
      contractCurrency: contract.currency,
      quoteCurrency: quote.currency,
    });
  }

  const fuelLiters = round6((contract.mileageKm * contract.unitFuelConsumption) / 100);
  const fuelCost = round2(fuelLiters * quote.price);

  const calculation = {
    id: nextId(state, "calc"),
    idempotencyKey: idem,
    snapshotId,
    contractId: contract.id,
    fleetId: contract.fleetId,
    date,
    status: "final",
    issuedAt: eventMeta.at,
    // ---- 冻结快照：后续调价/合同修订均不影响本记录 ----
    input: {
      contract: { ...contract },
      quote: { ...quote },
    },
    result: {
      mileageKm: contract.mileageKm,
      unitFuelConsumption: contract.unitFuelConsumption,
      fuelLiters,
      fuelPrice: quote.price,
      currency: contract.currency,
      fuelCost,
    },
  };

  const event = { type: "calculation_issued", seq: state.sequence + 1, at: eventMeta.at, calculation };
  applyEvent(state, event);
  return { event, calculation, replayed: false };
}

// 按车队 + 日期范围查询测算，可选基准/对比快照版本做差异。
export function queryFleet(state, cmd) {
  const fleetId = cmd?.fleetId;
  if (!isNonEmptyString(fleetId)) throw new DomainError("invalid_request", "fleetId 必填");
  const from = cmd.from ? assertDate(cmd.from, "from") : null;
  const to = cmd.to ? assertDate(cmd.to, "to") : null;
  if (from && to && to < from) throw new DomainError("invalid_request", "to 早于 from");

  const rows = [...state.calculations.values()]
    .filter((c) => c.fleetId === fleetId)
    .filter((c) => (from ? c.date >= from : true))
    .filter((c) => (to ? c.date <= to : true))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.issuedAt < b.issuedAt ? -1 : 1));

  let diff = null;
  if (isNonEmptyString(cmd.baseSnapshotId) || isNonEmptyString(cmd.compareSnapshotId)) {
    const baseId = cmd.baseSnapshotId;
    const compareId = cmd.compareSnapshotId;
    for (const id of [baseId, compareId]) {
      if (isNonEmptyString(id) && !state.snapshots.has(id)) {
        throw new DomainError("snapshot_not_found", "快照不存在", { snapshotId: id });
      }
    }
    const pick = (snapshotId) =>
      rows.filter((c) => c.snapshotId === snapshotId);
    const baseRows = pick(baseId);
    const compareRows = pick(compareId);
    const sum = (list) => round2(list.reduce((acc, c) => acc + c.result.fuelCost, 0));
    const baseTotal = sum(baseRows);
    const compareTotal = sum(compareRows);
    diff = {
      baseSnapshotId: baseId,
      compareSnapshotId: compareId,
      baseCount: baseRows.length,
      compareCount: compareRows.length,
      baseTotalFuelCost: baseTotal,
      compareTotalFuelCost: compareTotal,
      deltaFuelCost: round2(compareTotal - baseTotal),
      currency: baseRows[0]?.result.currency ?? compareRows[0]?.result.currency ?? null,
      perDate: buildPerDateDiff(baseRows, compareRows),
    };
  }

  return { fleetId, from, to, count: rows.length, calculations: rows, diff };
}

function buildPerDateDiff(baseRows, compareRows) {
  const dates = new Set();
  const keyOf = (r) => `${r.date}|${r.contractId}`;
  const baseMap = new Map(baseRows.map((r) => [keyOf(r), r]));
  const cmpMap = new Map(compareRows.map((r) => [keyOf(r), r]));
  for (const k of baseMap.keys()) dates.add(k);
  for (const k of cmpMap.keys()) dates.add(k);
  return [...dates].sort().map((k) => {
    const [date, contractId] = k.split("|");
    const b = baseMap.get(k);
    const c = cmpMap.get(k);
    return {
      date,
      contractId,
      baseFuelCost: b ? b.result.fuelCost : null,
      compareFuelCost: c ? c.result.fuelCost : null,
      deltaFuelCost: round2((c?.result.fuelCost ?? 0) - (b?.result.fuelCost ?? 0)),
      currency: b?.result.currency ?? c?.result.currency ?? null,
    };
  });
}

// ---------- 角色裁剪 ----------

export function normalizeRole(role) {
  const r = isNonEmptyString(role) ? role.trim().toLowerCase() : "viewer";
  return ROLES.includes(r) ? r : "viewer";
}

function maskNumber() {
  return "***";
}

export function redactContract(contract, role) {
  if (!contract) return contract;
  const r = normalizeRole(role);
  if (FULL_FIELDS_ROLES.has(r)) return { ...contract };
  const out = { ...contract };
  for (const f of SENSITIVE_CONTRACT_FIELDS) {
    if (out[f] !== undefined && out[f] !== null) out[f] = maskNumber();
  }
  out._redacted = SENSITIVE_CONTRACT_FIELDS;
  out._redactedForRole = r;
  return out;
}

// 测算记录按同一规则裁剪冻结输入中的合同段；金额结果对所有角色保留（业务需要）。
export function redactCalculation(calc, role) {
  if (!calc) return calc;
  const r = normalizeRole(role);
  const out = { ...calc, input: { ...calc.input } };
  out.input.contract = redactContract(calc.input.contract, r);
  if (!FULL_FIELDS_ROLES.has(r)) {
    // viewer 不暴露合同列表里的来源明细以外的额外信息；quote 来源属价格数据保留
  }
  return out;
}
