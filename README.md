# 成品油调价影响测算接口

这是一个面向业务系统的后端起始工程，提供健康检查接口和领域配置，业务代码按传输、领域与持久化职责组织。

## 运行

```bash
docker build -t fuel-impact . && docker run --rm -p 8080:8080 fuel-impact
```

服务启动后访问 `GET /health` 可确认进程状态。配置文件 `config/domain.json` 记录服务标识与接口约定；凭据和本地数据不应提交。
