// 服务层：把 HTTP/脚本命令转为“在内存态执行 + 事件追加”的事务。
import {
  createSnapshot,
  sealSnapshot,
  registerQuote,
  registerContract,
  issueCalculation,
  queryFleet,
  redactContract,
  redactCalculation,
  normalizeRole,
} from "./domain.js";

export class Service {
  constructor(store) {
    this.store = store;
  }

  get state() {
    return this.store.state;
  }

  createSnapshot(cmd) {
    return this.store.commit((meta) => createSnapshot(this.state, cmd, meta));
  }

  sealSnapshot(cmd) {
    return this.store.commit((meta) => sealSnapshot(this.state, cmd, meta));
  }

  registerQuote(cmd) {
    return this.store.commit((meta) => registerQuote(this.state, cmd, meta));
  }

  registerContract(cmd) {
    return this.store.commit((meta) => registerContract(this.state, cmd, meta));
  }

  issueCalculation(cmd) {
    return this.store.commit((meta) => issueCalculation(this.state, cmd, meta));
  }

  queryFleet(cmd, role) {
    const r = normalizeRole(role);
    const res = queryFleet(this.state, cmd);
    res.calculations = res.calculations.map((c) => redactCalculation(c, r));
    return res;
  }

  listSnapshots() {
    return this.state.snapshotOrder.map((id) => this.state.snapshots.get(id));
  }

  getSnapshot(id) {
    return this.state.snapshots.get(id) ?? null;
  }

  listQuotes(snapshotId) {
    const ids = snapshotId
      ? this.state.snapshots.get(snapshotId)?.quoteIds ?? []
      : [...this.state.quotes.keys()];
    return ids.map((id) => this.state.quotes.get(id));
  }

  getContract(id, role) {
    const c = this.state.contracts.get(id);
    return c ? redactContract(c, role) : null;
  }

  listContracts(role) {
    return [...this.state.contracts.values()].map((c) => redactContract(c, role));
  }

  getCalculation(id, role) {
    const c = this.state.calculations.get(id);
    return c ? redactCalculation(c, role) : null;
  }
}
