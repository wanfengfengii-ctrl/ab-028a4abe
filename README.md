# buoy-telemetry-reorder

深海浮标遥测包**发送次序复原**服务。浮标回收后，工程师拿到的是乱序下载、且本地时间戳带误差的遥测包；本服务把“下载顺序”与“采集顺序”区分开，联合处理：

- 轮转计数器**跨周（modulus wrap-around）**后的绝对计数复原；
- **真实丢包**（相邻观测包之间缺失的绝对计数段）与单纯乱序的区分；
- 整数时间戳闭区间不确定性下的发送时刻联合选择。

## 问题模型

每个观测包 `i` 给出：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一包编号（调用方提供，1..64 个非控制字符） |
| `remainder` | 设备轮转计数器余数，`0 ≤ remainder < modulus` |
| `timeLower` / `timeUpper` | 整数发送时刻闭区间（含端点） |

服务为每个包联合选择：

- **绝对计数** `c_i ∈ [countMin, countMax]` 且 `c_i ≡ remainder_i (mod modulus)`，包间互异；
- **整数发送时刻** `t_i ∈ [timeLower_i, timeUpper_i]`。

复原后序列按绝对计数严格递增；相邻已观测包 `a → b`（计数差 `d = c_b − c_a ≥ 1`）必须满足：

```
d · minInterval ≤ t_b − t_a ≤ d · maxInterval
```

### 优化目标（字典序）

1. **首尾间缺包数最少**：`c_last − c_first + 1 − 包数`；
2. **总中点偏差最小**：`Σ |t_i − (timeLower_i + timeUpper_i)/2|`；
3. **包编号序列字典序最小**（完全平局时的稳定决胜）。

时刻为整数，而区间中点可能是半整数，因此总偏差允许为 `x.0 / x.5`。所有平局（同一目标值的多个时刻向量）按**最早的最优时刻向量**确定性打破。

### 算法

- 对“排列 × 绝对计数”做深度优先枚举；
- 沿每条部分链维护时间维度 DP：`dp(t)` = 末包恰在 `t` 发送时前缀的最小（二倍）中点偏差，转移用**单调队列滑动窗口最小值**，O(窗口宽) 精确求得该链最优时刻，无需枚举时刻；
- 缺包预算、前缀偏差下界、计数器空间、锚点时间可达域等剪枝；对 `(已用包集合, 末包, 末计数)` 的逐点支配状态做记忆化；
- 不可行时记录“延伸得最远”的死路（平局取字典序最小前缀）作为首个无法延伸的约束证据。

搜索规模受调用约束（见下方“输入限制”），求解在常规 6..14 包输入下为毫秒级。

## HTTP API

`POST /api/v1/recover`

请求体示例见 [`examples/sample.json`](examples/sample.json)（跨周 + 缺包样例）：

```json
{
  "modulus": 8,
  "countMin": 0,
  "countMax": 24,
  "minInterval": 9,
  "maxInterval": 11,
  "packets": [
    {"id": "D", "remainder": 7, "timeLower": 148, "timeUpper": 152},
    {"id": "A", "remainder": 6, "timeLower": 58,  "timeUpper": 62},
    {"id": "F", "remainder": 1, "timeLower": 168, "timeUpper": 172},
    {"id": "B", "remainder": 7, "timeLower": 68,  "timeUpper": 72},
    {"id": "C", "remainder": 2, "timeLower": 98,  "timeUpper": 103},
    {"id": "E", "remainder": 0, "timeLower": 157, "timeUpper": 161}
  ]
}
```

200 响应（节选）：

```json
{
  "order": ["A", "B", "C", "D", "E", "F"],
  "assignments": [
    {"position": 0, "id": "A", "count": 6,  "time": 60},
    {"position": 1, "id": "B", "count": 7,  "time": 70},
    {"position": 2, "id": "C", "count": 10, "time": 100},
    {"position": 3, "id": "D", "count": 15, "time": 150},
    {"position": 4, "id": "E", "count": 16, "time": 159},
    {"position": 5, "id": "F", "count": 17, "time": 170}
  ],
  "totalMissing": 6,
  "missingSpans": [
    {"fromCount": 8, "toCount": 9,  "missing": 2, "afterId": "B", "beforeId": "C"},
    {"fromCount": 11, "toCount": 14, "missing": 4, "afterId": "C", "beforeId": "D"}
  ],
  "adjacencyEvidence": [
    {"fromId": "A", "toId": "B", "fromCount": 6, "toCount": 7,
     "countDifference": 1, "fromTime": 60, "toTime": 70,
     "timeDifference": 10, "minTimeDifference": 9, "maxTimeDifference": 11,
     "effectiveInterval": "10/1 (=10)"}
  ],
  "totalMidpointDeviation": 0.5
}
```

- `order`：复原的发送次序（**不是**下载次序）；
- `assignments`：逐包绝对计数与选定整数时刻；
- `missingSpans` / `totalMissing`：真实缺失计数段与缺包总数；
- `adjacencyEvidence`：逐相邻对的计数差、时差及其允许范围、实际等效采样间隔（精确分数）。

### 错误响应（稳定业务错误码）

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 字段缺失/类型错、包数不在 6..14、id 重复、余数越界、区间倒置等 |
| 422 | `NO_CONSISTENT_INTERPRETATION` | 搜索窗内不存在任何整体一致的（计数, 时刻）解释 |

422 响应携带 `error.evidence`：`position`（无法延伸的位置）、`fromId` / `toId`、
机器可读 `reason`（如 `adjacency_interval_window`、`no_absolute_counter_above_predecessor`、
`time_window_too_early`、`time_window_too_late`、`packet_has_no_congruent_count_in_window`、
`accumulated_timing_constraints`、`insufficient_counter_room`、`search_limit_exceeded`）、
人类可读 `detail` 以及 `attemptedPrefix`。

### 其他端点

- `GET /healthz`（也接受 `/health`）：健康检查；
- `GET /`：服务与端点简介。

## 输入限制

| 项 | 限制 |
| --- | --- |
| 包数 | 6..14，`id` 唯一 |
| `modulus` | 整数 ≥ 2 |
| `countMax − countMin` | ≤ 400 |
| `timeUpper − timeLower`（单包） | ≤ 300 |
| `maxInterval` | ≤ 10⁹，`0 ≤ minInterval ≤ maxInterval` |
| 请求体 | ≤ 1 MB |

这些界限使穷举搜索有确定的时间/内存上界；越界输入返回 400 `INVALID_REQUEST`。
搜索另有 2×10⁷ 部分链的安全预算（可由环境变量 `REORDER_STATE_LIMIT` 覆盖），
耗尽时返回 422 且 `reason = search_limit_exceeded`。

## 本地运行（无 Docker）

需要 Node.js ≥ 22（零运行时依赖，仅 TypeScript 为开发依赖）。

```bash
npm install
npm run build
npm test
API_PORT=3000 npm start
```

## Docker 交付

`Dockerfile` 为多阶段构建：

1. `build`：安装依赖、`tsc` 构建，并在镜像构建期运行单元测试（测试失败则镜像构建失败）；
2. `runtime`：仅含编译产物、非 root 运行，内置 `HEALTHCHECK`（`src/healthcheck.ts`）；
3. `verify`：一次性校验镜像（含完整工具链与测试源码）。

### 启动 API（宿主机端口由 `API_PORT` 映射）

```bash
# 默认映射到宿主机 3000
docker compose up --build api

# 映射到宿主机 8080
API_PORT=8080 docker compose up --build api
```

容器内固定监听 3000，宿主机端口由 `API_PORT`（默认 3000）控制；
`API_PORT` 同时可作为环境变量改变容器内监听端口（见 `src/index.ts`）。

### 一次性 verify 服务

```bash
docker compose up --build --abort-on-container-exit verify
```

`verify` 服务通过 `depends_on: condition: service_healthy` 等待 API 健康后，依次：

1. 轮询 `GET /healthz` 直至健康；
2. 重新执行 TypeScript 构建（`npm run build`）；
3. 执行代码测试（`node --test`，含跨周缺包样例与对小规模穷举参考实现的 40 组随机等价校验）；
4. 以跨周含缺包样例执行 HTTP 冒烟（核对复原次序、绝对计数、时刻、缺失计数段、逐相邻证据）；
5. 校验 422 / 400 负路径及稳定错误码。

全部通过输出 `ALL VERIFICATION CHECKS PASSED` 并以退出码 0 自行结束；任一失败立即以非零退出码结束。

## 目录结构

```
src/
  index.ts        进程入口（API_PORT 绑定、信号处理）
  server.ts       HTTP 路由 / JSON 错误映射
  solver.ts       联合复原核心（DFS + 时间 DP + 滑动窗口最小值 + 记忆化/剪枝）
  validation.ts   请求校验（稳定 INVALID_REQUEST）
  types.ts        领域类型与 BusinessError
  healthcheck.ts  容器健康探针
test/
  solver.test.ts  单元/性质测试（55 项，含穷举交叉验证）
scripts/
  verify.mjs      一次性 verify 编排（健康等待 + 构建 + 测试 + HTTP 冒烟）
  fuzz.mjs        开发用：小规模穷举参考实现差分 fuzz（node scripts/fuzz.mjs [seed] [n]）
examples/
  sample.json     跨周 + 缺包样例
Dockerfile  docker-compose.yml  .dockerignore
```
