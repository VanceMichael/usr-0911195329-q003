// JSONL 追加事件日志：所有状态变更先落盘一条 JSON 再进入内存；启动时重放恢复。
// 单进程使用；写入按 append 串行化，末行截断（崩溃导致）按半条记录跳过。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createState, applyEvent } from "./domain.js";

export class EventStore {
  constructor(filePath, { clock = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.state = createState();
    this._writeChain = Promise.resolve();
    this._lastLine = 0; // 已安全落盘的行数
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const lines = raw.split("\n");
      let lineNo = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        lineNo += 1;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // 末行写坏（崩溃截断）：丢弃半条记录，之后从这里覆盖重写
          this._lastLine = lineNo - 1;
          await this._truncateToLastGoodLine(lines, lineNo - 1);
          return this.state;
        }
        applyEvent(this.state, event);
        this._lastLine = lineNo;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    }
    return this.state;
  }

  async _truncateToLastGoodLine(lines, goodCount) {
    const kept = [];
    let seen = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (seen >= goodCount) break;
      kept.push(line);
      seen += 1;
    }
    await fsp.writeFile(this.filePath, kept.length ? kept.join("\n") + "\n" : "");
  }

  // 命令式入口：producer 在内存态上产出 event（可能为 null=幂等回放），仅当产出事件时持久化。
  async commit(producer) {
    // 串行化提交，避免两个并发命令交错写日志。
    const run = this._writeChain.then(async () => {
      const meta = { at: this.clock() };
      const out = producer(meta);
      if (out?.event) {
        const line = JSON.stringify(out.event) + "\n";
        await fsp.appendFile(this.filePath, line);
        this._lastLine += 1;
      }
      return out;
    });
    this._writeChain = run.catch(() => {});
    return run;
  }

  // 测试/运维辅助：同步快照
  snapshot() {
    return this.state;
  }
}

export function openStoreSync(filePath, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const store = new EventStore(filePath, opts);
  return store;
}
